//! 本地文件系统：给 SFTP 面板的左半边用，和远程共用一套目录项形状。
//! 只读列目录 + 建目录 / 改名 / 删除，全部限本机，不联网。
//!
//! 命令一律 `#[tauri::command(async)]`：不加的话同步命令跑在主线程，
//! 删几十 GB 的目录、列几十万文件、探测一个断掉的映射网络盘，窗口都会卡成「未响应」。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::sftp::{sort_entries, to_text, Entry, Listing, TextFile, MAX_EDIT_BYTES};
use crate::ssh::SshError;

/// 去掉 Windows 规范化后的 `\\?\` 前缀，路径栏里好看。
/// 网络共享规范化后是 `\\?\UNC\server\share`，光剥前缀会剩下 `UNC\server\share` 这种
/// 相对路径，得还原成 `\\server\share`。
fn pretty(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").map(|t| t.to_string()).unwrap_or(s)
}

/// 用户主目录
#[tauri::command(async)]
pub fn local_home() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .canonicalize()
        .map(|p| pretty(&p))
        .unwrap_or_else(|_| ".".to_string())
}

/// Windows 盘符列表（其它平台返回根目录）
#[tauri::command(async)]
pub fn local_drives() -> Vec<String> {
    if cfg!(windows) {
        ('A'..='Z')
            .map(|c| format!("{c}:\\"))
            .filter(|p| Path::new(p).exists())
            .collect()
    } else {
        vec!["/".to_string()]
    }
}

/// 路径下拉里的「此电脑」：常用位置 + 所有盘符
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub label: String,
    pub path: String,
    /// "home" | "folder" | "drive"
    pub kind: &'static str,
}

#[tauri::command(async)]
pub fn local_places() -> Vec<Place> {
    let home = local_home();
    let mut places = vec![Place { label: "主目录".into(), path: home.clone(), kind: "home" }];

    // 常见子目录，存在才列（英文名和中文系统都按实际目录判断）
    for (label, name) in [
        ("桌面", "Desktop"),
        ("下载", "Downloads"),
        ("文档", "Documents"),
        ("图片", "Pictures"),
    ] {
        let path = PathBuf::from(&home).join(name);
        if path.is_dir() {
            places.push(Place { label: label.into(), path: pretty(&path), kind: "folder" });
        }
    }

    for drive in local_drives() {
        places.push(Place { label: drive.trim_end_matches(['\\', '/']).to_string(), path: drive, kind: "drive" });
    }
    places
}

#[tauri::command(async)]
pub fn local_list(path: String) -> Result<Listing, SshError> {
    let target = if path.trim().is_empty() { PathBuf::from(local_home()) } else { PathBuf::from(&path) };
    let canonical = target
        .canonicalize()
        .map_err(|e| SshError::new("这个目录进不去", e))?;

    let read = std::fs::read_dir(&canonical).map_err(|e| SshError::new("读不了这个目录，可能没权限", e))?;

    let mut entries: Vec<Entry> = Vec::new();
    for item in read.flatten() {
        let path = item.path();
        // symlink_metadata：软链接照实显示，不跟着跳
        let meta = std::fs::symlink_metadata(&path).ok();
        let kind = match &meta {
            Some(m) if m.file_type().is_symlink() => "link",
            Some(m) if m.is_dir() => "dir",
            Some(_) => "file",
            None => "file",
        };
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(Entry {
            name: item.file_name().to_string_lossy().to_string(),
            path: pretty(&path),
            kind,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime,
            mode: None,
        });
    }
    sort_entries(&mut entries);

    Ok(Listing {
        parent: canonical.parent().map(pretty),
        path: pretty(&canonical),
        entries,
    })
}

#[tauri::command(async)]
pub fn local_mkdir(path: String) -> Result<(), SshError> {
    std::fs::create_dir(&path).map_err(|e| SshError::new("新建目录失败", e))
}

/// 建一个空文件（同名的就不动）
#[tauri::command(async)]
pub fn local_touch(path: String) -> Result<(), SshError> {
    // create_new：已存在就让系统拒绝，悬空软链也算存在，比先 exists 再写少一个竞态
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(SshError::plain("同名的已经在了")),
        Err(e) => Err(SshError::new("建不了文件，检查权限", e)),
    }
}

#[tauri::command(async)]
pub fn local_rename(from: String, to: String) -> Result<(), SshError> {
    // `fs::rename` 在 Windows 和 POSIX 上都会静默覆盖同名文件，这里跟远端（OpenSSH
    // 拒绝覆盖）对齐：目标已经在了就明说。用 symlink_metadata，悬空软链也算"在"。
    if from != to && std::fs::symlink_metadata(&to).is_ok() {
        return Err(SshError::plain("同名的已经在了"));
    }
    std::fs::rename(&from, &to).map_err(|e| SshError::new("重命名失败", e))
}

#[tauri::command(async)]
pub fn local_remove(path: String) -> Result<(), SshError> {
    let meta = std::fs::symlink_metadata(&path).map_err(|e| SshError::new("找不到这个文件", e))?;
    let kind = meta.file_type();

    // 软链接：删链接本身，不跟着它去删人家指向的东西。
    // Windows 上「指向目录的软链接」得用 remove_dir 删，用 remove_file 会失败。
    if kind.is_symlink() {
        return std::fs::remove_dir(&path)
            .or_else(|_| std::fs::remove_file(&path))
            .map_err(|e| SshError::new("删除失败", e));
    }
    if kind.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| SshError::new("删除目录失败", e))
    } else {
        std::fs::remove_file(&path).map_err(|e| SshError::new("删除失败", e))
    }
}

