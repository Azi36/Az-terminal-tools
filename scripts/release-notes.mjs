#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抠出某一版的小节，转成 GitHub Release 的正文。
 *
 * 用法：`node scripts/release-notes.mjs v0.9.0`（也可以 `npm run notes -- v0.9.0`），
 * 结果打到 stdout；找不到对应小节就报错退 1，调用方自己兜底。
 *
 * 为什么要转一道，不直接把 markdown 贴过去：
 * 这段正文有两个去处。GitHub 的 Release 页面会渲染 markdown，但应用里
 * 「设置 → 关于」是用 `<pre>` 原样显示的（notes 由 notify.yml 推给版本接口），
 * `**粗体**` 和 `### 标题` 在那儿会把星号井号直接露出来。所以统一压成纯文本：
 * 标记去掉、`- ` 换成 `· `，两边都干净。
 *
 * 0.8.0 那次是人工从渲染后的页面复制的，markdown 标记整个丢了、条目挤成一坨——
 * 这个脚本就是来顶掉那一步的。
 *
 * 注意它给的是**起点不是终点**：CHANGELOG 写得细是对的，Release 正文该短。
 * 出包流程只把它填进草稿，发布前自己再删几句。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 正文开头那句，跟版本无关，一直有 */
const HEAD = "Windows 装 .msi，macOS 装 .dmg。";

/**
 * 抠出 `## <版本> —— <日期>` 到下一个 `## ` 之间的内容。
 * 日期部分不参与匹配：补发旧版本时日期可能对不上，版本号对上就够了。
 */
export function pickSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  // 版本号里的点要转义，不然 0.9.0 会匹配上 0x9y0
  const head = new RegExp(`^##\\s+v?${version.replace(/\./g, "\\.")}(\\s|$)`);
  const start = lines.findIndex((line) => head.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** markdown → 纯文本。只处理 CHANGELOG 里实际用到的那几种标记 */
export function toPlain(section) {
  return section
    .split("\n")
    .map((line) => line
      // 「### 新增」这种小节名留着，井号去掉
      .replace(/^#{2,6}\s+/, "")
      // 顶格的列表项换成 ·，续行的两格缩进原样保留
      .replace(/^- /, "· ")
      .replace(/^ {2}- /, "  · ")
      // [文字](链接) 只留文字：<pre> 里显示不成链接，括号里那串是噪音
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/`/g, ""))
    .join("\n")
    // 顶格条目之间空一行。CHANGELOG 里它们是挨着的，那样在 <pre> 里糊成一片，
    // 读的人分不出哪句属于哪条
    .replace(/\n(· )/g, "\n\n$1")
    // 开头结尾的空行去掉，中间最多留一个空行
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildNotes(markdown, version) {
  const section = pickSection(markdown, version);
  if (section === null) return null;
  const body = toPlain(section);
  return body ? `${HEAD}\n\n${body}\n` : `${HEAD}\n`;
}

// 直接跑的时候才读文件、才输出；被 import 时只拿上面几个函数
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("要一个 tag，比如：node scripts/release-notes.mjs v0.9.0");
    process.exit(2);
  }
  const version = tag.replace(/^v/i, "");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const markdown = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const notes = buildNotes(markdown, version);
  if (notes === null) {
    console.error(`CHANGELOG.md 里没有 ${version} 这一节`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
