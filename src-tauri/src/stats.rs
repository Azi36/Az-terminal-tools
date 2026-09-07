//! 服务器状态：概览（CPU / 内存 / 负载 / 磁盘 / 网卡）、进程、磁盘占用、端口与服务。
//!
//! 设计要点：
//! - **不要求服务器装任何东西**。全部走 `remote::exec` 读 `/proc` 和几个基础命令，
//!   跟人自己敲 `cat /proc/stat` 是一回事。
//! - **一轮只开一个通道**。概览要的七八样东西拼成一条命令一次取回；
//!   两秒一轮的话，开七个通道和开一个的差别在弱网上很明显。
//! - **Rust 侧不留状态**。CPU 占用和网卡速率都得靠前后两次的差值，
//!   这里只把计数器原样交出去，差值让前端算 —— 省得会话表里再挂一份采样历史。
//!
//! 只认 Linux。macOS / BSD 没有 `/proc`，硬凑 `sysctl` 出来的数半真半假，
//! 不如老实告诉用户「这个系统还看不了」。

use crate::remote::{exec, quote, ssh_of, QUICK, SLOW};
use crate::ssh::SshError;

/// 把输出按 `#az:标记` 切成几段。拼命令时每段前面 `echo` 一个标记，
/// 一次取回来的东西才分得清谁是谁。
fn sections(text: &str) -> std::collections::HashMap<&str, String> {
    let mut map = std::collections::HashMap::new();
    let mut key: Option<&str> = None;
    let mut buf = String::new();
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("#az:") {
            if let Some(previous) = key.take() {
                map.insert(previous, std::mem::take(&mut buf));
            }
            key = Some(name.trim());
            continue;
        }
        if key.is_some() {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if let Some(previous) = key {
        map.insert(previous, buf);
    }
    map
}

/// 取一段的第一行（`hostname`、`uname` 这种一行的）
fn first_line(map: &std::collections::HashMap<&str, String>, key: &str) -> String {
    map.get(key).and_then(|s| s.lines().next()).unwrap_or("").trim().to_string()
}

// ─────────────────────────── 探一次底 ───────────────────────────

/// 这台机器是什么、能不能看 —— 一条会话只用问一次
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// `uname -s` 的原话："Linux" / "Darwin" / "FreeBSD" …
    pub os: String,
    /// 能不能采（目前只有 Linux 能）
    pub supported: bool,
    /// 发行版名字，取不到就空着
    pub pretty_name: String,
    pub kernel: String,
    pub hostname: String,
    /// CPU 型号，ARM 上常常是空的
    pub cpu_model: String,
    /// 逻辑核数；拿不到给 0，前端就不按核折算负载了
    pub cores: u32,
}

#[tauri::command]
pub async fn stats_probe(app: tauri::AppHandle, session_id: String) -> Result<Probe, SshError> {
    let ssh = ssh_of(&app);
    let script = concat!(
        "echo '#az:os'; uname -s; ",
        "echo '#az:kernel'; uname -r; ",
        "echo '#az:host'; hostname; ",
        "echo '#az:release'; cat /etc/os-release 2>/dev/null; ",
        "echo '#az:cpu'; grep -m1 -E '^(model name|Model|Hardware)' /proc/cpuinfo 2>/dev/null; ",
        "echo '#az:cores'; grep -c '^cpu[0-9]' /proc/stat 2>/dev/null",
    );
    let text = exec(&ssh, &session_id, script, QUICK).await?;
    let map = sections(&text);

    let os = first_line(&map, "os");
    let pretty_name = map
        .get("release")
        .and_then(|block| {
            block
                .lines()
                .find_map(|line| line.strip_prefix("PRETTY_NAME="))
                .map(|value| value.trim().trim_matches('"').to_string())
        })
        .unwrap_or_default();
    let cpu_model = first_line(&map, "cpu")
        .split_once(':')
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_default();

    Ok(Probe {
        supported: os.eq_ignore_ascii_case("Linux"),
        os,
        pretty_name,
        kernel: first_line(&map, "kernel"),
        hostname: first_line(&map, "host"),
        cpu_model,
        cores: first_line(&map, "cores").parse().unwrap_or(0),
    })
}

// ─────────────────────────── 一轮采样 ───────────────────────────

/// CPU 时间计数器（累积值，单位 jiffies）。占用率要拿两次的差算。
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    /// "cpu" 是全机合计，"cpu0"、"cpu1"… 是各个核
    pub name: String,
    /// 各项时间之和
    pub total: u64,
    /// idle + iowait
    pub idle: u64,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mem {
    /// 以下全是 KiB
    pub total: u64,
    pub free: u64,
    /// 内核给的「真正还能用的」；老内核没有这一项，退回 free + buffers + cached
    pub available: u64,
    pub buffers: u64,
    pub cached: u64,
    pub swap_total: u64,
    pub swap_free: u64,
}

/// 网卡收发字节数（累积值，速率要拿两次的差算）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nic {
    pub name: String,
    pub rx: u64,
    pub tx: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    /// 设备名
    pub source: String,
    pub mount: String,
    /// 以下全是 KiB
    pub total: u64,
    pub used: u64,
    pub avail: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// 开机到现在的秒数
    pub uptime: f64,
    /// 1 / 5 / 15 分钟平均负载
    pub load: [f64; 3],
    /// 第一项是全机合计，后面是各个核
    pub cpus: Vec<Cpu>,
    pub mem: Mem,
    pub nics: Vec<Nic>,
    pub disks: Vec<Disk>,
    /// 此刻登录着几个会话（`who | wc -l`）
    pub sessions: u32,
}

