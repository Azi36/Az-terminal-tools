//! SSH 引擎：russh 连接 + PTY + shell，双向流转发到前端。
//!
//! 安全说明：
//! - 凭据（密码 / 私钥）仅在内存中流转，不落盘、不写日志。
//! - 主机公钥对着 `~/.ssh/known_hosts` 校验；用户点「信任」时会把他核对过的那串指纹
//!   带回来比对，服务器临时换一把钥匙糊弄不过去。
//! - 引擎只负责连接与字节流转发，不预置、不注入任何命令。
//!
//! 认证支持三条路：公钥、密码、键盘交互（keyboard-interactive）。
//! 键盘交互是很多服务器唯一开着的那条（`PasswordAuthentication no` +
//! `KbdInteractiveAuthentication yes`），也是 2FA / OTP 的走法：
//! 服务器问一句、用户答一句，答不上来的就把问题交给前端弹窗，
//! 半路的连接先寄存在 `pending` 里，等前端把答案送回来再接着走。
//!
//! 架构：russh 的 Channel 不能跨任务共享读写，所以由一个后台任务独占 Channel，
//! 前端的写入 / 改窗口 指令经 mpsc 通道送进该任务执行；服务器输出经 Tauri 事件推出。

use std::collections::HashMap;
use std::sync::Arc;

use russh::client::{self, Handler, KeyboardInteractiveAuthResponse};
use russh::keys::*;
use russh::ChannelMsg;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

/// 主机公钥没过校验时随错误一起交给前端，前端弹窗给用户看指纹
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    /// "unknown" 头一回见 · "changed" 指纹变了
    pub kind: String,
    pub algo: String,
    pub fingerprint: String,
}

/// 服务器在键盘交互里问的一组问题（2FA 验证码、改密码之类）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompts {
    /// 服务器给这组问题起的标题，常常是空的
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<AuthPrompt>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompt {
    pub prompt: String,
    /// true = 输入要显示出来（验证码），false = 遮起来（密码）
    pub echo: bool,
}

/// 结构化错误：中文提示 + 原始细节（远端/底层返回的英文，作为小字保留）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshError {
    message: String,
    detail: Option<String>,
    /// 只有主机指纹这一类错误会带上
    #[serde(skip_serializing_if = "Option::is_none")]
    host_key: Option<HostKeyInfo>,
    /// 只有「服务器还要问几句」这一类会带上
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<AuthPrompts>,
}

impl SshError {
    pub(crate) fn new(message: &str, detail: impl std::fmt::Display) -> Self {
        Self { message: message.into(), detail: Some(detail.to_string()), host_key: None, auth: None }
    }
    pub(crate) fn plain(message: &str) -> Self {
        Self { message: message.into(), detail: None, host_key: None, auth: None }
    }
    fn host_key(report: KeyReport) -> Self {
        let changed = report.kind == "changed";
        Self {
            message: if changed {
                "这台服务器的指纹变了！可能是重装了系统，也可能有人在中间".into()
            } else {
                "第一次连这台，先核对指纹".into()
            },
            detail: Some(format!("{} · {}", report.algo, report.fingerprint)),
            host_key: Some(HostKeyInfo {
                kind: report.kind,
                algo: report.algo,
                fingerprint: report.fingerprint,
            }),
            auth: None,
        }
    }
    /// 文件在我们读进来之后被别人改过 —— 存下去就把人家的改动盖了
    pub(crate) fn stale(now: u64) -> Self {
        Self {
            message: "这个文件在服务器上被改过了".into(),
            detail: Some(format!("stale:{now}")),
            host_key: None,
            auth: None,
        }
    }
    /// 服务器还要问几句才放行
    fn asks(prompts: AuthPrompts) -> Self {
        Self {
            message: "服务器还要问你几句".into(),
            detail: None,
            host_key: None,
            auth: Some(prompts),
        }
    }
}

/// 会话日志的出口：开着就是一个写文件任务的入口，关着就是 None
type LogSink = Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<String>>>>;

/// 把终端控制序列剥掉，留下人能读的正文。
///
/// 日志是拿来事后翻和 grep 的，留着满屏的 `\x1b[0m` 没法看。
/// 认三类：CSI（`ESC [ … 字母`）、OSC（`ESC ] … BEL/ST`，改标题那种）、
/// 以及其它两字节的 ESC 序列。
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            // 回车单独出现时是「回到行首」，日志里留着会让整行看起来被吃掉
            if ch != '\r' {
                out.push(ch);
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                // CSI：参数字节之后第一个 @~ 区间的字符是结束符
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC：一直到 BEL 或者 ESC \ 为止
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            // 剩下的都是两字节序列，第二个字节已经吃掉了
            _ => {}
        }
    }
    out
}

