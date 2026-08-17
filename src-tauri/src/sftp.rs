//! SFTP 引擎：在已有的 SSH 连接上开 sftp 子系统通道，复用同一条连接。
//!
//! 设计要点：
//! - 一个 SSH 会话对应一个 SftpSession，首次用到时才建立，会话断开即丢弃。
//! - 不重新认证：SFTP 走终端那条连接的子通道，用户不用二次输密码。
//! - 传输走分块流式，进度经 `sftp://progress` 事件推给前端，大文件不吃内存。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::ssh::{SshError, SshState};

/// 目录项（本地远程同一套形状，前端一个组件通用）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// "dir" | "file" | "link"
    pub kind: &'static str,
    pub size: u64,
    /// Unix 秒；取不到给 0
    pub mtime: u64,
    /// Unix 权限位（本地 Windows 给 None）
    pub mode: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// 规范化后的绝对路径
    pub path: String,
    /// 上级目录；已在根则为 None
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

/// 内置编辑器要的文本文件内容
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub size: u64,
    pub mode: Option<u32>,
    pub mtime: u64,
    /// 这次是按哪种编码读进来的，存回去也用它
    pub encoding: String,
    /// 解码时遇到过坏字节 —— 多半是编码选错了，前端提醒一句别急着存
    pub lossy: bool,
    /// 原来的换行是 "crlf" 还是 "lf"，存回去照原样
    pub newline: &'static str,
}

/// 这个文件本来用哪种换行。
/// 网页里的 textarea 会把换行统一成 \n，不记一笔的话，
/// 存回去整个文件的行尾就都被悄悄改了 —— git 上看就是「全文件都动过」。
pub(crate) fn newline_of(text: &str) -> &'static str {
    if text.contains("\r\n") { "crlf" } else { "lf" }
}

/// 存回去之前把换行还原成原来那种
pub(crate) fn restore_newlines(text: &str, newline: Option<&str>) -> String {
    if newline == Some("crlf") {
        // 先规整成 \n 再统一换，免得把已经是 \r\n 的变成 \r\r\n
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_string()
    }
}

/// 编辑器只收小文本：配置文件用不了这么大，2MB 以上八成是日志或二进制
pub(crate) const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

/// 字节 → 文本。二进制照样拦下来；编码不对不再一口回绝，
/// 而是照着用户选的那种解，解不干净就标个 lossy 让他换一种再看。
pub(crate) fn to_text(bytes: Vec<u8>, label: Option<&str>) -> Result<(String, String, bool), SshError> {
    if bytes.contains(&0) {
        return Err(SshError::plain("这是个二进制文件，编辑器不碰它"));
    }
    let encoding = crate::encoding::resolve(label);
    let (text, lossy) = crate::encoding::decode(&bytes, encoding);
    Ok((text, crate::encoding::name_of(encoding), lossy))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    session_id: String,
    /// 队列里那条任务的 id —— 好几个文件同时在传，得分得清哪条是哪条
    task_id: String,
    name: String,
    done: u64,
    total: u64,
    /// "up" | "down"
    direction: &'static str,
    finished: bool,
}

/// session_id -> SFTP 子会话
#[derive(Default)]
pub struct SftpState {
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
    /// 用户点了取消的那些任务 id；传输循环每块看一眼
    cancelled: Mutex<std::collections::HashSet<String>>,
}

/// SSH 会话结束时清掉挂在它上面的 SFTP 子会话和隧道
pub async fn drop_session(app: &AppHandle, session_id: &str) {
    if let Some(state) = app.try_state::<SftpState>() {
        state.sessions.lock().await.remove(session_id);
    }
    if let Some(state) = app.try_state::<crate::tunnel::TunnelState>() {
        state.drop_session(session_id).await;
    }
}

/// 传到一半喊停：把这些任务 id 标上，正在跑的循环下一块就退出来
#[tauri::command]
pub async fn sftp_cancel(state: tauri::State<'_, SftpState>, task_ids: Vec<String>) -> Result<(), SshError> {
    let mut marks = state.cancelled.lock().await;
    for id in task_ids {
        marks.insert(id);
    }
    Ok(())
}

/// 任务结束（不管成没成）就把标记收走，别让集合一直涨
async fn take_cancel(state: &SftpState, task_id: &str) -> bool {
    state.cancelled.lock().await.remove(task_id)
}

async fn is_cancelled(state: &SftpState, task_id: &str) -> bool {
    state.cancelled.lock().await.contains(task_id)
}