/// `/proc/stat` 的一行 → 计数器
fn parse_cpu(line: &str) -> Option<Cpu> {
    let mut parts = line.split_whitespace();
    let name = parts.next()?.to_string();
    let values: Vec<u64> = parts.filter_map(|one| one.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    // 字段顺序：user nice system idle iowait irq softirq steal guest guest_nice
    // guest 那两项已经算进 user / nice 里了，再加一遍就重了，所以只取前八项。
    let total: u64 = values.iter().take(8).sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some(Cpu { name, total, idle })
}

/// `/proc/meminfo` 的 "MemTotal:  16316412 kB" → 16316412
fn parse_kb(line: &str) -> u64 {
    line.split_whitespace().nth(1).and_then(|one| one.parse().ok()).unwrap_or(0)
}

/// `/proc/net/dev` 整块 → 各网卡的收发字节数。
///
/// 前两行是表头。回环口不算「网络流量」，去掉 —— 不然本机进程之间聊两句
/// 就能把曲线顶到天上，看着像被打了。
fn parse_nics(block: &str) -> Vec<Nic> {
    block
        .lines()
        .skip(2)
        .filter_map(|line| {
            // 网卡名和数字之间是个冒号，而且名字长了会跟冒号贴在一起（"enp0s31f6:123"）
            let (name, rest) = line.split_once(':')?;
            let name = name.trim();
            if name.is_empty() || name == "lo" {
                return None;
            }
            let values: Vec<u64> = rest.split_whitespace().filter_map(|one| one.parse().ok()).collect();
            // 收 8 项、发 8 项，字节数分别是第 0 和第 8
            Some(Nic { name: name.to_string(), rx: *values.first()?, tx: *values.get(8)? })
        })
        .collect()
}

/// `df -Pk` 整块 → 各挂载点。
fn parse_disks(block: &str) -> Vec<Disk> {
    block
        .lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 6 {
                return None;
            }
            let source = cols[0];
            // tmpfs / devtmpfs / overlay / none 这些不是真盘，列出来只会碍事。
            // 判据用「设备名是不是一条路径」—— 比列黑名单扛得住各家发行版。
            if !source.starts_with('/') {
                return None;
            }
            // df -P 保证前五列固定，第六列往后整个都是挂载点
            // （挂载点里真带空格的话，按列取最后一个是拼不回来的）
            let mount = cols[5..].join(" ");
            Some(Disk {
                source: source.to_string(),
                total: cols[1].parse().ok()?,
                used: cols[2].parse().ok()?,
                avail: cols[3].parse().ok()?,
                mount,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn stats_sample(app: tauri::AppHandle, session_id: String) -> Result<Sample, SshError> {
    let ssh = ssh_of(&app);
    // 每核一行，取前 64 核；再多的机器上单核曲线也画不下，合计那一行照样是全的
    let script = concat!(
        "echo '#az:up'; cat /proc/uptime; ",
        "echo '#az:load'; cat /proc/loadavg; ",
        "echo '#az:cpu'; grep -E '^cpu' /proc/stat | head -n 65; ",
        "echo '#az:mem'; head -n 20 /proc/meminfo; ",
        "echo '#az:net'; cat /proc/net/dev; ",
        "echo '#az:df'; df -Pk; ",
        "echo '#az:who'; who | wc -l",
    );
    let text = exec(&ssh, &session_id, script, QUICK).await?;
    let map = sections(&text);

    if map.get("cpu").map(|block| block.trim().is_empty()).unwrap_or(true) {
        return Err(SshError::plain("这台机器没有 /proc/stat，状态面板看不了它"));
    }

    let uptime = map
        .get("up")
        .and_then(|block| block.split_whitespace().next())
        .and_then(|one| one.parse().ok())
        .unwrap_or(0.0);

    let mut load = [0.0f64; 3];
    if let Some(block) = map.get("load") {
        for (slot, value) in load.iter_mut().zip(block.split_whitespace()) {
            *slot = value.parse().unwrap_or(0.0);
        }
    }

    let cpus: Vec<Cpu> = map
        .get("cpu")
        .map(|block| block.lines().filter_map(parse_cpu).collect())
        .unwrap_or_default();

    let mut mem = Mem::default();
    if let Some(block) = map.get("mem") {
        for line in block.lines() {
            match line.split(':').next().unwrap_or("") {
                "MemTotal" => mem.total = parse_kb(line),
                "MemFree" => mem.free = parse_kb(line),
                "MemAvailable" => mem.available = parse_kb(line),
                "Buffers" => mem.buffers = parse_kb(line),
                "Cached" => mem.cached = parse_kb(line),
                "SwapTotal" => mem.swap_total = parse_kb(line),
                "SwapFree" => mem.swap_free = parse_kb(line),
                _ => {}
            }
        }
    }
    // 3.14 以前的内核没有 MemAvailable，用老办法估一个，总比显示 0 强
    if mem.available == 0 {
        mem.available = mem.free + mem.buffers + mem.cached;
    }

    Ok(Sample {
        uptime,
        load,
        cpus,
        mem,
        nics: map.get("net").map(|block| parse_nics(block)).unwrap_or_default(),
        disks: map.get("df").map(|block| parse_disks(block)).unwrap_or_default(),
        sessions: first_line(&map, "who").parse().unwrap_or(0),
    })
}

// ─────────────────────────── 进程 ───────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    /// CPU 百分比。注意 `ps` 给的是进程活到现在的平均值，不是这一瞬间的 ——
    /// 跟 top 对不上是正常的，界面上得说清楚。
    pub cpu: f64,
    pub mem: f64,
    /// 常驻内存 KiB
    pub rss: u64,
    /// 进程状态字母：R 跑着 · S 睡着 · D 不可中断 · Z 僵尸 …
    pub state: String,
    /// 完整命令行
    pub command: String,
}

/// `ps` 的一行 → 一条进程。前七列都不含空格，命令行整个是第八列。
fn parse_proc(line: &str) -> Option<Proc> {
    let mut rest = line.trim_start();
    let mut fields: Vec<&str> = Vec::with_capacity(7);
    for _ in 0..7 {
        let cut = rest.find(char::is_whitespace)?;
        fields.push(&rest[..cut]);
        rest = rest[cut..].trim_start();
    }
    Some(Proc {
        pid: fields[0].parse().ok()?,
        ppid: fields[1].parse().unwrap_or(0),
        user: fields[2].to_string(),
        cpu: fields[3].parse().unwrap_or(0.0),
        mem: fields[4].parse().unwrap_or(0.0),
        rss: fields[5].parse().unwrap_or(0),
        state: fields[6].to_string(),
        command: rest.trim_end().to_string(),
    })
}

#[tauri::command]
pub async fn stats_processes(app: tauri::AppHandle, session_id: String) -> Result<Vec<Proc>, SshError> {
    let ssh = ssh_of(&app);
    // 不用 `--sort=-pcpu`：那是 GNU procps 的花样，busybox 上直接报错。
    // 排序在 Rust 里做，反正整张表都拿回来了。
    let text = exec(&ssh, &session_id, "ps -eo pid,ppid,user,pcpu,pmem,rss,stat,args", QUICK).await?;

    let mut rows: Vec<Proc> = text.lines().skip(1).filter_map(parse_proc).collect();
    if rows.is_empty() {
        return Err(SshError::plain("这台机器的 ps 没给出能认的结果"));
    }
    rows.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    // 面板上没人翻到第 500 行，截一刀省得每次往前端搬一整张表
    rows.truncate(400);
    Ok(rows)
}

/// 允许发的信号。**只认这四个** —— 信号名是拼进命令行的，
/// 放开成任意字符串就等于开了一个注入口。
const SIGNALS: [&str; 4] = ["TERM", "KILL", "HUP", "INT"];

#[tauri::command]
pub async fn stats_kill(
    app: tauri::AppHandle,
    session_id: String,
    pid: u32,
    signal: String,
    sudo: bool,
) -> Result<(), SshError> {
    let signal = SIGNALS
        .iter()
        .find(|one| one.eq_ignore_ascii_case(&signal))
        .ok_or_else(|| SshError::plain("这个信号不在允许的名单里"))?;
    if pid <= 1 {
        return Err(SshError::plain("1 号进程动不得，这一下会把整台机器带走"));
    }

    let ssh = ssh_of(&app);
    // `sudo -n`：没配免密就当场失败。少了 -n 的话 sudo 会在那儿等着输密码，
    // 而这条通道后面没接终端，用户看不见提示，只会觉得「点了没反应」。
    let prefix = if sudo { "sudo -n " } else { "" };
    // stderr 这里要看，所以并进 stdout；成没成看 kill 自己的退出码
    let script = format!("{prefix}kill -{signal} {pid} 2>&1 && echo '#az:ok'");
    let text = exec(&ssh, &session_id, &script, QUICK).await?;

    if text.contains("#az:ok") {
        return Ok(());
    }
    let detail = text.replace("#az:ok", "");
    let detail = detail.trim();
    if detail.contains("password is required") || detail.contains("a terminal is required") {
        return Err(SshError::plain("这台机器的 sudo 要输密码，面板里代劳不了 —— 去终端页手动 kill"));
    }
    Err(SshError::new(
        "没杀掉",
        if detail.is_empty() { "kill 返回了非零退出码" } else { detail },
    ))
}

// ─────────────────────────── 监听端口 ───────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    /// tcp / tcp6 / udp / udp6
    pub proto: String,
    /// 绑在哪个地址上。`0.0.0.0` 和 `::` 是对外的，`127.0.0.1` 只有本机能连
    pub addr: String,
    pub port: u32,
    /// 占着它的进程名；看不到就空着
    pub process: String,
    /// 0 = 不知道（多半是没权限）
    pub pid: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ports {
    pub rows: Vec<Port>,
    /// 实际是谁给出的结果："ss" / "netstat"，都没有就空着
    pub tool: String,
    /// 一条都没看到进程名 —— 多半是没用 root 连，界面上得说一句，
    /// 不然用户会以为「这些端口没人占」
    pub blind: bool,
}

/// 从一行里把进程信息抠出来。两种写法都认：
/// - ss：`users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))`
/// - netstat：`1234/nginx: master`
fn parse_owner(line: &str) -> (String, u32) {
    if let Some(rest) = line.split_once("users:((").map(|(_, r)| r) {
        let name = rest.split('"').nth(1).unwrap_or("").to_string();
        let pid = rest
            .split_once("pid=")
            .and_then(|(_, tail)| tail.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|one| one.parse().ok())
            .unwrap_or(0);
        return (name, pid);
    }
    // netstat 把它放在最后一列，长这样：`1234/nginx: master`
    for token in line.split_whitespace().rev() {
        let Some((pid, name)) = token.split_once('/') else { continue };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        return (name.trim_end_matches(':').to_string(), pid);
    }
    (String::new(), 0)
}

/// `ss -lntup` / `netstat -lntup` 的一行 → 一个监听口。
///
/// 两个工具的列数不一样（netstat 的 udp 行还少一个 State 列），所以不按下标取，
/// 而是认「第一个带冒号的字段就是本地地址」—— 前面几列都是纯数字或纯字母。
fn parse_port(line: &str) -> Option<Port> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let proto = tokens.first()?.to_string();
    if !proto.starts_with("tcp") && !proto.starts_with("udp") {
        return None;
    }
    let local = tokens.iter().skip(1).find(|one| one.contains(':'))?;
    let (addr, port) = local.rsplit_once(':')?;
    // `*:*` 这种没绑住的行没什么可看的
    let port: u32 = port.parse().ok()?;
    let (process, pid) = parse_owner(line);
    Some(Port {
        proto,
        // ss 的 IPv6 写成 `[::]:80`，方括号是给人分辨冒号用的，存起来不必留
        addr: addr.trim_start_matches('[').trim_end_matches(']').to_string(),
        port,
        process,
        pid,
    })
}

#[tauri::command]
pub async fn stats_ports(app: tauri::AppHandle, session_id: String) -> Result<Ports, SshError> {
    let ssh = ssh_of(&app);
    // ss 是 iproute2 的，现在的机器上基本都有；没有就退回 netstat（net-tools）。
    // 两个都跑一遍是浪费，所以先探一下再决定。
    let script = concat!(
        "echo '#az:ss'; ss -lntup 2>/dev/null; ",
        "echo '#az:netstat'; command -v ss >/dev/null 2>&1 || netstat -lntup 2>/dev/null",
    );
    let text = exec(&ssh, &session_id, script, QUICK).await?;
    let map = sections(&text);

    let (tool, block) = match map.get("ss").filter(|one| !one.trim().is_empty()) {
        Some(block) => ("ss", block),
        None => match map.get("netstat").filter(|one| !one.trim().is_empty()) {
            Some(block) => ("netstat", block),
            None => return Err(SshError::plain("这台机器上 ss 和 netstat 都没有，看不了端口")),
        },
    };

    let mut rows: Vec<Port> = block.lines().filter_map(parse_port).collect();
    if rows.is_empty() {
        return Err(SshError::plain("没读到监听端口，这台机器的 ss / netstat 输出对不上"));
    }
    let blind = rows.iter().all(|one| one.pid == 0);
    rows.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.proto.cmp(&b.proto)));
    Ok(Ports { rows, tool: tool.to_string(), blind })
}