/// 前端 → 会话任务 的指令
enum Cmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// 远程转发登记表：服务器那边的 (bind 地址, 端口) → 本机要落到哪儿。
/// ClientHandler 收到服务器推过来的连接时照着它找目的地。
pub(crate) type Forwards = Arc<std::sync::Mutex<HashMap<(String, u32), (String, u16)>>>;

/// 一条活着的 SSH 连接：终端指令通道 + 连接句柄（SFTP 复用同一条连接开子通道）
struct Session {
    tx: mpsc::UnboundedSender<Cmd>,
    /// 加锁是因为 russh 的 `tcpip_forward`（远程转发）要 `&mut`；
    /// 开通道这些 `&self` 的活儿只借一下就还，锁不会握着不放
    handle: Arc<Mutex<client::Handle<ClientHandler>>>,
    /// 这条会话的字符编码，收发两头共用一份；用户中途改了这里跟着变
    encoding: Arc<std::sync::Mutex<&'static encoding_rs::Encoding>>,
    /// 会话日志：开着的话，服务器输出顺手往这儿抄一份
    log: LogSink,
    /// 远程转发的登记表，和 ClientHandler 共用一份
    forwards: Forwards,
    /// 跳板机那条连接：留着不动，它一断目标也就没了
    #[allow(dead_code)]
    jump: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
}

/// 认证走到一半、正等用户回答问题的连接
struct Pending {
    handle: client::Handle<ClientHandler>,
    params: ConnectParams,
    /// 这条连接一开始用的密码 / 密码短语；只有它值得进钥匙串，验证码不存
    secret: Option<String>,
    /// 密码已经答过一次了，后面的问题都得问用户
    secret_used: bool,
    forwards: Forwards,
    jump: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
}

/// 全局会话表：session_id -> 会话
#[derive(Default, Clone)]
pub struct SshState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// 认证没走完、寄存在这儿的半截连接
    pending: Arc<Mutex<HashMap<String, Pending>>>,
}

impl SshState {
    /// 供 SFTP / 隧道模块取用同一条 SSH 连接
    pub(crate) async fn handle_of(&self, session_id: &str) -> Option<Arc<Mutex<client::Handle<ClientHandler>>>> {
        self.sessions.lock().await.get(session_id).map(|s| s.handle.clone())
    }

    /// 记一条远程转发：服务器那边进来的连接该落到本机哪儿
    pub(crate) async fn add_remote_forward(
        &self,
        session_id: &str,
        bind: &str,
        bind_port: u32,
        dest_host: &str,
        dest_port: u16,
    ) {
        if let Some(session) = self.sessions.lock().await.get(session_id) {
            if let Ok(mut map) = session.forwards.lock() {
                map.insert((bind.to_string(), bind_port), (dest_host.to_string(), dest_port));
            }
        }
    }

    pub(crate) async fn drop_remote_forward(&self, session_id: &str, bind: &str, bind_port: u32) {
        if let Some(session) = self.sessions.lock().await.get(session_id) {
            if let Ok(mut map) = session.forwards.lock() {
                map.remove(&(bind.to_string(), bind_port));
            }
        }
    }

    /// 关窗退出时把所有会话收干净，不留半开的 TCP
    pub(crate) async fn close_all(&self) {
        for (_, session) in self.sessions.lock().await.drain() {
            let _ = session.tx.send(Cmd::Close);
        }
        self.pending.lock().await.clear();
    }
}

/// 服务器公钥没过校验时，把细节留在这儿交给命令层组装错误
#[derive(Clone, Default)]
pub(crate) struct KeyReport {
    /// "unknown" | "changed"
    pub kind: String,
    pub algo: String,
    pub fingerprint: String,
}

pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    /// 用户在指纹卡上点过信任：**并且**这把钥匙的指纹跟他核对过的那串对得上，才放行
    trusted: bool,
    /// 用户核对过的那串指纹（点信任时前端原样带回来）
    expect: Option<String>,
    /// "auto" 没见过就自动记（默认，不打扰）· "ask" 头一回也问一句 · "off" 不校验
    policy: String,
    report: Arc<std::sync::Mutex<Option<KeyReport>>>,
    /// 远程转发登记表：服务器推连接过来时照着它找本机的落点
    forwards: Forwards,
}

