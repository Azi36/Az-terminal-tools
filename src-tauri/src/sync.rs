//! WebDAV 同步：把备份放到自己的网盘上，换台机器拉回来。
//!
//! 只有两个动作：**上传**（PUT 一个文件）和**下载**（GET 回来）。
//! 没有自动同步、没有后台轮询、没有冲突合并——都是用户点一下才发生的事。
//! 一个人用的工具，「上次在哪台机器上改的」他自己清楚；替他猜反而会出事。
//!
//! **传上去的永远是密文。** 调用这儿之前，前端已经用 `vault_seal` 把内容封好了。
//! 备份里虽然没有密码，但主机名、用户名、跳板机链路、内网端口就是一张内网地图，
//! 放在别人的服务器上必须是加密的 —— 这一条不给开关。
//!
//! WebDAV 的账号密码存系统钥匙串（跟 SSH 的凭据一个地方），不落我们的配置文件。

use std::io::Read;

/// 单个备份文件的上限。配置就那么点大，超了多半是地址填错、GET 回来一个网页。
const MAX_BODY: usize = 8 * 1024 * 1024;

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    /// 服务器上那份的内容；不存在就是 None
    pub content: Option<String>,
}

/// 地址必须是一个完整的 http(s) URL，而且要指到**一个文件**。
///
/// 指到目录的话 PUT 会失败或者在某些服务器上创建出奇怪的东西，
/// 而 GET 回来的是一个目录列表的 HTML —— 那种「成功了但内容是垃圾」最难查。
fn check_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("地址要以 https:// 或 http:// 开头".into());
    }
    let tail = url.rsplit('/').next().unwrap_or("");
    if tail.is_empty() || !tail.contains('.') {
        return Err("地址要指到一个文件，比如 https://dav.example.com/dav/az-term.json".into());
    }
    Ok(())
}

fn agent() -> ureq::Agent {
    // 不跟重定向。ureq 跟 301/302 时会把 PUT 改成 GET、丢掉 body、剥掉认证头，
    // 307/308 则把 3xx 响应原样当成功返回 —— 地址填了 http://、前面又是自动跳 https
    // 的反代时，界面会说"传上去了"而网盘上什么都没有。3xx 一律当错误明说
    ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build()
}

/// 服务器要求跳转：告诉用户该改地址，而不是替他跳过去
fn redirected(response: &ureq::Response) -> String {
    let to = response.header("Location").unwrap_or("别的地址");
    format!(
        "服务器要求跳转到 {to}（{}）—— 多半是地址该用 https://，或者路径少了什么。这儿不跟着跳，请把地址改成它要的那个",
        response.status()
    )
}

/// 把错误说成人话。ureq 的原话对着用户没什么用。
fn explain(url: &str, e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "账号或密码不对（服务器回了 401）".into(),
        ureq::Error::Status(403, _) => "服务器不让访问这个路径（403）—— 检查一下权限和路径".into(),
        ureq::Error::Status(404, _) => "这个路径不存在（404）—— 上级目录得先建好，WebDAV 不会自动建".into(),
        ureq::Error::Status(405, _) => "服务器不接受这个方法（405）—— 这个地址多半不是 WebDAV".into(),
        ureq::Error::Status(507, _) => "网盘空间满了（507）".into(),
        ureq::Error::Status(code, _) => format!("服务器回了 {code}"),
        ureq::Error::Transport(inner) => {
            let http = url.starts_with("http://");
            format!(
                "连不上：{inner}{}",
                if http { "（地址是 http://，确认一下这个服务真的开在明文端口上）" } else { "" }
            )
        }
    }
}

