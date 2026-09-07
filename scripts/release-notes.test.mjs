/**
 * `node --test scripts/` 跑这些。
 *
 * 值得测的理由：这个脚本挂了不会有人当场发现 —— 出包照样成功，
 * 只是草稿正文悄悄退化成占位符，等到发布那天才看出来。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildNotes, pickSection, toPlain } from "./release-notes.mjs";

const SAMPLE = `# 更新日志

开头这段说明不该被算进任何一版。

## 0.9.0 —— 2026-09-08

### 新增

- **头一条**。第一句。
  这是它的续行。
- **第二条**，里头有 \`代码\` 和 [链接](https://example.com)。

### 修复

- 修了个东西。

## 0.8.0 —— 2026-09-08

### 新增

- 上一版的内容，不该串进 0.9.0。
`;

test("只取这一版，不串到下一版", () => {
  const got = pickSection(SAMPLE, "0.9.0");
  assert.ok(got.includes("头一条"));
  assert.ok(!got.includes("上一版的内容"), "串到 0.8.0 的内容了");
  assert.ok(!got.includes("开头这段说明"), "把文件抬头也算进来了");
});

test("找不到就返回 null，不是抛错也不是空字符串", () => {
  assert.equal(pickSection(SAMPLE, "9.9.9"), null);
});

test("版本号里的点不当通配符使", () => {
  // 0.9.0 当正则用的话能匹配上 «0x9y0»
  const fake = "## 0x9y0 —— 2026-01-01\n\n- 不该被匹配上\n";
  assert.equal(pickSection(fake, "0.9.0"), null);
});

test("tag 带不带 v 都认", () => {
  assert.ok(pickSection("## v1.2.3 —— 2026-01-01\n\n- 内容\n", "1.2.3"));
});

test("markdown 标记压成纯文本", () => {
  const out = toPlain(pickSection(SAMPLE, "0.9.0"));
  assert.ok(!out.includes("**"), "粗体标记没去掉");
  assert.ok(!out.includes("###"), "小节的井号没去掉");
  assert.ok(!out.includes("`"), "反引号没去掉");
  assert.ok(out.includes("链接"), "链接文字被一起删了");
  assert.ok(!out.includes("https://example.com"), "链接地址应该丢掉");
  assert.ok(out.includes("· 头一条"), "列表符号没换成 ·");
  assert.ok(out.includes("  这是它的续行"), "续行的缩进没保住");
});

test("顶格条目之间空一行", () => {
  const out = toPlain(pickSection(SAMPLE, "0.9.0"));
  assert.ok(out.includes("。\n\n· 第二条"), `条目之间没空行：\n${out}`);
});

test("整段正文带上开头那句下载说明", () => {
  const out = buildNotes(SAMPLE, "0.9.0");
  assert.ok(out.startsWith("Windows 装 .msi，macOS 装 .dmg。\n\n"));
  assert.ok(out.endsWith("\n"));
});

test("找不到那一版时 buildNotes 也返回 null，让调用方兜底", () => {
  assert.equal(buildNotes(SAMPLE, "9.9.9"), null);
});

test("真的 CHANGELOG 里，当前版本抠得出来", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const notes = buildNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  assert.ok(notes, `CHANGELOG.md 里没有 ${version} 这一节 —— 发版前该补上`);
});
