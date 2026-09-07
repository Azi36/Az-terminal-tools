//! 本地终端旁边的 git 面板要的信息：分支、领先落后、改动列表、最近提交、分支列表、stash 数。
//!
//! 全部靠调 `git` 命令行拿，不自己读 .git —— 这样用户装的是什么版本、配了什么 hook，
//! 看到的就是什么，跟他在终端里敲出来的一致。操作（pull / push / checkout）不在这儿做，
//! 面板只是把命令送进终端，让用户看到真实输出。

use std::process::Command;

use crate::ssh::SshError;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// `git status --porcelain` 的两位状态码（" M"、"??"、"A "……）
    pub status: String,
    pub path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub subject: String,
    /// "3 hours ago" 这种相对时间，git 自己给的
    pub when: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub root: String,
    pub branch: String,
    /// 游离 HEAD：branch 里放的是短哈希
    pub detached: bool,
    pub ahead: u32,
    pub behind: u32,
    /// 有没有跟踪的远程分支
    pub upstream: bool,
    pub changes: Vec<GitChange>,
    /// 改动太多只列了前面一部分
    pub truncated: bool,
    pub commits: Vec<GitCommit>,
    pub branches: Vec<String>,
    pub stashes: u32,
}

const MAX_CHANGES: usize = 200;

fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    // quotepath=false：非 ASCII 路径别转义成 \346\226\207；color 关掉，免得解析到转义码
    cmd.args(["-c", "core.quotepath=false", "-c", "color.ui=never"]).args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 别闪一个黑色控制台窗口
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { "这台机器上找不到 git（不在 PATH 里）".to_string() } else { format!("{e}") }
    })?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `git status -b --porcelain` 的第一行：`## main...origin/main [ahead 1, behind 2]`
/// 也可能是 `## HEAD (no branch)`、`## No commits yet on main`、`## main`（没上游）
fn parse_head(line: &str) -> (String, bool, u32, u32, bool) {
    let line = line.trim_start_matches("## ").trim();
    if let Some(rest) = line.strip_prefix("HEAD (no branch)") {
        let _ = rest;
        return (String::new(), true, 0, 0, false);
    }
    if let Some(name) = line.strip_prefix("No commits yet on ") {
        return (name.trim().to_string(), false, 0, 0, false);
    }
    let (name, tail) = match line.split_once("...") {
        Some((name, tail)) => (name.to_string(), Some(tail)),
        None => (line.split(' ').next().unwrap_or("").to_string(), None),
    };
    let mut ahead = 0;
    let mut behind = 0;
    let mut upstream = tail.is_some();
    if let Some(tail) = tail {
        if tail.contains("[gone]") {
            upstream = false;
        }
        if let Some(start) = tail.find('[') {
            let inside = tail[start + 1..].trim_end_matches(']');
            for part in inside.split(',') {
                let part = part.trim();
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.trim().parse().unwrap_or(0);
                }
            }
        }
    }
    (name, false, ahead, behind, upstream)
}

fn parse_status(text: &str) -> (String, bool, u32, u32, bool, Vec<GitChange>, bool) {
    let mut lines = text.lines();
    let head = lines.next().unwrap_or("");
    let (branch, detached, ahead, behind, upstream) = parse_head(head);
    let mut changes = Vec::new();
    let mut truncated = false;
    for line in lines {
        if line.len() < 3 {
            continue;
        }
        if changes.len() >= MAX_CHANGES {
            truncated = true;
            break;
        }
        let (status, path) = line.split_at(2);
        changes.push(GitChange { status: status.to_string(), path: path.trim_start().to_string() });
    }
    (branch, detached, ahead, behind, upstream, changes, truncated)
}

/// 这个目录在不在 git 仓库里；不在（或者机器上没装 git）返回 None，不算错误
#[tauri::command(async)]
pub fn git_info(cwd: String) -> Result<Option<GitInfo>, SshError> {
    let cwd = cwd.trim();
    if cwd.is_empty() || !std::path::Path::new(cwd).is_dir() {
        return Ok(None);
    }
    // 只有「不是仓库」才算 None；git 没装、没权限之类的要明说，不然面板一直显示「不是仓库」让人摸不着头脑
    let root = match run(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(text) => text.trim().to_string(),
        Err(e) if e.contains("not a git repository") => return Ok(None),
        Err(e) => return Err(SshError::plain(&format!("git 跑不了：{e}"))),
    };
    let status = run(cwd, &["status", "--porcelain=v1", "-b", "--untracked-files=normal"])
        .map_err(|e| SshError::plain(&format!("git status 跑不了：{e}")))?;
    let (mut branch, detached, ahead, behind, upstream, changes, truncated) = parse_status(&status);
    if detached {
        branch = run(cwd, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    }
    // 新仓库一个提交都没有时 log 会报错，那就是空列表
    let commits = run(cwd, &["log", "-n", "15", "--pretty=format:%h%x1f%s%x1f%ar"])
        .map(|text| {
            text.lines()
                .filter_map(|line| {
                    let mut parts = line.split('\x1f');
                    Some(GitCommit {
                        hash: parts.next()?.to_string(),
                        subject: parts.next().unwrap_or("").to_string(),
                        when: parts.next().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let branches = run(cwd, &["branch", "--list", "--format=%(refname:short)"])
        .map(|text| text.lines().map(str::trim).filter(|s| !s.is_empty()).take(100).map(String::from).collect())
        .unwrap_or_default();
    let stashes = run(cwd, &["stash", "list", "--format=%gd"])
        .map(|text| text.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);
    Ok(Some(GitInfo { root, branch, detached, ahead, behind, upstream, changes, truncated, commits, branches, stashes }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这个仓库本身就是个 git 仓库，拿它验一下整条链路能跑通
    #[test]
    fn this_repo_is_recognised() {
        let here = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
        let info = git_info(here.to_string()).expect("git 命令要能跑");
        let info = info.expect("这儿该是个仓库");
        assert!(!info.branch.is_empty() || info.detached);
        assert!(!info.commits.is_empty());
        assert!(info.branches.iter().any(|b| b == "main"));
    }

    #[test]
    fn head_line_variants() {
        assert_eq!(parse_head("## main...origin/main [ahead 2, behind 1]"), ("main".into(), false, 2, 1, true));
        assert_eq!(parse_head("## main...origin/main"), ("main".into(), false, 0, 0, true));
        assert_eq!(parse_head("## feature/x"), ("feature/x".into(), false, 0, 0, false));
        assert_eq!(parse_head("## main...origin/main [gone]"), ("main".into(), false, 0, 0, false));
        assert_eq!(parse_head("## HEAD (no branch)").1, true);
        assert_eq!(parse_head("## No commits yet on main").0, "main");
    }

    #[test]
    fn status_lines_keep_code_and_path() {
        let text = "## main\n M src/a.rs\n?? 新文件.txt\nR  old -> new\n";
        let (_, _, _, _, _, changes, truncated) = parse_status(text);
        assert!(!truncated);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].status, " M");
        assert_eq!(changes[0].path, "src/a.rs");
        assert_eq!(changes[1].status, "??");
        assert_eq!(changes[1].path, "新文件.txt");
        assert_eq!(changes[2].path, "old -> new");
    }
}