/// 上传。内容必须已经是加密过的（前端负责，见模块头）。
#[tauri::command]
pub async fn sync_put(url: String, username: String, password: String, body: String) -> Result<(), String> {
    check_url(&url)?;
    if body.len() > MAX_BODY {
        return Err("要传的东西太大了，检查一下是不是选错了内容".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut req = agent().put(url.trim());
        if !username.is_empty() {
            req = req.set("Authorization", &basic_auth(&username, &password));
        }
        let response = req
            .set("Content-Type", "application/json; charset=utf-8")
            .send_string(&body)
            .map_err(|e| explain(&url, e))?;
        match response.status() {
            200 | 201 | 204 => Ok(()),
            300..=399 => Err(redirected(&response)),
            code => Err(format!("服务器回了 {code}，没当成功")),
        }
    })
    .await
    .map_err(|e| format!("任务没跑起来：{e}"))?
}

/// 下载。文件不存在（404）不算错误 —— 第一次同步本来就没有。
#[tauri::command]
pub async fn sync_get(url: String, username: String, password: String) -> Result<Fetched, String> {
    check_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut req = agent().get(url.trim());
        if !username.is_empty() {
            req = req.set("Authorization", &basic_auth(&username, &password));
        }
        match req.call() {
            Ok(response) if (300..400).contains(&response.status()) => Err(redirected(&response)),
            Ok(response) => {
                // 限一下读回来的量：地址填错时 GET 回来的可能是个几十 MB 的页面
                let mut buf = String::new();
                response
                    .into_reader()
                    .take(MAX_BODY as u64 + 1)
                    .read_to_string(&mut buf)
                    .map_err(|e| format!("读不回来：{e}"))?;
                if buf.len() > MAX_BODY {
                    return Err("服务器回来的东西太大了 —— 这个地址多半不是那个备份文件".into());
                }
                Ok(Fetched { content: Some(buf) })
            }
            // 头一次同步时服务器上还没有这个文件，这不是错
            Err(ureq::Error::Status(404, _)) => Ok(Fetched { content: None }),
            Err(e) => Err(explain(&url, e)),
        }
    })
    .await
    .map_err(|e| format!("任务没跑起来：{e}"))?
}

/// Basic 认证头。自己拼是因为 ureq 的 `auth()` 在 2.x 里对非 ASCII 用户名处理不一致，
/// 而网盘的用户名常常是邮箱、偶尔带中文。
fn basic_auth(username: &str, password: &str) -> String {
    use data_encoding::BASE64;
    format!("Basic {}", BASE64.encode(format!("{username}:{password}").as_bytes()))
}

/// WebDAV 的账号密码存钥匙串，跟 SSH 的凭据一个地方，不落我们的配置文件
#[tauri::command]
pub fn sync_save_password(password: String) {
    crate::creds::save("webdav", &password);
}

#[tauri::command]
pub fn sync_has_password() -> bool {
    crate::creds::load("webdav").is_some()
}

/// 取出来只在 Rust 侧用，不回传前端 —— 跟 SSH 凭据一个规矩
pub(crate) fn stored_password() -> String {
    crate::creds::load("webdav").unwrap_or_default()
}

/// 前端不传密码时用存着的那个
#[tauri::command]
pub async fn sync_put_saved(url: String, username: String, body: String) -> Result<(), String> {
    sync_put(url, username, stored_password(), body).await
}

#[tauri::command]
pub async fn sync_get_saved(url: String, username: String) -> Result<Fetched, String> {
    sync_get(url, username, stored_password()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_must_point_at_a_file() {
        assert!(check_url("https://dav.jianguoyun.com/dav/az-term.json").is_ok());
        assert!(check_url("http://192.168.1.9:5005/dav/backup.json").is_ok());
        // 指到目录：PUT 会出怪事，GET 回来是个 HTML 列表
        assert!(check_url("https://dav.example.com/dav/").is_err());
        assert!(check_url("https://dav.example.com/dav").is_err());
        // 不是 URL
        assert!(check_url("dav.example.com/x.json").is_err());
        assert!(check_url("").is_err());
    }

    #[test]
    fn basic_auth_is_base64_of_user_colon_pass() {
        // RFC 7617 的例子
        assert_eq!(basic_auth("Aladdin", "open sesame"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
        // 邮箱当用户名（网盘常见）
        assert_eq!(basic_auth("a@b.com", "pw"), "Basic YUBiLmNvbTpwdw==");
    }
}
