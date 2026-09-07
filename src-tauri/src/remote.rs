//! 在已有的 SSH 连接上跑一条命令，把输出收回来。
//!
//! 状态面板和日志查看器都要这个：从 `SshState::handle_of` 拿句柄另开一个 exec
//! 子通道，不新建 TCP、不二次认证，也不去挤交互 shell 那条通道。
//!
//! 这里只管「把命令送出去、把 stdout 收回来」。要跑什么、怎么解析，各自的模块自己管。

use russh::ChannelMsg;

use crate::ssh::{SshError, SshState};

/// 一次 exec 最多收多少输出。`ps`、`df` 正常都在几十 KB 内，
/// 超了多半是命令被人换掉了或者对面在刷屏，收住别把内存吃了。
const MAX_OUT: usize = 4 * 1024 * 1024;

/// 采集类命令的超时。到点就放弃这一轮，下一轮照常来。
pub(crate) const QUICK: std::time::Duration = std::time::Duration::from_secs(15);
/// 开通道本身的上限：正常几十毫秒，等到这么久说明连接已经不对了
const OPEN_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// 会真跑很久的（`du`、大文件上的 `grep`）用这个
pub(crate) const SLOW: std::time::Duration = std::time::Duration::from_secs(90);

/// 把一段文本包成 shell 的单引号字面量。
///
/// 路径和搜索词是用户敲进来的，直接拼进命令行等于把 shell 交给对方。
/// 单引号里除了 `'` 自己以外什么都不展开，所以只要把 `'` 拆成 `'\''` 就安全了。
pub(crate) fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// 在这条会话上跑一条命令，把标准输出收回来。
///
/// 只收 stdout：要看错误的地方自己在命令里写 `2>&1`，
/// 否则 stderr 一律丢掉，免得警告混进要解析的正文里。
pub(crate) async fn exec(
    ssh: &SshState,
    session_id: &str,
    command: &str,
    limit: std::time::Duration,
) -> Result<String, SshError> {
    let handle = ssh
        .handle_of(session_id)
        .await
        .ok_or_else(|| SshError::plain("SSH 会话不在了，先重新连接"))?;

    // 跟 SFTP 一样：只借一下锁把通道开出来就还。
    // 开通道要等服务器回 OPEN_CONFIRMATION，TCP 半死时会一直等，而这期间锁被占着，
    // SFTP、隧道全得排队 —— 所以这一步也给个上限
    let opened = tokio::time::timeout(OPEN_LIMIT, async { handle.lock().await.channel_open_session().await }).await;
    let mut channel = match opened {
        Ok(Ok(channel)) => channel,
        Ok(Err(e)) => return Err(SshError::new("打开采集通道失败", e)),
        Err(_) => return Err(SshError::plain("服务器没有响应开通道的请求，这条连接可能已经半死了")),
    };

    if let Err(e) = channel.exec(true, command).await {
        let _ = channel.close().await;
        return Err(SshError::new("命令没能送出去", e));
    }

    let read_loop = async {
        let mut out: Vec<u8> = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                // ExtendedData 是 stderr，不收
                ChannelMsg::Data { data } => {
                    if out.len() < MAX_OUT {
                        out.extend_from_slice(&data);
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        out
    };
    let result = tokio::time::timeout(limit, read_loop).await;

    // 超没超时都要显式关。russh 的 Channel 没有 Drop 实现，丢掉不会发 CHANNEL_CLOSE：
    // 超时那条命令在远端跑完之前，这个 session 槽位一直占着，`du /` 卡住几次
    // 就把 sshd 的 MaxSessions 打满，SFTP、隧道、状态面板全部开不了通道
    let _ = channel.close().await;
    let bytes = result.map_err(|_| SshError::plain("服务器这条命令跑太久，这一轮先算了"))?;

    let encoding = ssh.encoding_of(session_id).await;
    Ok(crate::encoding::decode(&bytes, encoding).text)
}

/// 从 app 里取出 SSH 会话表
pub(crate) fn ssh_of(app: &tauri::AppHandle) -> SshState {
    use tauri::Manager;
    app.state::<SshState>().inner().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_shuts_the_shell_up() {
        assert_eq!(quote("/var/log"), "'/var/log'");
        // 带空格、带引号、带分号的路径都得原样进去，不能变成第二条命令
        assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(quote("/tmp/x'; rm -rf /"), "'/tmp/x'\\''; rm -rf /'");
        // 搜索词里的反引号和 $ 在单引号里不展开，原样送过去
        assert_eq!(quote("$(whoami)`id`"), "'$(whoami)`id`'");
    }
}