// russh 0.45 的 Handler 用 async_trait 宏（非原生 async fn），impl 必须同样标注
#[async_trait::async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    /// 对着 ~/.ssh/known_hosts 校验。
    /// 默认 auto：头一回见的自动记下来直接连，不拦人；**只有指纹变了才拦**，
    /// 因为那才是真该停下来看一眼的情况（重装 or 有人插在中间）。
    async fn check_server_key(&mut self, server_public_key: &key::PublicKey) -> Result<bool, Self::Error> {
        if self.trusted {
            let actual = crate::hosts::fingerprint_of(server_public_key);
            // 用户核对的是那一串，服务器这次给的必须还是那一串。
            // 不比对的话，「第一次连被拦下 → 点信任 → 重连」这个缝里能塞进一把别的钥匙。
            match self.expect.as_deref() {
                Some(approved) if approved != actual => {
                    if let Ok(mut slot) = self.report.lock() {
                        *slot = Some(KeyReport {
                            kind: "changed".into(),
                            algo: server_public_key.name().to_string(),
                            fingerprint: actual,
                        });
                    }
                    return Ok(false);
                }
                _ => {}
            }
            // 认过了：覆盖旧记录，下次就不问了
            let _ = crate::hosts::trust(&self.host, self.port, server_public_key, true);
            return Ok(true);
        }
        if self.policy == "off" {
            return Ok(true);
        }

        let (kind, algo, fingerprint) = match crate::hosts::verify(&self.host, self.port, server_public_key) {
            crate::hosts::HostVerdict::Known => return Ok(true),
            crate::hosts::HostVerdict::Unknown { algo, fingerprint } => {
                if self.policy != "ask" {
                    // 头一回见：静悄悄记下来，直接连
                    let _ = crate::hosts::trust(&self.host, self.port, server_public_key, false);
                    return Ok(true);
                }
                ("unknown", algo, fingerprint)
            }
            crate::hosts::HostVerdict::Changed { algo, fingerprint } => ("changed", algo, fingerprint),
        };

        if let Ok(mut slot) = self.report.lock() {
            *slot = Some(KeyReport { kind: kind.into(), algo, fingerprint });
        }
        Ok(false)
    }

    /// 远程转发（-R）：服务器那边有人连上了转发端口，把这条通道接到本机的目标上
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // 服务器报的 bind 地址不一定跟我们请求时写的一模一样（常见 "" / "0.0.0.0" / "localhost"），
        // 所以先按原样找，找不到就只认端口
        let target = self.forwards.lock().ok().and_then(|map| {
            map.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| map.iter().find(|((_, port), _)| *port == connected_port).map(|(_, dest)| dest.clone()))
        });
        let Some((host, port)) = target else {
            // 没登记过的转发不接，直接让通道断掉
            return Ok(());
        };

        tauri::async_runtime::spawn(async move {
            let Ok(mut tcp) = tokio::net::TcpStream::connect((host.as_str(), port)).await else { return };
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut tcp).await;
        });
        Ok(())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub session_id: String,
    /// 连接配置 id：钥匙串按它存取凭据
    pub conn_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key"
    pub auth_type: String,
    /// 密码认证时用；不落盘（留空则用钥匙串里存过的）
    pub password: Option<String>,
    /// 密钥认证时的私钥文件路径
    pub key_path: Option<String>,
    /// 私钥密码短语（如有）；不落盘（留空则用钥匙串里存过的）
    pub passphrase: Option<String>,
    /// 认证成功后把这次用的凭据存进系统钥匙串
    #[serde(default)]
    pub remember: bool,
    /// 用户在指纹卡上点了信任 —— 连同他核对过的指纹一起带回来
    #[serde(default)]
    pub trust_host: bool,
    /// 用户核对过的那串指纹（SHA256:...）
    pub trust_fingerprint: Option<String>,
    /// 指纹校验策略："auto"（默认，头回自动记）/ "ask" / "off"
    pub host_policy: Option<String>,
    /// 终端字符编码标签（"utf-8" / "gbk" / …），不给就按 UTF-8
    pub encoding: Option<String>,
    /// 要先过一台跳板机的话，填它
    pub jump: Option<JumpParams>,
}

