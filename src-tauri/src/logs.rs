//! 大日志查看器。
//!
//! 要解决的事很具体：`/var/log` 底下动辄几百 MB 到几个 GB 的文件，
//! 内置编辑器 2MB 就拦下了，下载下来又要等半天、还占本地的盘。
//!
//! 两条路子拼起来：
//! - **看**：走 SFTP 按字节区间读。`seek` 到某个偏移量只取一屏的量，
//!   文件多大都跟读一屏一样快，内存里也只有那一屏。
//! - **找**：走 `remote::exec` 让服务器自己 `grep`。几个 GB 的文件在服务器上
//!   扫一遍是几秒钟的事，扒回本地再搜是几分钟 —— 而且那几分钟里网卡是满的。
//!
//! 按字节区间读会把首尾两行切断，所以取回来之后要对齐到行边界（见 `align`）。

use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::remote::{exec, quote, ssh_of, SLOW};
use crate::sftp::{session_of, SftpState};
use crate::ssh::{SshError, SshState};

/// 一屏最多取多少。256 KiB 差不多三千行，`<pre>` 撑得住，
/// 再大前端渲染就开始卡了，而翻页本来就是这个视图的正常用法。
const MAX_WINDOW: u64 = 256 * 1024;

/// 一次搜索最多带回几条命中。再多人也看不过来，
/// 而且 `grep -m` 到数就停，大文件上省下的是实打实的扫描时间。
const MAX_HITS: usize = 500;

/// 命中行留多长。日志里偶尔有一行几百 KB 的 JSON，整条搬回来没意义。
const MAX_HIT_LEN: usize = 400;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// 这一块实际从哪个字节开始（已经对齐到行首，可能比你要的偏移量大一点）
    pub offset: u64,
    /// 这一块之后从哪儿接着读（已经对齐到行尾）
    pub next: u64,
    /// 文件此刻多大 —— 跟随模式靠它判断有没有长出新内容
    pub size: u64,
    pub text: String,
    /// 解码时遇到过坏字节，多半是编码选错了
    pub lossy: bool,
    /// 这一屏里有一行长得超过了一屏，没法对齐行边界，只好从中间切开
    pub cut: bool,
}

/// 把按字节切出来的一块对齐到行边界。
///
/// 从中间切的话，头一行和末一行都是半截的。掐头去尾之后返回
/// （新的起始偏移, 新的结束偏移）。
///
/// - `at_head` / `at_tail`：这一块是不是正好贴着文件的头 / 尾。
///   贴着头就别掐头（第一行本来就是完整的），贴着尾同理。
/// - 找不到换行符（整块就是一行的一部分）时原样返回，并让调用方标 `cut`——
///   宁可显示一行被切开的长行，也不能显示一片空白。
///
/// 只按 `\n`（0x0A）切是安全的：UTF-8 和 GBK 的多字节序列里都不会出现 0x0A，
/// 所以不会切在一个字符中间。
fn align(bytes: &[u8], at_head: bool, at_tail: bool) -> (usize, usize) {
    let mut start = 0usize;
    let mut end = bytes.len();

    if !at_head {
        match bytes.iter().position(|b| *b == b'\n') {
            Some(cut) => start = cut + 1,
            None => return (0, bytes.len()),
        }
    }
    if !at_tail {
        match bytes[start..].iter().rposition(|b| *b == b'\n') {
            Some(cut) => end = start + cut + 1,
            None => return (0, bytes.len()),
        }
    }
    if start >= end {
        return (0, bytes.len());
    }
    (start, end)
}

