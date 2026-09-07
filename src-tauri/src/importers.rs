//! 从别的 SSH 工具的导出文件里认出服务器。
//!
//! 三种格式，都只认「主机 / 端口 / 用户名」这三样，别的一概不碰：
//! - **Xshell** 的 `.xsh`：INI，`Host=` / `Port=` / `UserName=`
//! - **PuTTY** 的 `.reg`：注册表导出，每个会话一个 `[...\Sessions\名字]` 段
//! - **Termius / 通用 JSON**：在整棵树里找带 host 字段的对象
//!
//! **密码一概不认。** 这几家的密码都是用它们自己的密钥加密的，
//! 解得开也不该解 —— 从别人的工具里把口令搬出来，这个动作本身就不对劲。
//! 导进来的连接第一次连的时候自己输一次。
//!
//! 解析一律**宽进**：认不出来的字段留空、认不出来的段跳过，
//! 而不是整份文件报错。各家的导出格式版本之间会变，能捞多少是多少，
//! 捞不全也比「这个文件打不开」强 —— 界面上会让用户过一眼再决定导哪些。

use encoding_rs::{GBK, UTF_16LE, UTF_8};

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// 会话名；没有就拿主机名顶上
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 从哪种文件认出来的："xshell" / "putty" / "json"
    pub source: &'static str,
}

/// 字节 → 文本。
///
/// PuTTY 导出的 `.reg` 默认是 UTF-16LE 带 BOM，直接按 UTF-8 读会得到一堆 NUL；
/// Xshell 的 `.xsh` 在中文 Windows 上又常常是 GBK。所以这儿得自己认一下，
/// 不能假设都是 UTF-8。
fn to_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE.decode(&bytes[2..]).0.into_owned();
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return UTF_8.decode(&bytes[3..]).0.into_owned();
    }
    let (text, _, bad) = UTF_8.decode(bytes);
    if !bad {
        return text.into_owned();
    }
    // UTF-8 解不干净，多半是中文 Windows 上的 GBK
    GBK.decode(bytes).0.into_owned()
}

fn clean_port(raw: &str) -> u16 {
    raw.trim().parse().ok().filter(|one| *one > 0).unwrap_or(22)
}

/// Xshell 的 `.xsh`：INI。
///
/// 不管在哪个段里，只要出现 `Host=` / `Port=` / `UserName=` 就收 —— 各版本
/// 的段名不一样（`[CONNECTION]` / `[CONNECTION:AUTHENTICATION]` …），
/// 按段名找反而更容易在下一个版本里失灵。一个文件就是一台机器。
fn parse_xshell(text: &str, fallback_name: &str) -> Option<Found> {
    let mut host = String::new();
    let mut port = 22u16;
    let mut username = String::new();
    let mut name = String::new();

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "host" => host = value.to_string(),
            "port" => port = clean_port(value),
            "username" | "user" => username = value.to_string(),
            "description" | "sessionname" => name = value.to_string(),
            _ => {}
        }
    }
    if host.is_empty() {
        return None;
    }
    Some(Found {
        name: if name.is_empty() { fallback_name.to_string() } else { name },
        host,
        port,
        username,
        source: "xshell",
    })
}

/// PuTTY 的注册表导出：每个 `[...\Sessions\名字]` 段一台机器。
///
/// 段名里的会话名是 URL 转义过的（空格是 `%20`），值有两种：
/// 字符串 `"HostName"="1.2.3.4"`，数字 `"PortNumber"=dword:00000016`（十六进制）。
fn parse_putty(text: &str) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    let mut name = String::new();
    let mut host = String::new();
    let mut port = 22u16;
    let mut username = String::new();

    let flush = |name: &mut String, host: &mut String, port: &mut u16, username: &mut String, out: &mut Vec<Found>| {
        if !host.is_empty() {
            out.push(Found {
                name: if name.is_empty() { host.clone() } else { name.clone() },
                host: std::mem::take(host),
                port: *port,
                username: std::mem::take(username),
                source: "putty",
            });
        }
        name.clear();
        *port = 22;
        host.clear();
        username.clear();
    };

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // 新的一段开始了，先把上一段收了
            flush(&mut name, &mut host, &mut port, &mut username, &mut out);
            if let Some(tail) = line.trim_end_matches(']').rsplit("\\Sessions\\").next() {
                if tail != line.trim_end_matches(']') {
                    name = unescape_percent(tail);
                }
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().trim_matches('"').to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "hostname" => host = value.trim_matches('"').to_string(),
            "username" => username = value.trim_matches('"').to_string(),
            "portnumber" => {
                // dword:00000016 是十六进制
                if let Some(hex) = value.strip_prefix("dword:") {
                    port = u16::from_str_radix(hex.trim(), 16).ok().filter(|one| *one > 0).unwrap_or(22);
                } else {
                    port = clean_port(value.trim_matches('"'));
                }
            }
            _ => {}
        }
    }
    flush(&mut name, &mut host, &mut port, &mut username, &mut out);
    out
}

