//! 字符编码。
//!
//! 国内不少服务器（还有一堆存量配置文件）是 GBK 的，硬按 UTF-8 读就是一屏乱码，
//! 而且乱码之后你在编辑器里存回去，人家的文件就真的坏了。
//! 所以终端流和文本文件都带一个编码标签，读写两头都按它来。
//!
//! 标签用的是 WHATWG 那套名字（"utf-8" / "gbk" / "big5" / "shift_jis" …），
//! 跟浏览器、跟 Xshell 的编码菜单对得上。

use encoding_rs::{Encoding, UTF_8};

/// 标签 → 编码；不认识的一律当 UTF-8，不因为一个拼错的名字把连接卡死
pub fn resolve(label: Option<&str>) -> &'static Encoding {
    match label {
        None => UTF_8,
        Some(name) if name.trim().is_empty() => UTF_8,
        Some(name) => Encoding::for_label(name.trim().as_bytes()).unwrap_or(UTF_8),
    }
}

/// 一整块字节 → 文本（读文件用；终端流那种要接着上一块的，用 Decoder）
pub fn decode(bytes: &[u8], encoding: &'static Encoding) -> (String, bool) {
    let (text, _, had_errors) = encoding.decode(bytes);
    (text.into_owned(), had_errors)
}

/// 文本 → 字节（写文件、往终端发输入都用它）
pub fn encode(text: &str, encoding: &'static Encoding) -> Vec<u8> {
    let (bytes, _, _) = encoding.encode(text);
    bytes.into_owned()
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
        let bytes = encode("中文配置", gbk);
        // GBK 里一个汉字两字节，跟 UTF-8 的三字节不一样 —— 确认真的走了 GBK
        assert_eq!(bytes.len(), 8);
        let (back, bad) = decode(&bytes, gbk);
        assert_eq!(back, "中文配置");
        assert!(!bad);
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
        let bytes = encode("中文", gbk);
        let (_, bad) = decode(&bytes, UTF_8);
        assert!(bad, "GBK 字节按 UTF-8 解就该报错");
    }
}
