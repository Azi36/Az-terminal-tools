//! 主机指纹校验（known_hosts）。
//!
//! 用的是 OpenSSH 标准文件 `~/.ssh/known_hosts`，跟系统 ssh 命令共用一份记录，
//! 你在别处 ssh 过的机器这里直接认，这里认过的机器 ssh 命令也认。
//!
//! 既然是共用的文件，删行就必须按 OpenSSH 的规矩来：
//! 哈希过的 `|1|salt|hash`、`host,1.2.3.4` 这种一行多主机、`*.example.com` 通配、
//! `!host` 否定、`@cert-authority` 标记，全都要认得出来 —— 认不出来就会出现
//! 「点了更新指纹但旧行还在」导致永远连不上，或者「删 host:2222 顺手把 host:22 也删了」。
//!
//! 写回一律走临时文件 + rename，中途崩了也不会把用户的 known_hosts 写成半截。

use std::path::{Path, PathBuf};

use data_encoding::BASE64_MIME;
use hmac::{Hmac, Mac};
use russh::keys::key::PublicKey;
use sha1::Sha1;

use crate::ssh::SshError;

/// 校验结果
pub enum HostVerdict {
    /// 记录过而且对得上
    Known,
    /// 没见过这台
    Unknown { algo: String, fingerprint: String },
    /// 见过，但指纹变了 —— 要么服务器重装了，要么有人在中间
    Changed { algo: String, fingerprint: String },
}

/// `~/.ssh/known_hosts`（russh 自带的 Windows 路径拼错成 `~/ssh`，所以自己拼）
pub fn known_hosts_file() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

/// OpenSSH 记这台机器时用的名字：22 端口就是裸主机名，其它端口是 `[host]:port`
pub(crate) fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// 一行 known_hosts 拆开的样子
struct HostLine<'a> {
    /// 逗号分隔的主机模式列表，或者 `|1|salt|hash`
    patterns: &'a str,
}

/// 拆一行：跳过空行、注释，认得 `@cert-authority` / `@revoked` 前缀
fn parse_line(raw: &str) -> Option<HostLine<'_>> {
    let line = raw.trim_end_matches(['\r', '\n']).trim_start();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut fields = line.split_whitespace();
    let mut first = fields.next()?;
    // `@cert-authority host ssh-rsa ...` —— 标记后面才是主机模式
    if first.starts_with('@') {
        first = fields.next()?;
    }
    // 至少还要有算法和公钥两段，否则这行不是一条主机记录
    fields.next()?;
    fields.next()?;
    Some(HostLine { patterns: first })
}