// ─────────────────────────── systemd 服务 ───────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    /// 带 `.service` 后缀的完整单元名
    pub unit: String,
    /// loaded / not-found / masked
    pub load: String,
    /// active / inactive / failed
    pub active: String,
    /// running / exited / dead / failed …
    pub sub: String,
    pub description: String,
}

/// `systemctl list-units` 的一行 → 一个单元。前四列不含空格，描述是剩下整段。
fn parse_service(line: &str) -> Option<Service> {
    // 出错的单元前面会挂一个 ●，--plain 不一定收得干净
    let mut rest = line.trim_start().trim_start_matches('●').trim_start();
    let mut fields: Vec<&str> = Vec::with_capacity(4);
    for _ in 0..4 {
        let cut = rest.find(char::is_whitespace)?;
        fields.push(&rest[..cut]);
        rest = rest[cut..].trim_start();
    }
    if !fields[0].ends_with(".service") {
        return None;
    }
    Some(Service {
        unit: fields[0].to_string(),
        load: fields[1].to_string(),
        active: fields[2].to_string(),
        sub: fields[3].to_string(),
        description: rest.trim_end().to_string(),
    })
}

#[tauri::command]
pub async fn stats_services(app: tauri::AppHandle, session_id: String) -> Result<Vec<Service>, SshError> {
    let ssh = ssh_of(&app);
    // --no-pager 是必须的：不加的话 systemctl 会去开 less，这条通道后面没有终端，
    // 它会一直等在那儿直到超时。
    let script = "systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null";
    let text = exec(&ssh, &session_id, script, QUICK).await?;

    let mut rows: Vec<Service> = text.lines().filter_map(parse_service).collect();
    if rows.is_empty() {
        return Err(SshError::plain("没读到 systemd 服务，这台机器可能不用 systemd"));
    }
    // 出问题的排最前，其余按名字 —— 打开这一页多半就是来找哪个挂了的
    rows.sort_by(|a, b| {
        let rank = |one: &Service| match one.active.as_str() {
            "failed" => 0,
            "activating" | "deactivating" => 1,
            "active" => 2,
            _ => 3,
        };
        rank(a).cmp(&rank(b)).then_with(|| a.unit.cmp(&b.unit))
    });
    rows.truncate(400);
    Ok(rows)
}

