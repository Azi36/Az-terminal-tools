//! 端口转发（隧道）。
//!
//! 三种，跟 ssh 命令行那三个开关一一对应：
//! - 本地转发 `-L`：本机开个端口，连它就等于连到服务器那边的某个地址。
//!   访问只对服务器开放的数据库、内网后台，用的就是这个。
//! - 动态转发 `-D`：本机开个 SOCKS5 代理，浏览器挂上去，整台机器的网络当跳板。
//! - 远程转发 `-R`：让服务器开个端口，从那边连过来落到本机的服务上。
//!
//! 都复用终端那条已经认证过的 SSH 连接，不额外登录。
//! Termius 把这些放在付费墙后面，这里是白给的。

use std::collections::HashMap;
use std::sync::Arc;

use russh::client;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};

use crate::ssh::{ClientHandler, SshError, SshState};

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    pub id: String,
    /// "local" 本地转发 · "socks" 动态代理 · "remote" 远程转发
    pub kind: String,
    /// 监听地址：本地转发和 SOCKS 是本机的，远程转发是服务器上的
    pub listen_host: String,
    pub listen_port: u16,
    /// 转到哪儿去（SOCKS 由客户端自己说，不用填）
    pub dest_host: String,
    pub dest_port: u16,
}

/// 隧道状态推给前端：开了几条、断了没有
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelEvent {
    session_id: String,
    id: String,
    /// "open" 起来了 · "closed" 停了 · "error" 出错 · "conn" 连接数变了
    state: &'static str,
    /// 当前挂着几条连接
    active: usize,
    message: Option<String>,
}

struct Running {
    spec: TunnelSpec,
    session_id: String,
    /// 喊停用：accept 循环和每条连接的转发都听着它
    stop: broadcast::Sender<()>,
    active: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Default)]
pub struct TunnelState {
    running: Mutex<HashMap<String, Running>>,
}

impl TunnelState {
    /// SSH 会话没了，挂在它上面的隧道全停掉
    pub async fn drop_session(&self, session_id: &str) {
        let mut map = self.running.lock().await;
        map.retain(|_, one| {
            if one.session_id == session_id {
                let _ = one.stop.send(());
                false
            } else {
                true
            }
        });
    }
}

fn emit(app: &AppHandle, session_id: &str, id: &str, state: &'static str, active: usize, message: Option<String>) {
    let _ = app.emit(
        "tunnel://state",
        TunnelEvent { session_id: session_id.to_string(), id: id.to_string(), state, active, message },
    );
}

/// 把一条本地 TCP 连接和一条 SSH 通道对接起来，两头对着倒字节
#[allow(clippy::too_many_arguments)]
async fn splice(
    handle: Arc<Mutex<client::Handle<ClientHandler>>>,
    mut tcp: TcpStream,
    dest_host: String,
    dest_port: u16,
    mut stop: broadcast::Receiver<()>,
    active: Arc<std::sync::atomic::AtomicUsize>,
    app: AppHandle,
    session_id: String,
    tunnel_id: String,
) {
    use std::sync::atomic::Ordering;
    let peer = tcp.peer_addr().map(|a| a.ip().to_string()).unwrap_or_else(|_| "127.0.0.1".into());
    // 开通道时借一下锁，之后的字节搬运不占锁
    let opened = handle
        .lock()
        .await
        .channel_open_direct_tcpip(dest_host, dest_port as u32, peer, 0)
        .await;
    let channel = match opened {
        Ok(channel) => channel,
        Err(_) => return,
    };

    // 连接数开一条、断一条都报一声，面板上的数字才不会只在断开时才动
    let now = active.fetch_add(1, Ordering::Relaxed) + 1;
    emit(&app, &session_id, &tunnel_id, "conn", now, None);
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {}
        _ = stop.recv() => {}
    }
    let _ = tcp.shutdown().await;
    let now = active.fetch_sub(1, Ordering::Relaxed).saturating_sub(1);
    emit(&app, &session_id, &tunnel_id, "conn", now, None);
}

/// SOCKS5 握手：只支持 CONNECT，不做认证（监听在本机，谁能连上谁就已经在这台机器上了）
async fn socks_handshake(tcp: &mut TcpStream) -> std::io::Result<Option<(String, u16)>> {
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Ok(None);
    }
    let mut methods = vec![0u8; head[1] as usize];
    tcp.read_exact(&mut methods).await?;
    // 0x00 = 不需要认证
    tcp.write_all(&[0x05, 0x00]).await?;

    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await?;
    if req[0] != 0x05 {
        return Ok(None);
    }
    if req[1] != 0x01 {
        // 只做 CONNECT，BIND / UDP 一律回「不支持」
        tcp.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(None);
    }

    let host = match req[3] {
        0x01 => {
            let mut raw = [0u8; 4];
            tcp.read_exact(&mut raw).await?;
            std::net::Ipv4Addr::from(raw).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).to_string()
        }
        0x04 => {
            let mut raw = [0u8; 16];
            tcp.read_exact(&mut raw).await?;
            std::net::Ipv6Addr::from(raw).to_string()
        }
        _ => {
            tcp.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    tcp.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);

    // 回一个「成功」，绑定地址填 0 就行，客户端基本不看
    tcp.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    Ok(Some((host, port)))
}