/// 跳板机（ProxyJump / 堡垒机）。
/// 凭据只从系统钥匙串取 —— 跳板机得先单独连一次、勾上「记住」，
/// 或者用没有密码短语的私钥。这条链上不弹第二个密码框，
/// 免得「目标机的密码框」和「跳板机的密码框」在界面上分不清谁是谁。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpParams {
    pub conn_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key"
    pub auth_type: String,
    pub key_path: Option<String>,
    pub host_policy: Option<String>,
}

/// 认证走完了，还是还得再问
enum AuthStep {
    Done,
    Ask(AuthPrompts),
}

/// 键盘交互最多来回几轮，防着服务器无限问下去
const MAX_AUTH_ROUNDS: usize = 8;

/// 建立 SSH 连接，开 PTY + shell，后台任务独占 Channel 收发。
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: tauri::State<'_, SshState>,
    params: ConnectParams,
) -> Result<(), SshError> {
    let forwards: Forwards = Arc::new(std::sync::Mutex::new(HashMap::new()));

    // 先把跳板机连起来（如果配了）：目标机的 TCP 连接是从跳板机上打出去的
    let jump = match params.jump.clone() {
        Some(spec) => Some(Arc::new(Mutex::new(dial_jump(&spec).await?))),
        None => None,
    };

    let report = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        host: params.host.clone(),
        port: params.port,
        trusted: params.trust_host,
        expect: params.trust_fingerprint.clone().filter(|s| !s.is_empty()),
        policy: params.host_policy.clone().unwrap_or_else(|| "auto".into()),
        report: report.clone(),
        forwards: forwards.clone(),
    };

    let mut handle = match &jump {
        // 走跳板：在跳板机上开一条到目标的 direct-tcpip，拿它当传输层
        Some(gate) => {
            let channel = gate
                .lock()
                .await
                .channel_open_direct_tcpip(params.host.clone(), params.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| SshError::new("跳板机连不到目标机，检查目标地址和跳板机的出网权限", e))?;
            client::connect_stream(keepalive_config(), channel.into_stream(), handler)
                .await
                .map_err(|e| match report.lock().ok().and_then(|mut slot| slot.take()) {
                    Some(found) => SshError::host_key(found),
                    None => SshError::new("跳板机后面这台握手失败", e),
                })?
        }
        None => client::connect(keepalive_config(), (params.host.as_str(), params.port), handler)
            .await
            .map_err(|e| match report.lock().ok().and_then(|mut slot| slot.take()) {
                Some(found) => SshError::host_key(found),
                None => SshError::new("连不上服务器，检查地址、端口和网络", e),
            })?,
    };

    // 这次用的凭据：前端给了就用前端的，没给就翻钥匙串
    let typed = if params.auth_type == "key" { params.passphrase.clone() } else { params.password.clone() };
    let secret = typed
        .filter(|s| !s.is_empty())
        .or_else(|| crate::creds::load(&params.conn_id));

    let mut used = false;
    match authenticate(&mut handle, &params, secret.as_deref(), &mut used).await? {
        AuthStep::Done => finish(app, &state, handle, params, secret, forwards, jump).await,
        AuthStep::Ask(prompts) => {
            // 半截连接寄存起来，等前端把答案送回来（ssh_answer）
            state.pending.lock().await.insert(
                params.session_id.clone(),
                Pending { handle, params, secret, secret_used: used, forwards, jump },
            );
            Err(SshError::asks(prompts))
        }
    }
}

/// 30 秒没动静就发个保活包，免得挂着的终端被中间的网关悄悄掐断
fn keepalive_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 5,
        ..client::Config::default()
    })
}