/// `%20` 这类还原成原字符。PuTTY 的段名里空格就是这么写的。
fn unescape_percent(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // 只有后面两个字节都是 ASCII 十六进制才切：`%折` 这种 `%` 后面跟多字节字符，
        // 按字节切 str 会落在字符中间直接 panic —— 手改过的 .reg 一选就崩
        if bytes[i] == b'%' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 通用 JSON（Termius 的导出、还有一堆工具的自定义格式）。
///
/// 各家的层级完全不一样，按固定路径取必然只对一家。所以整棵树走一遍，
/// 凡是「带 host 字段的对象」就收 —— 这个特征所有格式都成立。
fn parse_json(value: &serde_json::Value, out: &mut Vec<Found>) {
    match value {
        serde_json::Value::Array(items) => {
            for one in items {
                parse_json(one, out);
            }
        }
        serde_json::Value::Object(map) => {
            let pick = |keys: &[&str]| -> Option<String> {
                for key in keys {
                    if let Some(serde_json::Value::String(text)) = map.get(*key) {
                        if !text.trim().is_empty() {
                            return Some(text.trim().to_string());
                        }
                    }
                }
                None
            };
            if let Some(host) = pick(&["host", "hostname", "address", "ip"]) {
                let port = map
                    .get("port")
                    .and_then(|one| one.as_u64().or_else(|| one.as_str().and_then(|s| s.parse().ok())))
                    .filter(|one| *one > 0 && *one < 65536)
                    .unwrap_or(22) as u16;
                out.push(Found {
                    name: pick(&["label", "name", "title", "alias"]).unwrap_or_else(|| host.clone()),
                    host,
                    port,
                    username: pick(&["username", "user", "login"]).unwrap_or_default(),
                    source: "json",
                });
            }
            // 带 host 的对象里面还可能嵌着别的（分组套分组），照样往下走
            for one in map.values() {
                parse_json(one, out);
            }
        }
        _ => {}
    }
}

/// 挑几个文件，把里面认得出的服务器都捞出来。
///
/// 认不出来的文件跳过，不让一个坏文件把整批毁掉。
#[tauri::command]
pub fn import_scan(paths: Vec<String>) -> Result<Vec<Found>, String> {
    let mut out: Vec<Found> = Vec::new();
    for path in paths {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        // 几家的导出文件都是几 KB 的量级，几十 MB 的那多半选错了
        if bytes.len() > 8 * 1024 * 1024 {
            continue;
        }
        let text = to_text(&bytes);
        let lower = path.to_ascii_lowercase();
        let stem = std::path::Path::new(&path)
            .file_stem()
            .map(|one| one.to_string_lossy().to_string())
            .unwrap_or_default();

        if lower.ends_with(".xsh") {
            if let Some(one) = parse_xshell(&text, &stem) {
                out.push(one);
            }
        } else if lower.ends_with(".reg") {
            out.extend(parse_putty(&text));
        } else if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            parse_json(&value, &mut out);
        } else if let Some(one) = parse_xshell(&text, &stem) {
            // 扩展名对不上但内容是 INI 的（有人会把 .xsh 改名）
            out.push(one);
        }
    }

    // 同一台机器在几个文件里各出现一次是常事，去重
    out.sort_by(|a, b| (&a.host, a.port, &a.username).cmp(&(&b.host, b.port, &b.username)));
    out.dedup_by(|a, b| a.host == b.host && a.port == b.port && a.username == b.username);
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_unescape_survives_multibyte_after_percent() {
        use super::unescape_percent;
        // `%` 后面紧跟汉字：不能 panic，原样留着
        assert_eq!(unescape_percent("50%折扣"), "50%折扣");
        assert_eq!(unescape_percent("a%"), "a%");
        // 正常的 PuTTY 转义照常还原
        assert_eq!(unescape_percent("%E4%B8%AD%20x"), "中 x");
    }

    use super::*;

    #[test]
    fn reads_an_xshell_session() {
        let text = "[SessionInfo]\nVersion=5.0\nDescription=京东云 web01\n\n\
                    [CONNECTION]\nProtocol=SSH\nHost=10.0.0.12\nPort=2222\n\n\
                    [CONNECTION:AUTHENTICATION]\nMethod=Password\nUserName=deploy\nPassword=xxxxxx\n";
        let one = parse_xshell(text, "文件名").unwrap();
        assert_eq!(one.host, "10.0.0.12");
        assert_eq!(one.port, 2222);
        assert_eq!(one.username, "deploy");
        assert_eq!(one.name, "京东云 web01");
        // 没有 Host 的文件认不出来，别造一条空连接出来
        assert!(parse_xshell("[SessionInfo]\nVersion=5.0\n", "x").is_none());
        // 没写 Description 就拿文件名顶上；端口缺省 22
        let bare = parse_xshell("Host=1.2.3.4\n", "my-box").unwrap();
        assert_eq!(bare.name, "my-box");
        assert_eq!(bare.port, 22);
    }

    #[test]
    fn reads_a_putty_reg_export() {
        let text = "Windows Registry Editor Version 5.00\r\n\r\n\
            [HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\prod%20web]\r\n\
            \"HostName\"=\"10.0.0.12\"\r\n\"PortNumber\"=dword:00000016\r\n\"UserName\"=\"root\"\r\n\
            \"Protocol\"=\"ssh\"\r\n\r\n\
            [HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\db]\r\n\
            \"HostName\"=\"10.0.0.31\"\r\n\"PortNumber\"=dword:00002233\r\n\"UserName\"=\"mysql\"\r\n";
        let rows = parse_putty(text);
        assert_eq!(rows.len(), 2);
        // 段名里的 %20 要还原成空格
        assert_eq!(rows[0].name, "prod web");
        assert_eq!(rows[0].host, "10.0.0.12");
        // dword 是十六进制：16 → 22
        assert_eq!(rows[0].port, 22);
        assert_eq!(rows[1].port, 0x2233);
        assert_eq!(rows[1].username, "mysql");
        // 最后一段没有空行收尾，也得被收进来 —— 这是最容易漏的一条
        assert_eq!(rows[1].host, "10.0.0.31");
    }

    #[test]
    fn digs_hosts_out_of_any_json_shape() {
        let raw = r#"{
          "groups": [
            { "label": "生产", "hosts": [
              { "label": "web01", "address": "10.0.0.12", "port": 22, "username": "root" },
              { "label": "api", "hostname": "10.0.0.13", "port": "8022", "user": "deploy" }
            ]}
          ],
          "identities": [{ "username": "root" }]
        }"#;
        let mut out = Vec::new();
        parse_json(&serde_json::from_str(raw).unwrap(), &mut out);
        assert_eq!(out.len(), 2, "只有带 host 字段的对象算数，identities 那种不算");
        assert_eq!(out[0].name, "web01");
        assert_eq!(out[0].host, "10.0.0.12");
        // 端口是字符串写的也认
        assert_eq!(out[1].port, 8022);
        assert_eq!(out[1].username, "deploy");
    }

    #[test]
    fn decodes_utf16_and_gbk() {
        // PuTTY 的 .reg 默认是 UTF-16LE 带 BOM
        let mut utf16 = vec![0xFF, 0xFE];
        for ch in "Host=1.2.3.4".encode_utf16() {
            utf16.extend_from_slice(&ch.to_le_bytes());
        }
        assert_eq!(to_text(&utf16), "Host=1.2.3.4");
        // 中文 Windows 上的 GBK
        let (gbk, _, _) = GBK.encode("Description=生产库");
        assert_eq!(to_text(&gbk), "Description=生产库");
        // 正常 UTF-8 原样
        assert_eq!(to_text("Host=中文".as_bytes()), "Host=中文");
    }

    #[test]
    fn percent_unescape() {
        assert_eq!(unescape_percent("prod%20web"), "prod web");
        assert_eq!(unescape_percent("plain"), "plain");
        // 坏的转义原样留着，别把整个名字弄没
        assert_eq!(unescape_percent("a%zz"), "a%zz");
    }
}
