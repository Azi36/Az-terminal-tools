//! 字符编码。
//!
//! 国内不少服务器（还有一堆存量配置文件）是 GBK 的，硬按 UTF-8 读就是一屏乱码，
//! 而且乱码之后你在编辑器里存回去，人家的文件就真的坏了。
//! 所以终端流和文本文件都带一个编码标签，读写两头都按它来。
//!
//! 标签用的是 WHATWG 那套名字（"utf-8" / "gbk" / "big5" / "shift_jis" …），
//! 跟浏览器、跟 Xshell 的编码菜单对得上。

use encoding_rs::{Encoding, UTF_8};

/// 一块字节解出来的结果
pub struct Decoded {
    pub text: String,
    /// 实际按哪种编码解的：文件带 BOM 时 encoding_rs 会无视标签按 BOM 来，
    /// 存回去也得按它，不然一个 UTF-8 文件会被按 GBK 写回去
    pub used: &'static Encoding,
    /// 撞上过坏字节（多半是编码选错了）
    pub lossy: bool,
    /// 开头有 BOM（解码时已剥掉），存回去要补上 —— .ps1 之类的文件靠它认编码
    pub bom: bool,
}

/// 标签 → 编码；不认识的一律当 UTF-8，不因为一个拼错的名字把连接卡死
pub fn resolve(label: Option<&str>) -> &'static Encoding {
    match label {
        None => UTF_8,
        Some(name) if name.trim().is_empty() => UTF_8,
        Some(name) => Encoding::for_label(name.trim().as_bytes()).unwrap_or(UTF_8),
    }
}

/// 一整块字节 → 文本（读文件用；终端流那种要接着上一块的，用 Decoder）
pub fn decode(bytes: &[u8], encoding: &'static Encoding) -> Decoded {
    let bom = Encoding::for_bom(bytes).is_some();
    let (text, used, had_errors) = encoding.decode(bytes);
    Decoded { text: text.into_owned(), used, lossy: had_errors, bom }
}

/// 文本 → 字节（写文件用）。
///
/// 有字符在这个编码里表示不了就报错：encoding_rs 默认把它们写成 `&#NNNN;`
/// 这种 HTML 实体，字节数对得上、内容却坏了，事后对账查不出来。
pub fn encode(text: &str, encoding: &'static Encoding, bom: bool) -> Result<Vec<u8>, String> {
    let (bytes, actual, unmappable) = encoding.encode(text);
    if unmappable {
        return Err(format!("有字符在 {} 里表示不了，换成 UTF-8 再存", name_of(encoding)));
    }
    let mut out = Vec::with_capacity(bytes.len() + 3);
    // 只有 Unicode 系列有 BOM 这回事；UTF-16 的编码器实际吐的是 UTF-8，所以看 actual
    if bom && std::ptr::eq(actual, UTF_8) {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

/// 文本 → 字节（往终端发输入用）：表示不了的字符换成 `?` 发过去，
/// 别让一个 emoji 变成一串 `&#128512;` 落进人家的命令行
pub fn encode_lossy(text: &str, encoding: &'static Encoding) -> Vec<u8> {
    let (bytes, _, unmappable) = encoding.encode(text);
    if !unmappable {
        return bytes.into_owned();
    }
    let mut out = Vec::with_capacity(text.len());
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        let (piece, _, bad) = encoding.encode(ch.encode_utf8(&mut buf));
        if bad {
            out.push(b'?');
        } else {
            out.extend_from_slice(&piece);
        }
    }
    out
}

/// 前端要展示的编码名：拿回规范写法（用户填 "GB2312" 也认，回来是 "gbk"）
pub fn name_of(encoding: &'static Encoding) -> String {
    encoding.name().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_round_trip() {
        let gbk = resolve(Some("gbk"));
        let bytes = encode("中文配置", gbk, false).unwrap();
        // GBK 里一个汉字两字节，跟 UTF-8 的三字节不一样 —— 确认真的走了 GBK
        assert_eq!(bytes.len(), 8);
        let back = decode(&bytes, gbk);
        assert_eq!(back.text, "中文配置");
        assert!(!back.lossy);
        assert!(!back.bom);
        assert!(std::ptr::eq(back.used, gbk));
    }

    /// GBK 里没有 emoji：写文件必须报错，往终端发就换成问号，两边都不能出 `&#NNNN;`
    #[test]
    fn unmappable_never_becomes_html_entities() {
        let gbk = resolve(Some("gbk"));
        assert!(encode("笑 😀", gbk, false).is_err());
        let sent = encode_lossy("笑 😀", gbk);
        assert!(!sent.windows(2).any(|w| w == b"&#"));
        assert_eq!(sent.last(), Some(&b'?'));
        // 没有表示不了的字符时两条路径结果一致
        assert_eq!(encode_lossy("中文", gbk), encode("中文", gbk, false).unwrap());
    }

    /// 标签写 GBK 但文件带 UTF-8 BOM：按 BOM 解，回报的编码是 UTF-8，存回去 BOM 还在
    #[test]
    fn bom_wins_over_label_and_survives_round_trip() {
        let gbk = resolve(Some("gbk"));
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("配置".as_bytes());
        let got = decode(&bytes, gbk);
        assert_eq!(got.text, "配置");
        assert!(got.bom);
        assert_eq!(name_of(got.used), "utf-8");
        let back = encode(&got.text, got.used, got.bom).unwrap();
        assert_eq!(back, bytes);
    }

    #[test]
    fn utf8_is_the_default() {
        assert_eq!(name_of(resolve(None)), "utf-8");
        assert_eq!(name_of(resolve(Some(""))), "utf-8");
        // 不认识的标签别把人卡住，退回 UTF-8
        assert_eq!(name_of(resolve(Some("no-such-encoding"))), "utf-8");
        // 常见别名认得出来
        assert_eq!(name_of(resolve(Some("GB2312"))), "gbk");
    }

    #[test]
    fn gbk_bytes_are_garbage_as_utf8() {
        // 这就是「不加编码支持」时用户看到的那一屏乱码，确认我们能分辨
        let gbk = resolve(Some("gbk"));
        let bytes = encode("中文", gbk, false).unwrap();
        assert!(decode(&bytes, UTF_8).lossy, "GBK 字节按 UTF-8 解就该报错");
    }
}