/// 取（必要时建立）某条 SSH 连接上的 SFTP 会话
async fn session_of(
    sftp_state: &SftpState,
    ssh: &SshState,
    session_id: &str,
) -> Result<Arc<SftpSession>, SshError> {
    let mut map = sftp_state.sessions.lock().await;
    if let Some(existing) = map.get(session_id) {
        return Ok(existing.clone());
    }

    let handle = ssh
        .handle_of(session_id)
        .await
        .ok_or_else(|| SshError::plain("SSH 会话不在了，先重新连接"))?;

    // 只借一下锁：通道开出来就还，别把整条 SFTP 会话的生命周期压在锁上
    let channel = handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|e| SshError::new("打开文件通道失败", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SshError::new("服务器没开 SFTP 子系统", e))?;
    let session = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SshError::new("SFTP 握手失败", e))?;

    let session = Arc::new(session);
    map.insert(session_id.to_string(), session.clone());
    Ok(session)
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn parent_remote(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
        None => None,
    }
}

/// 列远程目录。path 传空串或 "." 表示用户主目录。
#[tauri::command]
pub async fn sftp_list(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<Listing, SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    let target = if path.trim().is_empty() { ".".to_string() } else { path };

    let canonical = sftp
        .canonicalize(target.clone())
        .await
        .map_err(|e| SshError::new("这个目录进不去", e))?;

    let dir = sftp
        .read_dir(canonical.clone())
        .await
        .map_err(|e| SshError::new("读不了这个目录，可能没权限", e))?;

    let mut entries: Vec<Entry> = dir
        .map(|item| {
            let meta = item.metadata();
            let kind = if meta.is_dir() {
                "dir"
            } else if meta.is_symlink() {
                "link"
            } else {
                "file"
            };
            let name = item.file_name();
            Entry {
                path: join_remote(&canonical, &name),
                name,
                kind,
                size: meta.size.unwrap_or(0),
                mtime: meta.mtime.unwrap_or(0) as u64,
                mode: meta.permissions.map(|p| p & 0o7777),
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    sort_entries(&mut entries);

    Ok(Listing { parent: parent_remote(&canonical), path: canonical, entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_the_newline_style() {
        assert_eq!(newline_of("a\r\nb\r\n"), "crlf");
        assert_eq!(newline_of("a\nb\n"), "lf");
        assert_eq!(newline_of("没有换行"), "lf");
    }

    /// textarea 会把换行统一成 \n，存回去得还原成原来那种，
    /// 否则改一行等于整个文件的行尾都动了
    #[test]
    fn puts_crlf_back() {
        assert_eq!(restore_newlines("a\nb", Some("crlf")), "a\r\nb");
        assert_eq!(restore_newlines("a\nb", Some("lf")), "a\nb");
        assert_eq!(restore_newlines("a\nb", None), "a\nb");
    }

    /// 已经是 \r\n 的别再翻一倍
    #[test]
    fn does_not_double_up() {
        assert_eq!(restore_newlines("a\r\nb", Some("crlf")), "a\r\nb");
    }
}

pub(crate) fn sort_entries(entries: &mut [Entry]) {
    // 目录在前，其余按名字（不区分大小写）
    entries.sort_by(|a, b| {
        let rank = |k: &str| if k == "dir" { 0 } else { 1 };
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    sftp.create_dir(path).await.map_err(|e| SshError::new("新建目录失败", e))
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    sftp.rename(from, to).await.map_err(|e| SshError::new("重命名失败", e))
}

/// 删除远程文件 / 目录（目录递归删）
#[tauri::command]
pub async fn sftp_remove(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    remove_recursive(&sftp, path)
        .await
        .map_err(|e| SshError::new("删除失败", e))
}

fn remove_recursive<'a>(
    sftp: &'a SftpSession,
    path: String,
) -> Pin<Box<dyn Future<Output = Result<(), russh_sftp::client::error::Error>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(path.clone()).await?;
        if !meta.is_dir() {
            return sftp.remove_file(path).await;
        }
        let children: Vec<(String, bool)> = sftp
            .read_dir(path.clone())
            .await?
            .filter(|item| item.file_name() != "." && item.file_name() != "..")
            .map(|item| (join_remote(&path, &item.file_name()), item.metadata().is_dir()))
            .collect();
        for (child, _) in children {
            remove_recursive(sftp, child).await?;
        }
        sftp.remove_dir(path).await
    })
}

#[allow(clippy::too_many_arguments)]
/// 目标已经有同名的了就往后找个空位：`conf` → `conf (2)` → `conf (3)`。
/// 扩展名留在最后，`a.tar.gz` 变成 `a (2).tar.gz` 而不是 `a.tar (2).gz`。
fn free_name(base: &str) -> (String, String) {
    let name = file_name_of(base);
    // 多重扩展名只认最后一段，够用且不会把 `v1.2.3` 这种名字拆坏
    match name.rfind('.').filter(|at| *at > 0) {
        Some(at) => (name[..at].to_string(), name[at..].to_string()),
        None => (name, String::new()),
    }
}

/// 同一栏里复制：SFTP 没有「服务器内部复制」这个原语，
/// 所以字节要从服务器读出来再写回去，走的是我们这条连接。
/// 目录就递归着来。
fn copy_remote<'a>(
    sftp: &'a SftpSession,
    from: String,
    to: String,
) -> Pin<Box<dyn Future<Output = Result<(), russh_sftp::client::error::Error>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(from.clone()).await?;
        if meta.is_dir() {
            // 目标目录已经在就接着用，不当错误
            let _ = sftp.create_dir(to.clone()).await;
            let children: Vec<String> = sftp
                .read_dir(from.clone())
                .await?
                .filter(|item| item.file_name() != "." && item.file_name() != "..")
                .map(|item| item.file_name())
                .collect();
            for child in children {
                copy_remote(sftp, join_remote(&from, &child), join_remote(&to, &child)).await?;
            }
            return Ok(());
        }

        let mut src = sftp.open(from).await?;
        let mut dst = sftp.create(to.clone()).await?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
        }
        dst.flush().await?;
        dst.shutdown().await.ok();
        // 权限跟着一起带过去，可执行文件复制完还是可执行的
        if let Some(mode) = meta.permissions {
            let attrs = russh_sftp::protocol::FileAttributes {
                permissions: Some(mode),
                ..Default::default()
            };
            let _ = sftp.set_metadata(to, attrs).await;
        }
        Ok(())
    })
}

