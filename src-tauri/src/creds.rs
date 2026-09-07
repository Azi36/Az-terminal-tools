//! 凭据保管：密码 / 私钥密码短语存进**系统钥匙串**
//! （Windows 凭据管理器 / macOS 钥匙串），我们自己的配置文件里一个字节明文都没有。
//!
//! 前端永远拿不到已保存的凭据——它只能问「有没有存过」，
//! 真正的取用在 Rust 侧连接时完成，密码不回传 webview。

use crate::ssh::SshError;

const SERVICE: &str = "Az-term";

fn entry(conn_id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, conn_id).ok()
}

/// 连接时取用；没存过或钥匙串不可用都返回 None
pub(crate) fn load(conn_id: &str) -> Option<String> {
    let secret = entry(conn_id)?.get_password().ok()?;
    if secret.is_empty() { None } else { Some(secret) }
}

/// 认证成功后才存，省得把打错的密码存进去
pub(crate) fn save(conn_id: &str, secret: &str) {
    if secret.is_empty() {
        return;
    }
    if let Some(entry) = entry(conn_id) {
        let _ = entry.set_password(secret);
    }
}

/// 前端问：这条连接记过密码没有
#[tauri::command(async)]
pub fn creds_has(conn_id: String) -> bool {
    load(&conn_id).is_some()
}

/// 忘掉这条连接的凭据
#[tauri::command(async)]
pub fn creds_forget(conn_id: String) -> Result<(), SshError> {
    let Some(entry) = entry(&conn_id) else {
        return Ok(());
    };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // 本来就没存过，当成功处理
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SshError::new("钥匙串删不掉这条凭据", e)),
    }
}