/// 允许对服务做的事。**只认这四个**，理由跟信号白名单一样。
const ACTIONS: [&str; 4] = ["start", "stop", "restart", "reload"];

#[tauri::command]
pub async fn stats_service_do(
    app: tauri::AppHandle,
    session_id: String,
    unit: String,
    action: String,
    sudo: bool,
) -> Result<(), SshError> {
    let action = ACTIONS
        .iter()
        .find(|one| one.eq_ignore_ascii_case(&action))
        .ok_or_else(|| SshError::plain("这个操作不在允许的名单里"))?;
    // 单元名是从服务器列出来的，但它要拼进命令行，还是自己再验一遍。
    // systemd 的合法单元名就这些字符，别的一律不放行。
    let unit = unit.trim();
    if !unit.ends_with(".service")
        || unit.len() > 128
        || !unit.chars().all(|c| c.is_ascii_alphanumeric() || "@._-\\:".contains(c))
    {
        return Err(SshError::plain("这个服务名看着不对，没往下发"));
    }

    let ssh = ssh_of(&app);
    let prefix = if sudo { "sudo -n " } else { "" };
    let script = format!("{prefix}systemctl {action} {} 2>&1 && echo '#az:ok'", quote(unit));
    let text = exec(&ssh, &session_id, &script, QUICK).await?;

    if text.contains("#az:ok") {
        return Ok(());
    }
    let detail = text.replace("#az:ok", "");
    let detail = detail.trim();
    if detail.contains("password is required") || detail.contains("a terminal is required") {
        return Err(SshError::plain("这台机器的 sudo 要输密码，面板里代劳不了 —— 去终端页手动做"));
    }
    if detail.contains("Interactive authentication required") {
        return Err(SshError::plain("polkit 要求交互式认证，面板里过不去 —— 去终端页手动做"));
    }
    Err(SshError::new(
        "没执行成功",
        if detail.is_empty() { "systemctl 返回了非零退出码" } else { detail },
    ))
}