/// 读文件的一段。
///
/// `offset` 给 `None` 就是读末尾那一屏 —— 打开日志十有八九是想看最新的几行，
/// 而且这样不用先问一次文件多大（问完再读，中间文件又长了，位置就错了）。
#[tauri::command]
pub async fn log_read(
    sftp_state: tauri::State<'_, SftpState>,
    ssh: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    offset: Option<u64>,
    len: Option<u64>,
    encoding: Option<String>,
) -> Result<Chunk, SshError> {
    let sftp = session_of(&sftp_state, &ssh, &session_id).await?;
    let size = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| SshError::new("读不到这个文件", e))?
        .size
        .unwrap_or(0);

    let want = len.unwrap_or(MAX_WINDOW).clamp(4 * 1024, MAX_WINDOW);
    // 不给偏移量 = 看末尾
    let from = match offset {
        Some(one) => one.min(size),
        None => size.saturating_sub(want),
    };

    if size == 0 {
        return Ok(Chunk { offset: 0, next: 0, size, text: String::new(), lossy: false, cut: false });
    }

    let mut file = sftp
        .open(path.clone())
        .await
        .map_err(|e| SshError::new("打不开这个文件，可能没权限", e))?;
    file.seek(std::io::SeekFrom::Start(from))
        .await
        .map_err(|e| SshError::new("文件定位不了", e))?;

    // 多读一个字节：好知道这一块后面到底还有没有东西，
    // 免得为了判断「到底了没有」再问一次文件大小
    let mut buf = vec![0u8; want as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = file
            .read(&mut buf[filled..])
            .await
            .map_err(|e| SshError::new("读取中断", e))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);

    let at_head = from == 0;
    let at_tail = from + filled as u64 >= size;
    let (start, end) = align(&buf, at_head, at_tail);
    let cut = start == 0 && end == buf.len() && !at_head && !at_tail;

    let encoding = crate::encoding::resolve(encoding.as_deref());
    let decoded = crate::encoding::decode(&buf[start..end], encoding);
    let (text, lossy) = (decoded.text, decoded.lossy);

    Ok(Chunk {
        offset: from + start as u64,
        next: from + end as u64,
        size,
        text,
        lossy,
        cut,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// 这一行在文件里的字节偏移 —— 点一下就能跳过去
    pub offset: u64,
    pub line: u64,
    pub text: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hits {
    pub rows: Vec<Hit>,
    /// 到上限停下的，后面还有没找完的
    pub capped: bool,
}

/// 让服务器自己 grep。
///
/// 几个 GB 的文件在服务器上扫一遍是几秒钟，扒回本地再搜是几分钟 ——
/// 何况那几分钟里网卡一直是满的。
#[tauri::command]
pub async fn log_grep(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
    pattern: String,
    regex: bool,
    ignore_case: bool,
) -> Result<Hits, SshError> {
    if pattern.trim().is_empty() {
        return Ok(Hits { rows: Vec::new(), capped: false });
    }
    let ssh = ssh_of(&app);

    // 开关都是布尔值拼出来的，模式和路径一律包成单引号字面量 —— 这两个是用户敲的
    let mode = if regex { "-E" } else { "-F" };
    let fold = if ignore_case { "-i" } else { "" };
    // -a：日志里混进二进制字节是常事，不加的话 grep 会只回一句
    //     "Binary file matches" 就完事了
    // -m：到数就停，大文件上省下的是实打实的扫描时间
    // -e 和 --：模式以 - 开头（搜 "--verbose"）时不会被当成选项
    let script = format!(
        "grep -n -b -a {mode} {fold} -m {MAX_HITS} -e {} -- {} 2>&1",
        quote(pattern.trim()),
        quote(&path),
    );
    let text = exec(&ssh, &session_id, &script, SLOW).await?;

    let rows: Vec<Hit> = text.lines().filter_map(parse_hit).collect();
    if rows.is_empty() {
        // grep 没找到东西时是静默退出的，所以有输出却一条都解析不出来，
        // 那多半是它在报错（没权限、文件不存在）
        let noise = text.trim();
        if !noise.is_empty() {
            return Err(SshError::new("搜不了这个文件", noise.lines().next().unwrap_or(noise)));
        }
    }
    let capped = rows.len() >= MAX_HITS;
    Ok(Hits { rows, capped })
}

/// `grep -n -b` 的一行 → 一条命中。
/// 加了这两个开关之后 GNU grep 的格式是 `行号:字节偏移:正文`。
fn parse_hit(line: &str) -> Option<Hit> {
    let (num, rest) = line.split_once(':')?;
    let line_no: u64 = num.trim().parse().ok()?;
    let (byte, text) = rest.split_once(':')?;
    let offset: u64 = byte.trim().parse().ok()?;
    // 一行几百 KB 的 JSON 整条搬回来没意义，截一刀
    let text = if text.len() > MAX_HIT_LEN {
        let mut cut = MAX_HIT_LEN;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &text[..cut])
    } else {
        text.to_string()
    };
    Some(Hit { offset, line: line_no, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn align_trims_the_half_lines() {
        let data = b"cut-off line\nwhole line\nanother\ntrailing hal";
        // 从中间切的：头尾各掐掉半行
        let (start, end) = align(data, false, false);
        assert_eq!(&data[start..end], b"whole line\nanother\n");
        // 贴着文件头：第一行本来就是完整的，别掐
        let (start, end) = align(data, true, false);
        assert_eq!(&data[start..end], b"cut-off line\nwhole line\nanother\n");
        // 贴着文件尾：最后一行本来就是完整的（文件可能就是不以换行结尾）
        let (start, end) = align(data, false, true);
        assert_eq!(&data[start..end], b"whole line\nanother\ntrailing hal");
        // 两头都贴着：整块原样
        let (start, end) = align(data, true, true);
        assert_eq!(&data[start..end], data);
    }

    #[test]
    fn align_keeps_a_line_longer_than_the_window() {
        // 整块就是一行的中段，一个换行符都没有 —— 宁可显示切开的长行也不能显示空白
        let data = b"aaaaaaaaaaaaaaaaaaaa";
        assert_eq!(align(data, false, false), (0, data.len()));
        // 只有一个换行、掐完头就没内容了，同样原样返回
        let data = b"tail-of-a-line\n";
        assert_eq!(align(data, false, false), (0, data.len()));
    }

    #[test]
    fn grep_line_splits_into_line_byte_text() {
        let hit = parse_hit("142:98304:2026-08-22 01:02:03 ERROR something broke").unwrap();
        assert_eq!(hit.line, 142);
        assert_eq!(hit.offset, 98304);
        // 正文里的冒号不能把它切碎 —— 只认前两个
        assert_eq!(hit.text, "2026-08-22 01:02:03 ERROR something broke");

        // grep 报错那种行认不出来，正好被滤掉，交给上面那段当错误处理
        assert!(parse_hit("grep: /var/log/secure: Permission denied").is_none());
        assert!(parse_hit("").is_none());
    }

    #[test]
    fn long_hit_is_cut_on_a_char_boundary() {
        let long = "中".repeat(400);
        let hit = parse_hit(&format!("1:0:{long}")).unwrap();
        assert!(hit.text.ends_with('…'));
        // 截断点落在字符边界上，不该切出半个汉字
        assert!(hit.text.chars().all(|c| c == '中' || c == '…'));
    }
}
