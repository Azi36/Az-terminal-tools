//! 本地终端：在本机起一个 shell，走 PTY（Windows 是 ConPTY，macOS / Linux 是 forkpty）。
//!
//! 前端复用 SSH 那个 xterm 组件，只是命令名换成 `pty_*`、事件名换成 `pty://`，
//! 参数名故意跟 SSH 的一样（session_id），组件里不用分两套。
//!
//! 目录跟踪：shell 每次出提示符前吐一条 OSC 序列报当前目录，前端据此更新路径、刷新 git 面板。
//! PowerShell 用 OSC 9;9（Windows Terminal 的约定），bash 用 OSC 7。zsh 的 precmd 没法从环境变量
//! 注入，暂时不跟踪 —— 用户可以在面板里手动填目录。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use crate::ssh::SshError;

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    ptys: Mutex<HashMap<String, Pty>>,
}

impl PtyState {
    /// 关窗退出时把所有 shell 杀掉，别留一堆孤儿 PowerShell
    pub(crate) fn close_all(&self) {
        if let Ok(mut map) = self.ptys.lock() {
            for (_, mut one) in map.drain() {
                let _ = one.killer.kill();
            }
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    /// 实际起的是哪个 shell（完整路径或命令名）
    pub shell: String,
    /// 起在哪个目录
    pub cwd: String,
    /// 这个 shell 会不会上报目录（zsh 目前不会）
    pub tracks_cwd: bool,
}

/// 在 PATH 里找可执行文件
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 挑 shell：用户指定的优先；Windows 上先找 pwsh（7.x），没有再退到系统自带的 PowerShell；
/// 别的系统看 $SHELL，没有就 /bin/sh
fn pick_shell(wanted: Option<&str>) -> String {
    if let Some(one) = wanted.map(str::trim).filter(|s| !s.is_empty()) {
        return one.to_string();
    }
    if cfg!(windows) {
        if find_on_path("pwsh.exe").is_some() {
            return "pwsh.exe".into();
        }
        return "powershell.exe".into();
    }
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
}

fn shell_kind(shell: &str) -> &'static str {
    // 自己按 / 和 \ 切最后一段：Path::file_stem 在 macOS / Linux 上不认反斜杠，
    // 用户在设置里填的 Windows 路径会整串当成文件名（CI 的 macOS 测试就是这么挂的）
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell).trim().to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    match stem {
        "pwsh" | "powershell" => "powershell",
        "bash" => "bash",
        "zsh" => "zsh",
        "cmd" => "cmd",
        _ => "other",
    }
}

/// PowerShell 的目录上报：包一层 prompt，在用户自己的 prompt 前面吐 OSC 9;9;<路径>。
/// 走 -EncodedCommand（UTF-16LE 的 base64），省得跟命令行的引号规则纠缠；
/// -Command 是在 profile 加载之后跑的，所以 $function:prompt 已经是用户的那个（oh-my-posh 之类不受影响）。
fn powershell_bootstrap() -> String {
    let script = r#"$global:__azPrompt = $function:prompt
function global:prompt {
  $e = [char]27
  $p = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
  [Console]::Write("$e]9;9;$p$e\")
  if ($global:__azPrompt) { & $global:__azPrompt } else { "PS $p> " }
}"#;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    data_encoding::BASE64.encode(&utf16)
}

fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into())
}