/// 开一条隧道
#[tauri::command]
pub async fn tunnel_open(
    app: AppHandle,
    ssh: tauri::State<'_, SshState>,
    state: tauri::State<'_, TunnelState>,
    session_id: String,
    spec: TunnelSpec,
) -> Result<(), SshError> {
    if state.running.lock().await.contains_key(&spec.id) {
        return Err(SshError::plain("这条隧道已经开着了"));
    }
    let handle = ssh
        .handle_of(&session_id)
        .await
        .ok_or_else(|| SshError::plain("SSH 会话不在了，先连上再开隧道"))?;

    let (stop, _) = broadcast::channel::<()>(4);
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    match spec.kind.as_str() {
        "remote" => {
            // 先登记落点，再请服务器开端口 —— 反过来的话，
            // 服务器手快先推一条连接进来，我们还不知道该往哪儿送
            ssh.add_remote_forward(
                &session_id,
                &spec.listen_host,
                spec.listen_port as u32,
                &spec.dest_host,
                spec.dest_port,
            )
            .await;
            let asked = handle
                .lock()
                .await
                .tcpip_forward(spec.listen_host.clone(), spec.listen_port as u32)
                .await;
            if let Err(e) = asked {
                // 服务器不肯：刚登记的落点得撤掉，不然它会截胡之后同端口的另一条隧道
                ssh.drop_remote_forward(&session_id, &spec.listen_host, spec.listen_port as u32).await;
                return Err(SshError::new("服务器不让开这个端口（多半是 sshd 没开 GatewayPorts，或者端口被占了）", e));
            }
        }
        "local" | "socks" => {
            let bind = format!("{}:{}", spec.listen_host, spec.listen_port);
            let listener = TcpListener::bind(&bind)
                .await
                .map_err(|e| SshError::new(&format!("本机 {bind} 监听不了，端口可能被占了"), e))?;

            let stop_tx = stop.clone();
            let counter = active.clone();
            let job = spec.clone();
            let sid = session_id.clone();
            let app_ref = app.clone();
            // stop 的接收端在这儿就订好：spawn 出去的任务还没跑起来时就来了 stop 信号，
            // 任务里再 subscribe 是收不到的，accept 循环会一直停不下来
            let mut stop_rx = stop.subscribe();
            tauri::async_runtime::spawn(async move {
                // 连续 accept 失败的次数：ECONNABORTED / 对端 reset 这种一次两次很正常，
                // 一直失败（描述符耗尽之类）这条隧道就没法再服务了，得明说而不是假活着
                let mut failures = 0u32;
                loop {
                    let accepted = tokio::select! {
                        one = listener.accept() => one,
                        _ = stop_rx.recv() => break,
                    };
                    let (tcp, _) = match accepted {
                        Ok(one) => {
                            failures = 0;
                            one
                        }
                        Err(e) => {
                            failures += 1;
                            if failures >= 20 {
                                app_ref.state::<TunnelState>().running.lock().await.remove(&job.id);
                                emit(&app_ref, &sid, &job.id, "error", 0, Some(format!("本机端口接不了新连接：{e}")));
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            continue;
                        }
                    };

                    let each = handle.clone();
                    let each_stop = stop_tx.subscribe();
                    let each_count = counter.clone();
                    let ping = app_ref.clone();
                    let ping_sid = sid.clone();
                    let ping_id = job.id.clone();
                    let kind = job.kind.clone();
                    let fixed = (job.dest_host.clone(), job.dest_port);
                    tauri::async_runtime::spawn(async move {
                        let mut tcp = tcp;
                        // SOCKS 的目标是客户端在握手里说的，本地转发是固定的。
                        // 握手放在每条连接自己的任务里：一个连上不说话的客户端不该堵住后面所有人
                        let target = if kind == "socks" {
                            match socks_handshake(&mut tcp).await {
                                Ok(Some(one)) => one,
                                _ => return,
                            }
                        } else {
                            fixed
                        };
                        splice(each, tcp, target.0, target.1, each_stop, each_count, ping, ping_sid, ping_id).await;
                    });
                }
            });
        }
        other => return Err(SshError::plain(&format!("不认识的隧道类型：{other}"))),
    }

    let id = spec.id.clone();
    state.running.lock().await.insert(
        id.clone(),
        Running { spec, session_id: session_id.clone(), stop, active },
    );
    emit(&app, &session_id, &id, "open", 0, None);
    Ok(())
}

/// 停一条隧道
#[tauri::command]
pub async fn tunnel_close(
    app: AppHandle,
    ssh: tauri::State<'_, SshState>,
    state: tauri::State<'_, TunnelState>,
    id: String,
) -> Result<(), SshError> {
    let Some(one) = state.running.lock().await.remove(&id) else {
        return Ok(());
    };
    let _ = one.stop.send(());
    if one.spec.kind == "remote" {
        ssh.drop_remote_forward(&one.session_id, &one.spec.listen_host, one.spec.listen_port as u32).await;
        // 让服务器把端口真的撤掉；只删本地登记的话 sshd 那头还监听着，
        // 这条会话上再开同一个端口会被拒
        if let Some(handle) = ssh.handle_of(&one.session_id).await {
            let _ = handle
                .lock()
                .await
                .cancel_tcpip_forward(one.spec.listen_host.clone(), one.spec.listen_port as u32)
                .await;
        }
    }
    emit(&app, &one.session_id, &id, "closed", 0, None);
    Ok(())
}

/// 这条隧道现在的样子（重开面板时对齐状态用）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    /// 此刻挂着几条连接
    pub active: usize,
}

/// 这条会话上现在开着哪些隧道
#[tauri::command]
pub async fn tunnel_list(
    state: tauri::State<'_, TunnelState>,
    session_id: String,
) -> Result<Vec<TunnelStatus>, SshError> {
    Ok(state
        .running
        .lock()
        .await
        .values()
        .filter(|one| one.session_id == session_id)
        .map(|one| TunnelStatus {
            id: one.spec.id.clone(),
            active: one.active.load(std::sync::atomic::Ordering::Relaxed),
        })
        .collect())
}