/// 远程同一栏内复制。目标目录里有同名的就自动排到 `xxx (2)`。
#[tauri::command]
pub async fn sftp_copy(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    from: String,
    to_dir: String,
) -> Result<String, SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    let (stem, ext) = free_name(&from);

    let mut target = join_remote(&to_dir, &format!("{stem}{ext}"));
    let mut nth = 2;
    while sftp.try_exists(target.clone()).await.unwrap_or(false) {
        target = join_remote(&to_dir, &format!("{stem} ({nth}){ext}"));
        nth += 1;
        if nth > 99 {
            return Err(SshError::plain("同名的太多了，先清一清"));
        }
    }

    copy_remote(&sftp, from, target.clone())
        .await
        .map_err(|e| SshError::new("复制失败", e))?;
    Ok(target)
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    session_id: &str,
    task_id: &str,
    name: &str,
    done: u64,
    total: u64,
    direction: &'static str,
    finished: bool,
) {
    let _ = app.emit(
        "sftp://progress",
        Progress {
            session_id: session_id.to_string(),
            task_id: task_id.to_string(),
            name: name.to_string(),
            done,
            total,
            direction,
            finished,
        },
    );
}

fn file_name_of(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

/// 读远程文本文件，交给内置编辑器
#[tauri::command]
pub async fn sftp_read_text(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    encoding: Option<String>,
) -> Result<TextFile, SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    let meta = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| SshError::new("读不到这个文件", e))?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_EDIT_BYTES {
        return Err(SshError::plain("文件太大（超过 2MB），编辑器不开，用下载吧"));
    }

    let bytes = sftp
        .read(path.clone())
        .await
        .map_err(|e| SshError::new("打不开这个文件，可能没权限", e))?;

    let (content, used, lossy) = to_text(bytes, encoding.as_deref())?;
    Ok(TextFile {
        name: file_name_of(&path),
        newline: newline_of(&content),
        content,
        size,
        mode: meta.permissions.map(|p| p & 0o7777),
        mtime: meta.mtime.unwrap_or(0) as u64,
        encoding: used,
        lossy,
        path,
    })
}