// ─────────────────────────── 网络工具 ───────────────────────────

/// 目标只可能是主机名 / IP / IPv6。它要拼进命令行，quote 之外再验一遍字符集：
/// 多一道跟少一道的成本差不多，而这一道能挡住所有拿目标当注入口的花样。
fn safe_target(target: &str) -> Option<&str> {
    let target = target.trim();
    if target.is_empty() || target.len() > 253 {
        return None;
    }
    if !target.chars().all(|c| c.is_ascii_alphanumeric() || ".:-_[]".contains(c)) {
        return None;
    }
    Some(target)
}

/// 从服务器上探网络：ping / traceroute / DNS / 端口通不通。
///
/// 意义不在于「有个图形界面」——在于**这是从服务器那边看出去的**。
/// 本机 ping 得通不代表那台机器 ping 得通，排查内网可达性时差的就是这一步。
#[tauri::command]
pub async fn stats_net_probe(
    app: tauri::AppHandle,
    session_id: String,
    tool: String,
    target: String,
    port: Option<u16>,
) -> Result<String, SshError> {
    let target = safe_target(&target)
        .ok_or_else(|| SshError::plain("目标只能是主机名或 IP，别的字符没往下发"))?;
    let quoted = quote(target);

    // 每种工具在各家发行版上装的不一定是同一个，所以都给一条退路
    let (script, limit) = match tool.as_str() {
        // -c 4 别让它一直 ping；-W 2 单次超时，不然不通的目标要等很久
        "ping" => (format!("ping -c 4 -W 2 {quoted} 2>&1"), QUICK),
        // traceroute 常常没装，tracepath 是 iputils 自带的，多半在
        "traceroute" => (
            format!(
                "command -v traceroute >/dev/null 2>&1 && exec traceroute -w 2 -q 1 -m 20 {quoted} 2>&1;                  command -v tracepath >/dev/null 2>&1 && exec tracepath -m 20 {quoted} 2>&1;                  echo '这台机器上 traceroute 和 tracepath 都没有'"
            ),
            SLOW,
        ),
        // dig 属于 bind-utils / dnsutils，很多精简镜像没有；getent 是 libc 自带的
        "dns" => (
            format!(
                "command -v dig >/dev/null 2>&1 && exec dig +short +time=2 +tries=2 {quoted} 2>&1;                  command -v host >/dev/null 2>&1 && exec host -W 2 {quoted} 2>&1;                  getent hosts {quoted} 2>&1 || echo '解析不出来（dig / host 都没装，getent 也没结果）'"
            ),
            QUICK,
        ),
        "port" => {
            let port = port.ok_or_else(|| SshError::plain("要探哪个端口没说"))?;
            (
                // nc 的参数各家不一样，探不通时退回 bash 的 /dev/tcp，
                // 那个是内建的，只要有 bash 就一定在
                format!(
                    "if command -v nc >/dev/null 2>&1; then                        nc -z -w 3 -v {quoted} {port} 2>&1;                      else                        timeout 3 bash -c 'exec 3<>/dev/tcp/'{quoted}'/{port}' 2>&1                          && echo '通：{port} 开着' || echo '不通：连不上 {port}';                      fi"
                ),
                QUICK,
            )
        }
        _ => return Err(SshError::plain("不认识这个工具")),
    };

    let ssh = ssh_of(&app);
    let text = exec(&ssh, &session_id, &script, limit).await?;
    Ok(if text.trim().is_empty() { "（没有输出）".to_string() } else { text })
}

// ─────────────────────────── 容器 ───────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    /// 完整 id（64 位十六进制）；动作都拿它，不拿名字
    pub id: String,
    pub name: String,
    pub image: String,
    /// running / exited / created / paused …
    pub state: String,
    /// "Up 3 days" / "Exited (0) 2 hours ago" 这种人话
    pub status: String,
    /// "0.0.0.0:8080->80/tcp" 这种，没有就空着
    pub ports: String,
}

/// `docker ps` 的一行（我们自己指定的 tab 分隔格式）→ 一个容器
fn parse_container(line: &str) -> Option<Container> {
    // 至少要有一个 tab，而且第一列得像个容器 id：docker 的报错（permission denied、
    // command not found、Cannot connect to the Docker daemon）走的也是 stdout（2>&1），
    // 整行没有 tab，不能被当成一个 id 是整句报错的「容器」—— 那样下面的错误分类永远跑不到
    let (id, rest) = line.split_once('\t')?;
    let id = safe_container_id(id.trim())?.to_string();
    let mut cols = rest.split('\t');
    Some(Container {
        id,
        name: cols.next().unwrap_or("").trim().to_string(),
        image: cols.next().unwrap_or("").trim().to_string(),
        state: cols.next().unwrap_or("").trim().to_string(),
        status: cols.next().unwrap_or("").trim().to_string(),
        ports: cols.next().unwrap_or("").trim().to_string(),
    })
}