/// 起一个本地 shell
#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    session_id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<PtyInfo, SshError> {
    // 检查和插入在同一把锁里：两次同 id 的 pty_open 并发进来时，后一次必须看到前一次
    // （否则各起一个 shell，前一次的 Pty 被覆盖、master 一关，它的 shell 就 0xC0000142 退出）。
    // 函数体里没有 await，锁跨整个函数没问题。
    let mut map = state.ptys.lock().map_err(|_| SshError::plain("终端表被锁住了"))?;
    if map.contains_key(&session_id) {
        return Err(SshError::plain("这个终端已经开着了"));
    }
    let shell = pick_shell(shell.as_deref());
    let kind = shell_kind(&shell);
    let cwd = cwd
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty() && std::path::Path::new(c).is_dir())
        .unwrap_or_else(home_dir);

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    cmd.env("AZTERM", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let tracks_cwd = match kind {
        "powershell" => {
            cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &powershell_bootstrap()]);
            true
        }
        "bash" => {
            // bash 会把环境里的 PROMPT_COMMAND 当自己的变量用；用户 .bashrc 里另设了的话这条就失效，那也只是不跟踪目录
            cmd.env("PROMPT_COMMAND", r#"printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD""#);
            true
        }
        _ => false,
    };

    let system = native_pty_system();
    let pair = system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| SshError::new("开不了伪终端", e))?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| SshError::new(&format!("起不了 {shell}，检查设置里的 shell 路径"), e))?;
    // slave 端交给子进程之后这边就不该再拿着
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| SshError::new("伪终端读不了", e))?;
    let writer = pair.master.take_writer().map_err(|e| SshError::new("伪终端写不了", e))?;
    let killer = child.clone_killer();

    // 读线程：shell 输出按 UTF-8 解码后推给前端。解码器有状态，一个汉字被拆在两次 read 里也不会吐问号。
    // ConPTY 的输出是 UTF-8；bash / zsh 跟随 locale，绝大多数机器也是 UTF-8。
    let reader_app = app.clone();
    let reader_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let want = decoder.max_utf8_buffer_length(n).unwrap_or(n * 4 + 4);
            let mut out = String::with_capacity(want);
            let _ = decoder.decode_to_string(&buf[..n], &mut out, false);
            if !out.is_empty() {
                let _ = reader_app.emit(&format!("pty://data/{reader_id}"), out);
            }
        }
    });

    // 等待线程：shell 退了就把这条从表里摘掉（master 随之关闭，读线程才会收到 EOF —— ConPTY 在
    // 子进程退出后不会自己给 EOF），然后把退出码告诉前端
    let wait_app = app.clone();
    let wait_id = session_id.clone();
    let mut child = child;
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        if let Some(state) = wait_app.try_state::<PtyState>() {
            if let Ok(mut map) = state.ptys.lock() {
                map.remove(&wait_id);
            }
        }
        let _ = wait_app.emit(&format!("pty://exit/{wait_id}"), code);
    });

    map.insert(session_id, Pty { master: pair.master, writer, killer });
    drop(map);

    Ok(PtyInfo { shell, cwd, tracks_cwd })
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, session_id: String, data: String) -> Result<(), String> {
    let mut map = state.ptys.lock().map_err(|_| "终端表被锁住了")?;
    let one = map.get_mut(&session_id).ok_or("这个终端已经关了")?;
    one.writer.write_all(data.as_bytes()).map_err(|e| format!("写不进终端：{e}"))?;
    let _ = one.writer.flush();
    Ok(())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, PtyState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.ptys.lock().map_err(|_| "终端表被锁住了")?;
    let one = map.get(&session_id).ok_or("这个终端已经关了")?;
    one.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("改不了终端尺寸：{e}"))
}

/// 关掉：杀 shell 进程；表里那条由等待线程在进程真退出后摘掉
#[tauri::command]
pub fn pty_close(state: tauri::State<'_, PtyState>, session_id: String) {
    if let Ok(mut map) = state.ptys.lock() {
        if let Some(one) = map.get_mut(&session_id) {
            let _ = one.killer.kill();
        }
    }
}

/// 设置页显示「自动」实际会挑到哪个
#[tauri::command]
pub fn pty_default_shell() -> String {
    pick_shell(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_kind_by_file_stem() {
        assert_eq!(shell_kind(r"C:\Program Files\PowerShell\7\pwsh.exe"), "powershell");
        assert_eq!(shell_kind("powershell.exe"), "powershell");
        assert_eq!(shell_kind("/bin/bash"), "bash");
        assert_eq!(shell_kind("/bin/zsh"), "zsh");
        assert_eq!(shell_kind("fish"), "other");
    }

    /// -EncodedCommand 要的是 UTF-16LE 的 base64：解回来必须还是那段脚本
    #[test]
    fn powershell_bootstrap_round_trips() {
        let b64 = powershell_bootstrap();
        let bytes = data_encoding::BASE64.decode(b64.as_bytes()).unwrap();
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let back = String::from_utf16(&units).unwrap();
        assert!(back.contains("function global:prompt"));
        assert!(back.contains("]9;9;"));
    }

    #[test]
    fn explicit_shell_wins() {
        assert_eq!(pick_shell(Some("  /usr/bin/fish ")), "/usr/bin/fish");
        assert!(!pick_shell(Some("")).is_empty());
    }
}