/// 本地文本文件 → 内置编辑器（和远程走同一套规则）
#[tauri::command(async)]
pub fn local_read_text(path: String, encoding: Option<String>) -> Result<TextFile, SshError> {
    let meta = std::fs::metadata(&path).map_err(|e| SshError::new("读不到这个文件", e))?;
    if meta.len() > MAX_EDIT_BYTES {
        return Err(SshError::plain("文件太大（超过 2MB），编辑器不开"));
    }
    let bytes = std::fs::read(&path).map_err(|e| SshError::new("打不开这个文件，可能没权限", e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let decoded = to_text(bytes, encoding.as_deref())?;
    Ok(TextFile {
        name: Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone()),
        newline: crate::sftp::newline_of(&decoded.text),
        size: meta.len(),
        mode: None,
        mtime,
        encoding: crate::encoding::name_of(decoded.used),
        lossy: decoded.lossy,
        bom: decoded.bom,
        content: decoded.text,
        path,
    })
}

fn mtime_of(path: &str) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 编辑器保存 → 写回本地。
/// 本地可以做真正的原子替换（临时文件 + rename），断电断在中间也不会留半截文件。
/// `expect_mtime` 对不上说明这个文件在别处被改过，先停下来问一句。
#[tauri::command(async)]
pub fn local_write_text(
    path: String,
    content: String,
    encoding: Option<String>,
    newline: Option<String>,
    expect_mtime: Option<u64>,
    force: Option<bool>,
    bom: Option<bool>,
) -> Result<u64, SshError> {
    if !force.unwrap_or(false) {
        if let Some(expected) = expect_mtime.filter(|one| *one > 0) {
            let now = mtime_of(&path);
            if now > 0 && now != expected {
                return Err(SshError::stale(now));
            }
        }
    }

    // 按读进来时那种编码和换行存回去，别把 GBK 文件悄悄改写成 UTF-8、
    // 也别把 CRLF 的文件整篇换成 LF
    let bytes = crate::sftp::to_bytes(&content, encoding.as_deref(), newline.as_deref(), bom.unwrap_or(false))?;

    // 目标是软链接（dotfiles 仓库用 stow / chezmoi 摆出来的 ~/.bashrc 就是）：
    // 得替换链接指向的那个真文件，不然 rename 会把链接本身换成普通文件，仓库里的原件没改
    let target: PathBuf = match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::canonicalize(&path).map_err(|e| SshError::new("这个软链接指向的文件找不到", e))?
        }
        _ => PathBuf::from(&path),
    };
    let tmp = target.with_extension(format!(
        "{}az-tmp",
        target.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()
    ));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(|e| SshError::new("写不进去，检查权限或只读属性", e))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                SshError::new("写不进去，检查权限或只读属性", e)
            })?;
    }
    // 原文件的权限位（Unix 的 rwx）搬到新文件上，别把 755 的脚本存成 644
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    // rename 在 Windows 和 POSIX 上都会覆盖同名文件，而且是原子的
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        SshError::new("替换原文件失败，检查权限或只读属性", e)
    })?;

    Ok(mtime_of(&path))
}

/// 拼路径：给前端做“上传到远程当前目录 / 下载到本地当前目录”用
#[tauri::command(async)]
pub fn local_join(dir: String, name: String) -> String {
    pretty(&PathBuf::from(dir).join(name))
}

/// 本地同一栏内复制（目录递归）。目标目录里有同名的就自动排到 `xxx (2)`。
#[tauri::command(async)]
pub fn local_copy(from: String, to_dir: String) -> Result<String, SshError> {
    let source = PathBuf::from(&from);
    let name = source
        .file_name()
        .map(|one| one.to_string_lossy().to_string())
        .ok_or_else(|| SshError::plain("这个路径没有名字，复制不了"))?;
    // 扩展名留在最后：a.tar.gz → a (2).tar.gz
    let (stem, ext) = match name.rfind('.').filter(|at| *at > 0) {
        Some(at) => (name[..at].to_string(), name[at..].to_string()),
        None => (name, String::new()),
    };

    let dir = PathBuf::from(&to_dir);
    let mut target = dir.join(format!("{stem}{ext}"));
    let mut nth = 2;
    while target.exists() {
        target = dir.join(format!("{stem} ({nth}){ext}"));
        nth += 1;
        if nth > 99 {
            return Err(SshError::plain("同名的太多了，先清一清"));
        }
    }

    copy_local(&source, &target).map_err(|e| SshError::new("复制失败", e))?;
    Ok(pretty(&target))
}

fn copy_local(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if !meta.is_dir() {
        std::fs::copy(from, to)?;
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for item in std::fs::read_dir(from)?.flatten() {
        copy_local(&item.path(), &to.join(item.file_name()))?;
    }
    Ok(())
}

/// 批量看一眼这些本地路径存不存在（传输前查覆盖冲突）
#[tauri::command(async)]
pub fn local_stat(paths: Vec<String>) -> Vec<Option<crate::sftp::Stat>> {
    paths
        .into_iter()
        .map(|path| {
            std::fs::metadata(&path).ok().map(|meta| crate::sftp::Stat {
                size: meta.len(),
                mtime: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                is_dir: meta.is_dir(),
            })
        })
        .collect()
}