/// 容器 id 只可能是十六进制。它要拼进命令行，所以宁可自己再验一遍 ——
/// 名字里能有 `.` 和 `-`，验起来松，用 id 就没这个问题。
fn safe_container_id(id: &str) -> Option<&str> {
    let id = id.trim();
    if id.len() < 12 || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(id)
}

/// docker 常常要 root。`sudo -n` 的理由跟 kill 那儿一样：
/// 少了 -n 它会在一条没有终端的通道后面等着输密码，用户只看见「点了没反应」。
fn docker_prefix(sudo: bool) -> &'static str {
    if sudo {
        "sudo -n docker"
    } else {
        "docker"
    }
}

#[tauri::command]
pub async fn stats_docker(
    app: tauri::AppHandle,
    session_id: String,
    sudo: bool,
) -> Result<Vec<Container>, SshError> {
    let ssh = ssh_of(&app);
    // 自己指定 tab 分隔的格式，比解析 docker 那张按列对齐的表稳得多 ——
    // 那张表的列宽跟着内容变，镜像名一长就对不上了
    let script = format!(
        "{} ps -a --format '{{{{.ID}}}}\\t{{{{.Names}}}}\\t{{{{.Image}}}}\\t{{{{.State}}}}\\t{{{{.Status}}}}\\t{{{{.Ports}}}}' 2>&1",
        docker_prefix(sudo),
    );
    let text = exec(&ssh, &session_id, &script, QUICK).await?;

    let rows: Vec<Container> = text.lines().filter_map(parse_container).collect();
    if rows.is_empty() {
        let noise = text.trim();
        if noise.is_empty() {
            // docker 在、但一个容器都没有：这不是错误
            return Ok(Vec::new());
        }
        if noise.contains("command not found") || noise.contains("not found") {
            return Err(SshError::plain("这台机器上没有 docker"));
        }
        if noise.contains("permission denied") || noise.contains("Got permission denied") {
            return Err(SshError::plain("当前用户没权限用 docker —— 勾上「用 sudo」再试，或者把用户加进 docker 组"));
        }
        if noise.contains("password is required") || noise.contains("a terminal is required") {
            return Err(SshError::plain("这台机器的 sudo 要输密码，面板里代劳不了 —— 去终端页手动看"));
        }
        if noise.contains("Cannot connect to the Docker daemon") {
            return Err(SshError::plain("docker 在，但守护进程没跑起来"));
        }
        return Err(SshError::new("列不出容器", noise.lines().next().unwrap_or(noise)));
    }
    Ok(rows)
}

/// 允许对容器做的事。**只认这四个**，理由跟信号白名单一样。
const DOCKER_ACTIONS: [&str; 4] = ["start", "stop", "restart", "kill"];

#[tauri::command]
pub async fn stats_docker_do(
    app: tauri::AppHandle,
    session_id: String,
    id: String,
    action: String,
    sudo: bool,
) -> Result<(), SshError> {
    let action = DOCKER_ACTIONS
        .iter()
        .find(|one| one.eq_ignore_ascii_case(&action))
        .ok_or_else(|| SshError::plain("这个操作不在允许的名单里"))?;
    let id = safe_container_id(&id).ok_or_else(|| SshError::plain("容器 id 看着不对，没往下发"))?;

    let ssh = ssh_of(&app);
    let script = format!("{} {action} {} 2>&1 && echo '#az:ok'", docker_prefix(sudo), quote(id));
    let text = exec(&ssh, &session_id, &script, QUICK).await?;
    if text.contains("#az:ok") {
        return Ok(());
    }
    let detail = text.replace("#az:ok", "");
    let detail = detail.trim();
    Err(SshError::new(
        "没执行成功",
        if detail.is_empty() { "docker 返回了非零退出码" } else { detail },
    ))
}

#[tauri::command]
pub async fn stats_docker_logs(
    app: tauri::AppHandle,
    session_id: String,
    id: String,
    sudo: bool,
) -> Result<String, SshError> {
    let id = safe_container_id(&id).ok_or_else(|| SshError::plain("容器 id 看着不对，没往下发"))?;
    let ssh = ssh_of(&app);
    // --tail 是必须的：跑了几个月的容器，日志几个 G 是常事，不加就是把它整个拖回来
    let script = format!("{} logs --tail 300 --timestamps {} 2>&1", docker_prefix(sudo), quote(id));
    exec(&ssh, &session_id, &script, QUICK).await
}

// ─────────────────────────── 磁盘占用 ───────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuEntry {
    pub name: String,
    pub path: String,
    /// KiB
    pub size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuListing {
    pub path: String,
    pub parent: Option<String>,
    /// 这个目录整个占多少 KiB
    pub total: u64,
    /// 直接子目录，从大到小
    pub entries: Vec<DuEntry>,
    /// 有几个子目录没读进去（多半是没权限）。数字会因此偏小，界面上得说一声。
    pub skipped: u32,
}

fn parent_of(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(cut) => Some(trimmed[..cut].to_string()),
        None => None,
    }
}