/// 连上跳板机并认证。凭据只从钥匙串取，这里不弹框问。
async fn dial_jump(spec: &JumpParams) -> Result<client::Handle<ClientHandler>, SshError> {
    let report = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        host: spec.host.clone(),
        port: spec.port,
        trusted: false,
        expect: None,
        policy: spec.host_policy.clone().unwrap_or_else(|| "auto".into()),
        report: report.clone(),
        forwards: Arc::new(std::sync::Mutex::new(HashMap::new())),
    };

    let mut gate = client::connect(keepalive_config(), (spec.host.as_str(), spec.port), handler)
        .await
        .map_err(|e| match report.lock().ok().and_then(|mut slot| slot.take()) {
            Some(found) => SshError::host_key(found),
            None => SshError::new("连不上跳板机，检查它的地址和端口", e),
        })?;

    let secret = crate::creds::load(&spec.conn_id);
    let ok = if spec.auth_type == "key" {
        let path = spec
            .key_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| SshError::plain("跳板机是密钥认证，但没填私钥路径"))?;
        let key = load_secret_key(path, secret.as_deref())
            .map_err(|e| SshError::new("跳板机的私钥读不了", e))?;
        gate.authenticate_publickey(&spec.username, Arc::new(key))
            .await
            .map_err(|e| SshError::new("跳板机密钥认证出错", e))?
    } else {
        let password = secret.ok_or_else(|| {
            SshError::plain("跳板机的密码还没存进钥匙串 —— 先单独连一次那台机器，连的时候勾上「记住」")
        })?;
        gate.authenticate_password(&spec.username, &password)
            .await
            .map_err(|e| SshError::new("跳板机密码认证出错", e))?
    };
    if !ok {
        return Err(SshError::plain("跳板机认证失败：用户名或密码不对，或者钥匙串里存的已经过期了"));
    }
    Ok(gate)
}

/// 前端把用户的回答送回来，接着往下认证
#[tauri::command]
pub async fn ssh_answer(
    app: AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    answers: Vec<String>,
) -> Result<(), SshError> {
    let waiting = state.pending.lock().await.remove(&session_id);
    let Some(Pending { mut handle, params, secret, secret_used, forwards, jump }) = waiting else {
        return Err(SshError::plain("这次认证已经过期了，重新连一次"));
    };

    let reply = handle
        .authenticate_keyboard_interactive_respond(answers)
        .await
        .map_err(|e| SshError::new("回答发不出去", e))?;

    let mut used = secret_used;
    match advance(&mut handle, reply, secret.as_deref(), &mut used).await? {
        AuthStep::Done => finish(app, &state, handle, params, secret, forwards, jump).await,
        AuthStep::Ask(prompts) => {
            state.pending.lock().await.insert(
                session_id,
                Pending { handle, params, secret, secret_used: used, forwards, jump },
            );
            Err(SshError::asks(prompts))
        }
    }
}

/// 用户在问题弹窗上点了取消：把寄存的半截连接丢掉
#[tauri::command]
pub async fn ssh_cancel_auth(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    state.pending.lock().await.remove(&session_id);
    Ok(())
}

/// 认证：密钥优先，否则密码 →（密码不通或压根没开）键盘交互
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    params: &ConnectParams,
    secret: Option<&str>,
    used: &mut bool,
) -> Result<AuthStep, SshError> {
    if params.auth_type == "key" {
        let path = params
            .key_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| SshError::plain("请填写私钥文件路径"))?;
        let key = load_secret_key(path, secret)
            .map_err(|e| SshError::new("私钥读取失败，检查路径或密码短语", e))?;
        let ok = handle
            .authenticate_publickey(&params.username, Arc::new(key))
            .await
            .map_err(|e| SshError::new("密钥认证出错", e))?;
        if ok {
            *used = true;
            return Ok(AuthStep::Done);
        }
        return Err(SshError::plain("服务器不认这把私钥：确认公钥已经放进服务器的 authorized_keys"));
    }

    // 有密码就先走标准密码认证 —— 服务器开着这条就一步到位
    if let Some(password) = secret.filter(|s| !s.is_empty()) {
        let ok = handle
            .authenticate_password(&params.username, password)
            .await
            .map_err(|e| SshError::new("密码认证出错", e))?;
        if ok {
            *used = true;
            return Ok(AuthStep::Done);
        }
    }

    // 密码这条路不通（或服务器压根没开），换键盘交互：
    // 很多服务器只开这一条，2FA / OTP 也走这里
    let reply = handle
        .authenticate_keyboard_interactive_start(params.username.clone(), None)
        .await
        .map_err(|e| SshError::new("认证方式协商失败", e))?;
    advance(handle, reply, secret, used).await
}