/// OpenSSH 的通配匹配：`*` 任意长，`?` 单个字符
fn glob_match(pattern: &str, text: &str) -> bool {
    if !pattern.contains(['*', '?']) {
        return pattern == text;
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    // 经典的双指针回溯，够用且不会爆栈
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// 哈希条目 `|1|salt|hash`：HMAC-SHA1(salt, 主机名) 对得上就算命中
fn hashed_match(entry: &str, host_port: &str) -> bool {
    let mut parts = entry.split('|').skip(2);
    let Some(Ok(salt)) = parts.next().map(|p| BASE64_MIME.decode(p.as_bytes())) else {
        return false;
    };
    let Some(Ok(hash)) = parts.next().map(|p| BASE64_MIME.decode(p.as_bytes())) else {
        return false;
    };
    let Ok(mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.chain_update(host_port).verify_slice(&hash).is_ok()
}

/// 这一行的主机模式认不认 `host_port`（`!pattern` 否定优先，跟 OpenSSH 一致）
fn matches_host(patterns: &str, host_port: &str) -> bool {
    let mut hit = false;
    for entry in patterns.split(',') {
        if entry.is_empty() {
            continue;
        }
        if let Some(negated) = entry.strip_prefix('!') {
            if glob_match(negated, host_port) {
                return false;
            }
            continue;
        }
        if entry.starts_with("|1|") {
            if hashed_match(entry, host_port) {
                hit = true;
            }
            continue;
        }
        if glob_match(entry, host_port) {
            hit = true;
        }
    }
    hit
}

pub fn verify(host: &str, port: u16, key: &PublicKey) -> HostVerdict {
    let algo = key.name().to_string();
    let fingerprint = fingerprint_of(key);
    let Some(path) = known_hosts_file() else {
        return HostVerdict::Unknown { algo, fingerprint };
    };

    match russh::keys::check_known_hosts_path(host, port, key, &path) {
        Ok(true) => HostVerdict::Known,
        Ok(false) => HostVerdict::Unknown { algo, fingerprint },
        // KeyChanged 之外的错（文件不存在之类）都当没见过处理
        Err(russh::keys::Error::KeyChanged { .. }) => HostVerdict::Changed { algo, fingerprint },
        Err(_) => HostVerdict::Unknown { algo, fingerprint },
    }
}

/// 指纹的标准写法，跟 `ssh-keygen -lf` 一致
pub(crate) fn fingerprint_of(key: &PublicKey) -> String {
    format!("SHA256:{}", key.fingerprint())
}

/// 用户点了「信任」→ 写进 known_hosts；指纹变了的情况先把旧记录删掉
pub fn trust(host: &str, port: u16, key: &PublicKey, replace: bool) -> Result<(), SshError> {
    let path = known_hosts_file().ok_or_else(|| SshError::plain("找不到用户目录，写不了 known_hosts"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| SshError::new("建不了 .ssh 目录", e))?;
    }
    if replace && path.exists() {
        drop_lines(&path, host, port)?;
    }
    russh::keys::learn_known_hosts_path(host, port, key, &path)
        .map_err(|e| SshError::new("写 known_hosts 失败", e))
}

/// 删掉某台主机的记录行（只删真正命中这台 + 这个端口的，别的一行不动）
fn drop_lines(path: &Path, host: &str, port: u16) -> Result<(), SshError> {
    let text = std::fs::read_to_string(path).map_err(|e| SshError::new("读不了 known_hosts", e))?;
    let target = host_pattern(host, port);

    let mut kept: Vec<&str> = Vec::new();
    let mut removed = 0usize;
    for raw in text.split('\n') {
        let drop = parse_line(raw).is_some_and(|line| matches_host(line.patterns, &target));
        if drop {
            removed += 1;
        } else {
            kept.push(raw);
        }
    }
    if removed == 0 {
        return Ok(());
    }

    // split('\n') 会在末尾多出一个空段，join 回去正好还原原来的结尾
    write_atomic(path, &kept.join("\n"))
}

/// 临时文件 + rename：写一半崩了也不会毁掉用户跟系统 ssh 共用的这份记录
fn write_atomic(path: &Path, content: &str) -> Result<(), SshError> {
    let tmp = path.with_extension("az-tmp");
    std::fs::write(&tmp, content).map_err(|e| SshError::new("写 known_hosts 失败", e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        SshError::new("替换 known_hosts 失败", e)
    })
}

/// 忘掉某台主机的指纹记录
#[tauri::command]
pub fn hosts_forget(host: String, port: u16) -> Result<(), SshError> {
    let path = known_hosts_file().ok_or_else(|| SshError::plain("找不到用户目录"))?;
    if !path.exists() {
        return Ok(());
    }
    drop_lines(&path, &host, port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_bracketed_patterns() {
        assert!(matches_host("example.com", "example.com"));
        assert!(!matches_host("example.com", "[example.com]:2222"));
        assert!(matches_host("[example.com]:2222", "[example.com]:2222"));
        // 换个端口就是另一条记录，不该被牵连删掉
        assert!(!matches_host("[example.com]:2222", "example.com"));
    }

    #[test]
    fn comma_separated_host_and_ip() {
        assert!(matches_host("example.com,10.0.0.5", "example.com"));
        assert!(matches_host("example.com,10.0.0.5", "10.0.0.5"));
        assert!(!matches_host("example.com,10.0.0.5", "other.com"));
    }

    #[test]
    fn wildcards_and_negation() {
        assert!(matches_host("*.example.com", "a.example.com"));
        assert!(matches_host("10.0.0.?", "10.0.0.5"));
        assert!(!matches_host("*.example.com,!bad.example.com", "bad.example.com"));
    }

    #[test]
    fn hashed_entry_matches() {
        // 自己按 OpenSSH 的算法造一条哈希记录，再确认能认出来
        let salt = [7u8; 20];
        let mac = Hmac::<Sha1>::new_from_slice(&salt).unwrap();
        let hash = mac.chain_update("example.com").finalize().into_bytes();
        let entry = format!(
            "|1|{}|{}",
            BASE64_MIME.encode(&salt).replace(['\r', '\n'], ""),
            BASE64_MIME.encode(&hash).replace(['\r', '\n'], "")
        );
        assert!(matches_host(&entry, "example.com"));
        assert!(!matches_host(&entry, "other.com"));
    }

    #[test]
    fn comments_and_markers() {
        assert!(parse_line("# just a comment").is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("example.com ssh-ed25519 AAAA").is_some());
        // 带标记的行，主机模式在标记后面
        let line = parse_line("@cert-authority *.example.com ssh-rsa AAAA").unwrap();
        assert!(matches_host(line.patterns, "a.example.com"));
    }

    /// 删行只碰命中的那些，注释、别的主机、别的端口都得原样留着
    #[test]
    fn drop_lines_keeps_everything_else() {
        let dir = std::env::temp_dir().join("az-term-hosts-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        std::fs::write(
            &path,
            "# 注释\n\
             example.com ssh-ed25519 AAAAOLD\n\
             [example.com]:2222 ssh-ed25519 AAAAPORT\n\
             other.com,10.0.0.5 ssh-rsa AAAAOTHER\n",
        )
        .unwrap();

        drop_lines(&path, "example.com", 22).unwrap();
        let left = std::fs::read_to_string(&path).unwrap();
        assert!(left.contains("# 注释"));
        assert!(!left.contains("AAAAOLD"));
        assert!(left.contains("AAAAPORT"), "别的端口不该被删");
        assert!(left.contains("AAAAOTHER"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