/// 编辑器保存 → 写回远程。
///
/// 原地覆盖，权限属主和 inode 都不动 —— 改 `/etc` 底下的配置文件时这点很要紧
/// （写临时文件再改名会把属主和权限换掉，而 SFTP 的 rename 在 OpenSSH 上
/// 又不允许覆盖已存在的文件，绕不过去）。
///
/// 换来的代价是写到一半断线会留个半截文件，所以写完立刻回读一次大小对账，
/// 对不上就明说，不让用户以为存好了。
///
/// `expect_mtime` 是打开这个文件时的修改时间：对不上说明别人（或你自己在
/// 另一个标签）动过，先停下来问一句，别把人家的改动盖了。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_write_text(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    content: String,
    encoding: Option<String>,
    newline: Option<String>,
    expect_mtime: Option<u64>,
    force: Option<bool>,
) -> Result<u64, SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;

    if !force.unwrap_or(false) {
        if let Some(expected) = expect_mtime.filter(|one| *one > 0) {
            let now = sftp.metadata(path.clone()).await.ok().and_then(|m| m.mtime).unwrap_or(0) as u64;
            if now > 0 && now != expected {
                return Err(SshError::stale(now));
            }
        }
    }

    // 按读进来时那种编码、那种换行存回去
    let text = restore_newlines(&content, newline.as_deref());
    let bytes = crate::encoding::encode(&text, crate::encoding::resolve(encoding.as_deref()));
    let wrote = bytes.len() as u64;

    sftp.write(path.clone(), &bytes)
        .await
        .map_err(|e| SshError::new("写不回去，多半是没有写权限", e))?;

    let after = sftp.metadata(path).await.ok();
    if let Some(size) = after.as_ref().and_then(|m| m.size) {
        if size != wrote {
            return Err(SshError::plain(
                "写进去的字节数跟应该写的对不上，文件可能只写了一半 —— 别关这个标签，检查一下服务器上的文件",
            ));
        }
    }
    Ok(after.and_then(|m| m.mtime).unwrap_or(0) as u64)
}

/// 在远程建一个空文件（同名的就不动，免得把人家内容清了）
#[tauri::command]
pub async fn sftp_touch(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    if sftp.try_exists(path.clone()).await.unwrap_or(false) {
        return Err(SshError::plain("同名的已经在了"));
    }
    sftp.write(path, b"")
        .await
        .map_err(|e| SshError::new("建不了文件，可能没写权限", e))
}

/// 改远程文件权限（chmod）。只动低 12 位，文件类型位原样保留。
#[tauri::command]
pub async fn sftp_chmod(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<u32, SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    let old = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| SshError::new("读不到当前权限", e))?;
    let type_bits = old.permissions.unwrap_or(0) & !0o7777;
    let next = type_bits | (mode & 0o7777);

    let attrs = russh_sftp::protocol::FileAttributes {
        permissions: Some(next),
        ..Default::default()
    };
    sftp.set_metadata(path, attrs)
        .await
        .map_err(|e| SshError::new("改权限失败，多半不是你的文件", e))?;
    Ok(next & 0o7777)
}

/// 目标位置上已经有的那个东西长什么样 —— 传输前拿它跟源文件摆在一起给用户看
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub size: u64,
    pub mtime: u64,
    pub is_dir: bool,
}

/// 批量看一眼这些远程路径存不存在（传输前查覆盖冲突，一次问完，不一个个来回）
#[tauri::command]
pub async fn sftp_stat(
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<Vec<Option<Stat>>, SshError> {
    let sftp = session_of(&state, &ssh, &session_id).await?;
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(sftp.metadata(path).await.ok().map(|m| Stat {
            size: m.size.unwrap_or(0),
            mtime: m.mtime.unwrap_or(0) as u64,
            is_dir: m.is_dir(),
        }));
    }
    Ok(out)
}