/// 键盘交互的一轮：能替用户答的就替他答了，答不上来的交给前端
async fn advance(
    handle: &mut client::Handle<ClientHandler>,
    first: KeyboardInteractiveAuthResponse,
    secret: Option<&str>,
    used: &mut bool,
) -> Result<AuthStep, SshError> {
    let mut reply = first;
    for _ in 0..MAX_AUTH_ROUNDS {
        match reply {
            KeyboardInteractiveAuthResponse::Success => {
                return Ok(AuthStep::Done);
            }
            KeyboardInteractiveAuthResponse::Failure => {
                return Err(SshError::plain("认证失败：用户名、密码或验证码不对"));
            }
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                // 服务器有时会发一组空问题当通知，直接回个空数组继续
                if prompts.is_empty() {
                    reply = handle
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                        .map_err(|e| SshError::new("认证过程出错", e))?;
                    continue;
                }

                // 只有「就一个问题、还是遮起来输的」才敢拿密码去答 ——
                // 那就是普通的密码问询。多问一句（2FA 验证码之类）一律交给用户，
                // 拿密码去撞验证码框既答不对，还可能把账号撞锁了。
                let auto = !*used
                    && prompts.len() == 1
                    && !prompts[0].echo
                    && secret.is_some_and(|s| !s.is_empty());

                if auto {
                    *used = true;
                    reply = handle
                        .authenticate_keyboard_interactive_respond(vec![secret.unwrap_or("").to_string()])
                        .await
                        .map_err(|e| SshError::new("认证过程出错", e))?;
                    continue;
                }

                return Ok(AuthStep::Ask(AuthPrompts {
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|p| AuthPrompt { prompt: p.prompt, echo: p.echo })
                        .collect(),
                }));
            }
        }
    }
    Err(SshError::plain("服务器一直在问，认证没能走完"))
}

/// 认证过了：存凭据、开 PTY + shell、把会话挂上
#[allow(clippy::too_many_arguments)]
async fn finish(
    app: AppHandle,
    state: &tauri::State<'_, SshState>,
    handle: client::Handle<ClientHandler>,
    params: ConnectParams,
    secret: Option<String>,
    forwards: Forwards,
    jump: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
) -> Result<(), SshError> {
    // 认证过了才存，省得把打错的密码记一辈子。
    // 只存密码 / 密码短语；一次性的验证码不进钥匙串。
    if params.remember {
        if let Some(secret) = secret.as_deref() {
            crate::creds::save(&params.conn_id, secret);
        }
    }

    // 句柄进 Arc<Mutex>：终端用它开 shell 通道，SFTP 和隧道后续在同一条连接上开子通道
    let handle = Arc::new(Mutex::new(handle));

    let channel = handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|e| SshError::new("打开会话失败", e))?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| SshError::new("申请 PTY 失败", e))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| SshError::new("启动 shell 失败", e))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let encoding = Arc::new(std::sync::Mutex::new(crate::encoding::resolve(params.encoding.as_deref())));
    let log: LogSink = Arc::new(std::sync::Mutex::new(None));
    state.sessions.lock().await.insert(
        params.session_id.clone(),
        Session { tx, handle: handle.clone(), encoding: encoding.clone(), log: log.clone(), forwards, jump },
    );

    let data_event = format!("ssh://data/{}", params.session_id);
    let close_event = format!("ssh://close/{}", params.session_id);
    let sid = params.session_id.clone();
    let sessions_ref = state.sessions.clone();

    // 会话任务：独占 channel，一边收服务器输出、一边执行前端指令
    tauri::async_runtime::spawn(async move {
        let mut channel = channel;
        // 服务器输出按会话编码解码后再送前端。
        // 解码器是有状态的：一个汉字可能被拆在两个网络包里，
        // 每块新建一个解码器就会在包边界上吐问号。
        let mut current = *encoding.lock().unwrap();
        let mut decoder = current.new_decoder();
        let mut decode = |bytes: &[u8]| -> String {
            let want = *encoding.lock().unwrap();
            if !std::ptr::eq(want, current) {
                // 用户中途换了编码：从这块起用新的
                current = want;
                decoder = current.new_decoder();
            }
            let mut out = String::with_capacity(bytes.len() * 2);
            let _ = decoder.decode_to_string(bytes, &mut out, false);
            out
        };

        // 开着日志就顺手往文件抄一份（控制序列剥掉，留能读的正文）
        let tee = |text: &str| {
            if let Ok(slot) = log.lock() {
                if let Some(sink) = slot.as_ref() {
                    let _ = sink.send(strip_ansi(text));
                }
            }
        };

        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = decode(&data);
                        tee(&text);
                        let _ = app.emit(&data_event, text);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Write(bytes)) => { let _ = channel.data(&bytes[..]).await; }
                    Some(Cmd::Resize { cols, rows }) => { let _ = channel.window_change(cols, rows, 0, 0).await; }
                    Some(Cmd::Close) | None => break,
                }
            }
        }
        let _ = channel.close().await;
        let _ = app.emit(&close_event, ());
        sessions_ref.lock().await.remove(&sid);
        // 连接没了，挂在上面的 SFTP 子会话一并丢掉
        crate::sftp::drop_session(&app, &sid).await;
    });

    Ok(())
}

