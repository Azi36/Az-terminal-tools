//! 读 `~/.ssh/config`，把里面的 Host 块捞出来给「导入」用。
//!
//! 很多人手里的服务器清单本来就在这个文件里，让他重新敲一遍是没道理的。
//! 只读不写 —— 我们不碰用户的 ssh 配置。
//!
//! 认得的字段：HostName / User / Port / IdentityFile，外加 Include。
//! 通配的 Host（`Host *`、`Host *.dev`）不算服务器，跳过。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::ssh::SshError;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    /// Host 后面写的那个别名，拿来当连接名字
    pub alias: String,
    /// HostName，没写就退回用别名
    pub host: String,
    pub user: String,
    pub port: u16,
    pub key_path: Option<String>,
}

fn ssh_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(PathBuf::from(home).join(".ssh"))
}

/// `~` 开头的路径展开成绝对路径，其余原样
fn expand(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            return PathBuf::from(home).join(rest).to_string_lossy().to_string();
        }
    }
    trimmed.to_string()
}

/// 拆一行：`Key value`、`Key=value` 两种写法都认，键不区分大小写
fn split_kv(line: &str) -> Option<(String, String)> {
    let text = line.trim();
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let at = text.find(['=', ' ', '\t'])?;
    let (key, value) = (&text[..at], text[at + 1..].trim_start_matches(['=', ' ', '\t']));
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some((key.to_ascii_lowercase(), value.to_string()))
}

/// 通配的 Host 是给「一类机器」配默认值的，不是一台真机器
fn is_pattern(alias: &str) -> bool {
    alias.contains(['*', '?', '!'])
}

/// 读一个配置文件，Include 进来的也一并读（防着互相 include 转圈，限层数）
fn read_into(path: &Path, out: &mut Vec<ConfigHost>, seen: &mut HashSet<PathBuf>, depth: usize) {
    if depth > 4 || !seen.insert(path.to_path_buf()) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else { return };

    // 当前正在攒的那些别名（一行 Host 可以写好几个别名，它们共用下面的设置）
    let mut current: Vec<usize> = Vec::new();
    // Match 块里的设置是有条件的，我们不去猜条件，直接不认
    let mut in_match = false;

    for line in text.lines() {
        let Some((key, value)) = split_kv(line) else { continue };
        match key.as_str() {
            "host" => {
                in_match = false;
                current.clear();
                for alias in value.split_whitespace() {
                    if is_pattern(alias) {
                        continue;
                    }
                    current.push(out.len());
                    out.push(ConfigHost {
                        alias: alias.to_string(),
                        host: alias.to_string(),
                        user: String::new(),
                        port: 22,
                        key_path: None,
                    });
                }
            }
            "match" => {
                in_match = true;
                current.clear();
            }
            "include" => {
                if in_match {
                    continue;
                }
                for piece in value.split_whitespace() {
                    let target = expand(piece);
                    let full = if Path::new(&target).is_absolute() {
                        PathBuf::from(&target)
                    } else {
                        match ssh_dir() {
                            Some(dir) => dir.join(&target),
                            None => continue,
                        }
                    };
                    // Include 允许写通配；只支持最后一段带 *，够覆盖 `Include config.d/*`
                    if target.contains('*') {
                        let Some(parent) = full.parent() else { continue };
                        let Ok(entries) = std::fs::read_dir(parent) else { continue };
                        let mut files: Vec<PathBuf> =
                            entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
                        files.sort();
                        for file in files {
                            read_into(&file, out, seen, depth + 1);
                        }
                    } else if full.is_file() {
                        read_into(&full, out, seen, depth + 1);
                    }
                }
            }
            "hostname" | "user" | "port" | "identityfile" => {
                if in_match || current.is_empty() {
                    continue;
                }
                for &at in &current {
                    let entry = &mut out[at];
                    match key.as_str() {
                        // ssh 的规矩是「先写的赢」，后面重复的不覆盖前面的
                        "hostname" if entry.host == entry.alias => entry.host = value.clone(),
                        "user" if entry.user.is_empty() => entry.user = value.clone(),
                        "port" if entry.port == 22 => {
                            if let Ok(port) = value.parse::<u16>() {
                                entry.port = port;
                            }
                        }
                        "identityfile" if entry.key_path.is_none() => entry.key_path = Some(expand(&value)),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

/// 把 `~/.ssh/config` 里的服务器读出来
#[tauri::command(async)]
pub fn ssh_config_hosts() -> Result<Vec<ConfigHost>, SshError> {
    let path = ssh_dir()
        .map(|dir| dir.join("config"))
        .ok_or_else(|| SshError::plain("找不到用户目录"))?;
    if !path.exists() {
        return Err(SshError::plain("这台机器上没有 ~/.ssh/config"));
    }
    let mut out = Vec::new();
    read_into(&path, &mut out, &mut HashSet::new(), 0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试之间是并发跑的，每个用自己的文件，别互相踩
    fn parse(tag: &str, text: &str) -> Vec<ConfigHost> {
        let dir = std::env::temp_dir().join("az-term-sshconfig-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("config-{tag}"));
        std::fs::write(&path, text).unwrap();
        let mut out = Vec::new();
        read_into(&path, &mut out, &mut HashSet::new(), 0);
        std::fs::remove_file(&path).ok();
        out
    }

    #[test]
    fn reads_a_normal_block() {
        let hosts = parse(
            "normal",
            "Host web1\n\
             \tHostName 10.0.0.9\n\
             \tUser deploy\n\
             \tPort 2222\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "web1");
        assert_eq!(hosts[0].host, "10.0.0.9");
        assert_eq!(hosts[0].user, "deploy");
        assert_eq!(hosts[0].port, 2222);
    }

    #[test]
    fn one_line_many_aliases() {
        let hosts = parse("aliases", "Host a b\n  HostName 1.2.3.4\n  User root\n");
        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().all(|one| one.host == "1.2.3.4" && one.user == "root"));
    }

    #[test]
    fn skips_wildcards_and_match_blocks() {
        let hosts = parse(
            "wildcards",
            "Host *\n  User nobody\n\
             Host real\n  HostName 5.6.7.8\n\
             Match host bar\n  User sneaky\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real");
        // Match 块里的 User 不该粘到上一个 Host 上
        assert_eq!(hosts[0].user, "");
    }

    #[test]
    fn equals_form_and_comments() {
        let hosts = parse("equals", "# 注释\nHost=box\n  HostName=192.168.1.2\n  Port=22\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].host, "192.168.1.2");
    }

    #[test]
    fn first_value_wins() {
        let hosts = parse("dup", "Host dup\n  User first\n  User second\n");
        assert_eq!(hosts[0].user, "first");
    }
}