#[tauri::command]
pub async fn stats_du(app: tauri::AppHandle, session_id: String, path: String) -> Result<DuListing, SshError> {
    let path = path.trim().trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    if !path.starts_with('/') {
        return Err(SshError::plain("要一条绝对路径"));
    }
    let ssh = ssh_of(&app);

    // `-x` 不跨文件系统：不加的话一进 / 就会连着 /proc、/sys、网络挂载一起爬，
    // 既慢，又把别的盘的数算到这个盘头上。
    // `-d 1` 只要直接子项；GNU / busybox / BSD 的 du 都认这个写法。
    // stderr 并进来一起收：读不动的目录会在这儿留一行，正好拿来数「漏了几个」，
    // 也省得为了拿错误信息把 du 跑第二遍（在 / 上那是实打实的两倍时间）。
    let script = format!("du -kx -d 1 -- {} 2>&1", quote(path));
    let text = exec(&ssh, &session_id, &script, SLOW).await?;

    let mut total = 0u64;
    let mut skipped = 0u32;
    let mut noise: Vec<&str> = Vec::new();
    let mut entries: Vec<DuEntry> = Vec::new();
    for line in text.lines() {
        // du 的正文一律是 "<KiB>\t<路径>"，对不上的都是 stderr 混进来的
        let parsed = line
            .split_once('\t')
            .and_then(|(size, item)| Some((size.trim().parse::<u64>().ok()?, item.trim_end())));
        let Some((size, item)) = parsed else {
            if !line.trim().is_empty() {
                skipped += 1;
                if noise.len() < 3 {
                    noise.push(line.trim());
                }
            }
            continue;
        };
        // du 把「这个目录自己」也列出来（通常是最后一行）。
        // 根目录单独对待：path 是 "/"，item 也是 "/"，trim 掉斜杠就成空串对不上了
        let itself = if path == "/" { item == "/" } else { item.trim_end_matches('/') == path };
        if itself {
            total = size;
            continue;
        }
        let name = item.rsplit('/').next().unwrap_or(item).to_string();
        entries.push(DuEntry { name, path: item.to_string(), size });
    }

    if entries.is_empty() && total == 0 {
        return Err(if noise.is_empty() {
            SshError::plain("这个目录量不出来，可能是没权限，也可能这台机器的 du 不认 -d")
        } else {
            SshError::new("这个目录量不出来", noise.join(" · "))
        });
    }

    entries.sort_by_key(|one| std::cmp::Reverse(one.size));
    Ok(DuListing { parent: parent_of(path), path: path.to_string(), total, entries, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_split_by_marker() {
        let map = sections("#az:a\n1\n2\n#az:b\n3\n");
        assert_eq!(map.get("a").map(String::as_str), Some("1\n2\n"));
        assert_eq!(map.get("b").map(String::as_str), Some("3\n"));
        // 第一个标记之前的东西（登录 banner 之类）不算进任何一段
        let noisy = sections("welcome to the jungle\n#az:a\n1\n");
        assert_eq!(noisy.len(), 1);
        assert_eq!(noisy.get("a").map(String::as_str), Some("1\n"));
    }

    #[test]
    fn cpu_line_adds_up() {
        let cpu = parse_cpu("cpu  100 20 30 400 50 0 10 0 0 0").unwrap();
        assert_eq!(cpu.name, "cpu");
        // 前八项之和，guest 那两项不重复计
        assert_eq!(cpu.total, 610);
        // idle + iowait
        assert_eq!(cpu.idle, 450);
        // 字段不够的行认不出来，别拿半截数据画曲线
        assert!(parse_cpu("cpu 1 2").is_none());
    }

    #[test]
    fn meminfo_takes_the_number() {
        assert_eq!(parse_kb("MemTotal:       16316412 kB"), 16316412);
        assert_eq!(parse_kb("坏行"), 0);
    }

    #[test]
    fn ps_line_keeps_the_whole_command() {
        let row = parse_proc("  1234  1 root  3.5  1.2  40960 Ssl  /usr/bin/python3 -m http.server 8080").unwrap();
        assert_eq!(row.pid, 1234);
        assert_eq!(row.user, "root");
        assert_eq!(row.rss, 40960);
        assert_eq!(row.state, "Ssl");
        // 命令行里的空格不能把它切碎
        assert_eq!(row.command, "/usr/bin/python3 -m http.server 8080");
        // 表头那一行列数够但 pid 不是数字，认不出来正好被滤掉
        assert!(parse_proc("PID PPID USER %CPU %MEM RSS STAT COMMAND").is_none());
    }

    #[test]
    fn net_dev_skips_the_loopback() {
        // 真机上抄下来的形状：表头两行，名字和冒号贴着，长名字那行连数字都贴上了
        let block = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo: 5842391   41230    0    0    0     0          0         0 5842391   41230
  eth0: 992316451  812344    0    0    0     0          0         0 71234567  402211
enp0s31f6:12345 67 0 0 0 0 0 0 890 12";
        let nics = parse_nics(block);
        assert_eq!(nics.len(), 2, "lo 不该出现在里面");
        assert_eq!(nics[0].name, "eth0");
        assert_eq!(nics[0].rx, 992316451);
        // 发送字节是第 9 个数字（收 8 项之后）
        assert_eq!(nics[0].tx, 71234567);
        assert_eq!(nics[1].name, "enp0s31f6");
        assert_eq!(nics[1].tx, 890);
    }

    #[test]
    fn df_keeps_real_disks_only() {
        let block = "\
Filesystem     1024-blocks     Used Available Capacity Mounted on
udev               8127544        0   8127544       0% /dev
tmpfs              1630584     2216   1628368       1% /run
/dev/vda1         41147472 18234112  20802448      47% /
/dev/vdb1        206292968 91274112 104533992      47% /data disk
overlay           41147472 18234112  20802448      47% /var/lib/docker/overlay2/x/merged
/dev/vda1         41147472 18234112  20802448      47% /var/snap";
        let disks = parse_disks(block);
        // udev / tmpfs / overlay 都被滤掉了
        assert_eq!(disks.len(), 3);
        assert_eq!(disks[0].mount, "/");
        assert_eq!(disks[0].total, 41147472);
        assert_eq!(disks[0].used, 18234112);
        assert_eq!(disks[0].avail, 20802448);
        // 挂载点里带空格的照样拼得回来
        assert_eq!(disks[1].mount, "/data disk");
        assert_eq!(disks[2].source, "/dev/vda1");
    }

    #[test]
    fn reads_ss_and_netstat_alike() {
        // ss 的形状：Netid State Recv-Q Send-Q Local Peer Process
        let one = parse_port(
            r#"tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*     users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))"#,
        )
        .unwrap();
        assert_eq!(one.port, 80);
        assert_eq!(one.addr, "0.0.0.0");
        assert_eq!(one.process, "nginx");
        assert_eq!(one.pid, 1234);

        // IPv6 的方括号要脱掉，不然地址栏里是 [::]
        let six = parse_port(r#"tcp   LISTEN 0      4096            [::]:22           [::]:*    users:(("sshd",pid=901,fd=4))"#).unwrap();
        assert_eq!(six.addr, "::");
        assert_eq!(six.port, 22);

        // netstat 的 tcp 行多一个 State 列、进程写在最后
        let net = parse_port("tcp        0      0 127.0.0.1:6379          0.0.0.0:*               LISTEN      777/redis-server").unwrap();
        assert_eq!(net.addr, "127.0.0.1");
        assert_eq!(net.port, 6379);
        assert_eq!(net.process, "redis-server");
        assert_eq!(net.pid, 777);

        // netstat 的 udp 行少一个 State 列 —— 按下标取就会在这儿翻车
        let udp = parse_port("udp        0      0 0.0.0.0:68              0.0.0.0:*                           890/dhclient").unwrap();
        assert_eq!(udp.proto, "udp");
        assert_eq!(udp.port, 68);
        assert_eq!(udp.pid, 890);

        // 没权限时 ss 不给进程列，别因此把整行丢掉
        let blind = parse_port("tcp   LISTEN 0      128          0.0.0.0:111       0.0.0.0:*").unwrap();
        assert_eq!(blind.port, 111);
        assert_eq!(blind.pid, 0);
        assert_eq!(blind.process, "");

        // 表头和空行认不出来，正好被滤掉
        assert!(parse_port("Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port").is_none());
        assert!(parse_port("Active Internet connections (only servers)").is_none());
    }

    #[test]
    fn service_line_keeps_the_description() {
        let one = parse_service("  nginx.service loaded active running A high performance web server").unwrap();
        assert_eq!(one.unit, "nginx.service");
        assert_eq!(one.load, "loaded");
        assert_eq!(one.active, "active");
        assert_eq!(one.sub, "running");
        assert_eq!(one.description, "A high performance web server");

        // 出错的单元前面挂着 ●，--plain 不一定收得干净
        let bad = parse_service("● mysql.service loaded failed failed MySQL Community Server").unwrap();
        assert_eq!(bad.unit, "mysql.service");
        assert_eq!(bad.active, "failed");

        // 不是 .service 的（.mount / .socket）不收
        assert!(parse_service("tmp.mount loaded active mounted Temporary Directory").is_none());
    }

    #[test]
    fn docker_line_splits_on_tabs() {
        let one = parse_container(
            "9f2c1ab34de5f6789012345678901234567890123456789012345678901234\tweb\tnginx:1.25-alpine\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp, :::8080->80/tcp",
        )
        .unwrap();
        assert_eq!(one.name, "web");
        assert_eq!(one.image, "nginx:1.25-alpine");
        assert_eq!(one.state, "running");
        assert_eq!(one.status, "Up 3 days");
        // 端口那一列里有逗号和空格，按 tab 切才不会被拆碎
        assert!(one.ports.contains("8080->80/tcp"));
        // 没有端口映射的容器，最后一列是空的，不该因此把整行丢掉
        let bare = parse_container("aabbccddeeff112233\tjob\tbusybox\texited\tExited (0) 2 hours ago\t").unwrap();
        assert_eq!(bare.state, "exited");
        assert_eq!(bare.ports, "");
        // 报错那种行没有 tab、第一列也不是十六进制 id —— 必须返回 None，交给上面那段当错误处理
        assert!(parse_container("").is_none());
        assert!(parse_container("bash: docker: command not found").is_none());
        assert!(parse_container("Got permission denied while trying to connect to the Docker daemon socket").is_none());
        assert!(parse_container("sudo: a password is required").is_none());
    }

    #[test]
    fn container_id_must_be_hex() {
        let good = "9f2c1ab34de5";
        assert_eq!(safe_container_id(good), Some(good));
        // 这些都是拼进命令行会出事的
        assert!(safe_container_id("web; rm -rf /").is_none());
        assert!(safe_container_id("my-container").is_none());
        assert!(safe_container_id("9f2c").is_none());
    }

    #[test]
    fn net_target_rejects_anything_shell_ish() {
        assert_eq!(safe_target("example.com"), Some("example.com"));
        assert_eq!(safe_target(" 10.0.0.1 "), Some("10.0.0.1"));
        assert_eq!(safe_target("[fe80::1]"), Some("[fe80::1]"));
        // 这些都是拿目标当注入口的花样
        assert!(safe_target("a.com; rm -rf /").is_none());
        assert!(safe_target("$(id)").is_none());
        assert!(safe_target("a.com && curl evil").is_none());
        assert!(safe_target("").is_none());
    }

    #[test]
    fn parent_walks_up_to_root() {
        assert_eq!(parent_of("/var/log/nginx").as_deref(), Some("/var/log"));
        assert_eq!(parent_of("/var").as_deref(), Some("/"));
        assert_eq!(parent_of("/"), None);
    }
}