/// 用户输入 → 服务器（按会话编码转成字节，GBK 的机器上打中文才不会变成乱码）
#[tauri::command]
pub async fn ssh_write(
    state: tauri::State<'_, SshState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let (tx, encoding) = {
        let map = state.sessions.lock().await;
        let session = map.get(&session_id).ok_or("会话不存在")?;
        let picked = *session.encoding.lock().map_err(|_| "编码状态异常")?;
        (session.tx.clone(), picked)
    };
    let bytes = crate::encoding::encode(&data, encoding);
    tx.send(Cmd::Write(bytes)).map_err(|_| "会话已关闭".to_string())?;
    Ok(())
}

/// 开始记会话日志：服务器输出往这个文件里抄一份（追加，不覆盖已有的）
#[tauri::command]
pub async fn ssh_log_start(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), SshError> {
    let slot = {
        let map = state.sessions.lock().await;
        map.get(&session_id).ok_or_else(|| SshError::plain("会话不在了"))?.log.clone()
    };

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| SshError::new("这个日志文件写不了，换个位置试试", e))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = rx.recv().await {
            if file.write_all(chunk.as_bytes()).await.is_err() {
                break;
            }
        }
        // 通道关了（停止记录 / 会话结束）：把缓冲刷干净再走
        let _ = file.flush().await;
    });

    if let Ok(mut current) = slot.lock() {
        // 换文件的话，旧的那条写入任务收到通道关闭会自己收尾
        *current = Some(tx);
    }
    Ok(())
}

/// 停止记录（文件那边会把没写完的刷干净）
#[tauri::command]
pub async fn ssh_log_stop(state: tauri::State<'_, SshState>, session_id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.get(&session_id) {
        if let Ok(mut slot) = session.log.lock() {
            *slot = None;
        }
    }
    Ok(())
}

/// 连着的时候换编码：下一块输出就按新的解，不用重连
#[tauri::command]
pub async fn ssh_set_encoding(
    state: tauri::State<'_, SshState>,
    session_id: String,
    encoding: String,
) -> Result<String, String> {
    let picked = crate::encoding::resolve(Some(&encoding));
    let map = state.sessions.lock().await;
    let session = map.get(&session_id).ok_or("会话不存在")?;
    *session.encoding.lock().map_err(|_| "编码状态异常")? = picked;
    Ok(crate::encoding::name_of(picked))
}

/// 终端尺寸变化 → 同步 PTY
#[tauri::command]
pub async fn ssh_resize(
    state: tauri::State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.get(&session_id) {
        let _ = session.tx.send(Cmd::Resize { cols, rows });
    }
    Ok(())
}

/// 关闭会话
#[tauri::command]
pub async fn ssh_close(
    app: AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.remove(&session_id) {
        let _ = session.tx.send(Cmd::Close);
    }
    state.pending.lock().await.remove(&session_id);
    crate::sftp::drop_session(&app, &session_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_colors_and_titles() {
        // 颜色
        assert_eq!(strip_ansi("\u{1b}[32m绿的\u{1b}[0m"), "绿的");
        // 改窗口标题的 OSC，BEL 收尾
        assert_eq!(strip_ansi("\u{1b}]0;标题\u{7}正文"), "正文");
        // OSC 用 ESC \ 收尾的写法
        assert_eq!(strip_ansi("\u{1b}]0;标题\u{1b}\\正文"), "正文");
    }

    #[test]
    fn keeps_the_text_readable() {
        // 换行留着，孤零零的回车去掉（否则日志里整行像被吃了）
        assert_eq!(strip_ansi("一\r\n二\r"), "一\n二");
        assert_eq!(strip_ansi("没有转义"), "没有转义");
    }

    #[test]
    fn survives_a_truncated_sequence() {
        // 序列被切在块边界上也不能 panic
        assert_eq!(strip_ansi("正文\u{1b}["), "正文");
        assert_eq!(strip_ansi("正文\u{1b}"), "正文");
    }
}