/// 远程 → 本地。
/// `overwrite` 不是 true 时，目标已存在就直接报错 ——
/// 用户没在覆盖确认框上点过头的文件，一个字节都不动。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_download(
    app: AppHandle,
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    task_id: String,
    remote_path: String,
    local_path: String,
    overwrite: Option<bool>,
    resume: Option<u64>,
) -> Result<(), SshError> {
    let resume_at = resume.unwrap_or(0);
    if resume_at == 0 && !overwrite.unwrap_or(false) && std::path::Path::new(&local_path).exists() {
        return Err(SshError::plain("本地已经有同名文件了，没覆盖"));
    }
    let sftp = session_of(&state, &ssh, &session_id).await?;
    let name = file_name_of(&remote_path);

    let total = sftp.metadata(remote_path.clone()).await.map(|m| m.size.unwrap_or(0)).unwrap_or(0);
    let mut remote = sftp
        .open(remote_path.clone())
        .await
        .map_err(|e| SshError::new("远程文件打不开", e))?;

    // 续传：两头都跳到已经传完的位置，从那儿接着来
    let mut local = if resume_at > 0 {
        use tokio::io::AsyncSeekExt;
        remote
            .seek(std::io::SeekFrom::Start(resume_at))
            .await
            .map_err(|e| SshError::new("远程文件定位不了，续传不了", e))?;
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&local_path)
            .await
            .map_err(|e| SshError::new("本地文件打不开，续传不了", e))?
    } else {
        tokio::fs::File::create(&local_path)
            .await
            .map_err(|e| SshError::new("本地文件写不了，检查目录权限", e))?
    };

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = resume_at;
    let mut marker: u64 = resume_at;
    loop {
        // 每块看一眼用户是不是喊停了。
        // 本来就不存在的文件：删掉，别留个半截的冒充完整文件。
        // 续传的：原来就在那儿，留着，下次还能接着传。
        if is_cancelled(&state, &task_id).await {
            drop(local);
            if resume_at == 0 {
                let _ = tokio::fs::remove_file(&local_path).await;
            }
            take_cancel(&state, &task_id).await;
            emit_progress(&app, &session_id, &task_id, &name, done, total, "down", true);
            return Err(SshError::plain("已取消"));
        }
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| SshError::new("下载中断", e))?;
        if n == 0 {
            break;
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| SshError::new("写入本地失败", e))?;
        done += n as u64;
        if done - marker >= 256 * 1024 {
            marker = done;
            emit_progress(&app, &session_id, &task_id, &name, done, total, "down", false);
        }
    }
    local.flush().await.map_err(|e| SshError::new("落盘失败", e))?;
    take_cancel(&state, &task_id).await;
    emit_progress(&app, &session_id, &task_id, &name, done, total.max(done), "down", true);
    Ok(())
}

/// 本地 → 远程。
/// `overwrite` 不是 true 时，目标已存在就直接报错，不覆盖。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_upload(
    app: AppHandle,
    state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    task_id: String,
    local_path: String,
    remote_path: String,
    overwrite: Option<bool>,
    resume: Option<u64>,
) -> Result<(), SshError> {
    let resume_at = resume.unwrap_or(0);
    let sftp = session_of(&state, &ssh, &session_id).await?;
    if resume_at == 0
        && !overwrite.unwrap_or(false)
        && sftp.try_exists(remote_path.clone()).await.unwrap_or(false)
    {
        return Err(SshError::plain("远程已经有同名文件了，没覆盖"));
    }
    let name = file_name_of(&local_path);

    let total = tokio::fs::metadata(&local_path).await.map(|m| m.len()).unwrap_or(0);
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| SshError::new("本地文件读不了", e))?;

    // 续传：远端用 WRITE（不带 TRUNCATE，原有内容留着），两头跳到同一个位置
    let mut remote = if resume_at > 0 {
        use tokio::io::AsyncSeekExt;
        local
            .seek(std::io::SeekFrom::Start(resume_at))
            .await
            .map_err(|e| SshError::new("本地文件定位不了，续传不了", e))?;
        let mut file = sftp
            .open_with_flags(remote_path.clone(), russh_sftp::protocol::OpenFlags::WRITE)
            .await
            .map_err(|e| SshError::new("远程文件打不开，续传不了", e))?;
        file.seek(std::io::SeekFrom::Start(resume_at))
            .await
            .map_err(|e| SshError::new("远程文件定位不了，续传不了", e))?;
        file
    } else {
        sftp.create(remote_path.clone())
            .await
            .map_err(|e| SshError::new("远程建文件失败，可能没写权限", e))?
    };

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = resume_at;
    let mut marker: u64 = resume_at;
    loop {
        // 取消：本来不存在的就收掉，续传的留着好接着传
        if is_cancelled(&state, &task_id).await {
            remote.shutdown().await.ok();
            drop(remote);
            if resume_at == 0 {
                let _ = sftp.remove_file(remote_path.clone()).await;
            }
            take_cancel(&state, &task_id).await;
            emit_progress(&app, &session_id, &task_id, &name, done, total, "up", true);
            return Err(SshError::plain("已取消"));
        }
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| SshError::new("读本地文件出错", e))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| SshError::new("上传中断", e))?;
        done += n as u64;
        if done - marker >= 256 * 1024 {
            marker = done;
            emit_progress(&app, &session_id, &task_id, &name, done, total, "up", false);
        }
    }
    remote.flush().await.map_err(|e| SshError::new("上传收尾失败", e))?;
    remote.shutdown().await.ok();
    take_cancel(&state, &task_id).await;
    emit_progress(&app, &session_id, &task_id, &name, done, total.max(done), "up", true);
    Ok(())
}
