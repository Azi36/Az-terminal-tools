//! 加密导出：给备份文件套一个口令。
//!
//! 备份里**本来就没有密码**（那些在系统钥匙串里，见 `creds.rs`）。
//! 但主机名、用户名、跳板机链路、内网端口这些本身就是情报 —— 一份明文 JSON
//! 掉在网盘或者聊天记录里，等于把整张内网地图递出去。
//!
//! 用法是标准组装，不自己发明算法：
//! - **Argon2id** 把口令拉成 32 字节密钥。选它是因为它对着显卡和专用硬件也贵，
//!   人能记住的口令扛不住 PBKDF2 那种便宜的迭代。
//! - **XChaCha20-Poly1305** 负责加解密。24 字节的随机 nonce 长到可以直接随机取，
//!   不用维护计数器；Poly1305 那部分顺带保证文件被改过一个字节就解不开，
//!   而不是解出一堆看着像样的垃圾。
//!
//! 外层是个自描述的 JSON 信封，所以导入时一眼认得出这是加密的还是明文的，
//! 不用靠扩展名猜。

use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng};
use chacha20poly1305::{AeadCore, XChaCha20Poly1305, XNonce};
use data_encoding::BASE64;

/// 信封的标记：导入时靠它认出「这份是加密的」
const KIND: &str = "argon2id-xchacha20poly1305";

#[derive(serde::Serialize, serde::Deserialize)]
struct Envelope {
    app: String,
    /// 固定是 KIND，将来换算法就靠它分辨
    enc: String,
    v: u32,
    salt: String,
    nonce: String,
    data: String,
}

/// 口令 + 盐 → 32 字节密钥
fn derive(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("口令处理失败：{e}"))?;
    Ok(key)
}

/// 明文 → 信封（一段 JSON 文本，可以直接当文本文件写出去）
#[tauri::command]
pub fn vault_seal(plaintext: String, passphrase: String) -> Result<String, String> {
    if passphrase.chars().count() < 8 {
        return Err("口令太短了，至少 8 个字符".into());
    }
    // 盐每次都新取：同一个口令导出两次，密文也该是不一样的
    let mut salt = [0u8; 16];
    getrandom(&mut salt)?;
    let key = derive(&passphrase, &salt)?;

    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| format!("初始化失败：{e}"))?;
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| "加密失败".to_string())?;

    let envelope = Envelope {
        app: "az-term".into(),
        enc: KIND.into(),
        v: 1,
        salt: BASE64.encode(&salt),
        nonce: BASE64.encode(nonce.as_slice()),
        data: BASE64.encode(&sealed),
    };
    serde_json::to_string_pretty(&envelope).map_err(|e| format!("写不出来：{e}"))
}

/// 信封 → 明文
#[tauri::command]
pub fn vault_open(sealed: String, passphrase: String) -> Result<String, String> {
    let envelope: Envelope = serde_json::from_str(&sealed).map_err(|_| "这不是一份加密的备份".to_string())?;
    if envelope.enc != KIND {
        return Err(format!("不认识的加密方式：{}", envelope.enc));
    }
    let salt = BASE64.decode(envelope.salt.as_bytes()).map_err(|_| "文件损坏（salt）".to_string())?;
    let nonce = BASE64.decode(envelope.nonce.as_bytes()).map_err(|_| "文件损坏（nonce）".to_string())?;
    let data = BASE64.decode(envelope.data.as_bytes()).map_err(|_| "文件损坏（data）".to_string())?;
    if nonce.len() != 24 {
        return Err("文件损坏（nonce 长度不对）".into());
    }

    let key = derive(&passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| format!("初始化失败：{e}"))?;
    // 解不开有两种可能：口令错了，或者文件被改过。密码学上分不出来，
    // 界面上也不该假装分得出来 —— 两种都得让人重新拿一份可信的文件。
    let plain = cipher
        .decrypt(XNonce::from_slice(&nonce), data.as_ref())
        .map_err(|_| "口令不对，或者这个文件被改过".to_string())?;
    String::from_utf8(plain).map_err(|_| "解出来的不是文本，文件可能坏了".into())
}

/// 这段文本是不是一份加密备份 —— 导入时先问一句，好决定要不要弹口令框
#[tauri::command]
pub fn vault_is_sealed(text: String) -> bool {
    serde_json::from_str::<Envelope>(&text).map(|one| one.enc == KIND).unwrap_or(false)
}

fn getrandom(buf: &mut [u8]) -> Result<(), String> {
    use chacha20poly1305::aead::rand_core::RngCore;
    OsRng.try_fill_bytes(buf).map_err(|e| format!("取随机数失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let sealed = vault_seal("{\"app\":\"az-term\"}".into(), "correct horse battery".into()).unwrap();
        // 信封是 JSON，认得出是加密的
        assert!(vault_is_sealed(sealed.clone()));
        // 明文不该在密文里露脸
        assert!(!sealed.contains("az-term\\\""));
        let back = vault_open(sealed, "correct horse battery".into()).unwrap();
        assert_eq!(back, "{\"app\":\"az-term\"}");
    }

    #[test]
    fn wrong_passphrase_is_refused() {
        let sealed = vault_seal("秘密内容".into(), "passphrase-1".into()).unwrap();
        assert!(vault_open(sealed, "passphrase-2".into()).is_err());
    }

    #[test]
    fn tampering_is_caught() {
        let sealed = vault_seal("秘密内容".into(), "passphrase-1".into()).unwrap();
        let mut envelope: Envelope = serde_json::from_str(&sealed).unwrap();
        // 把密文改一个字节：Poly1305 那部分就是干这个的，必须解不开
        let mut raw = BASE64.decode(envelope.data.as_bytes()).unwrap();
        raw[0] ^= 0x01;
        envelope.data = BASE64.encode(&raw);
        let broken = serde_json::to_string(&envelope).unwrap();
        assert!(vault_open(broken, "passphrase-1".into()).is_err());
    }

    #[test]
    fn same_input_seals_differently_each_time() {
        // 盐和 nonce 每次都新取，同一份内容导出两次密文不该一样
        let a = vault_seal("同样的内容".into(), "passphrase-1".into()).unwrap();
        let b = vault_seal("同样的内容".into(), "passphrase-1".into()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn short_passphrase_is_refused() {
        assert!(vault_seal("x".into(), "1234567".into()).is_err());
        assert!(vault_seal("x".into(), "12345678".into()).is_ok());
    }

    #[test]
    fn plain_json_is_not_mistaken_for_sealed() {
        assert!(!vault_is_sealed("{\"app\":\"az-term\",\"connections\":[]}".into()));
        assert!(!vault_is_sealed("不是 JSON".into()));
    }
}
