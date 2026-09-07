import type { SessionMode } from "./types";

/**
 * 应用级快捷键，只此一处。App.tsx 按它分发，Terminal.tsx 按它放行，
 * 右键菜单和设置页里显示的也是这张表 —— 改键位只改这儿。
 *
 * 规矩：**一律带 Shift 或 Alt**。不带 Shift 的 Ctrl 组合在 shell 里几乎都有正经用途
 * （Ctrl+W 删一个词、Ctrl+T 换字符、Ctrl+P 上一条历史、Ctrl+1..9 在 vim 里是数字前缀），
 * 终端有焦点时抢了就是给用户添堵。Ctrl+Tab 是唯一的例外：shell 里没这个键。
 */
export type AppAction =
  | "palette"
  | "newConn"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "nthTab"
  | "settings"
  | "sidebar"
  | "page";

/** 给人看的写法 */
export const SHORTCUTS = {
  palette: "Ctrl+Shift+P",
  newConn: "Ctrl+Shift+T",
  closeTab: "Ctrl+Shift+W",
  nextTab: "Ctrl+Tab",
  prevTab: "Ctrl+Shift+Tab",
  nthTab: "Alt+1…9",
  settings: "Ctrl+Shift+,",
  sidebar: "Ctrl+Shift+B",
} as const;

/** 会话标签里的几页，按工具条上的顺序 1..5 */
export const PAGE_ORDER: SessionMode[] = ["term", "files", "stats", "tunnel", "config"];
export const PAGE_SHORTCUTS: Record<SessionMode, string> = {
  term: "Ctrl+Shift+1",
  files: "Ctrl+Shift+2",
  stats: "Ctrl+Shift+3",
  tunnel: "Ctrl+Shift+4",
  config: "Ctrl+Shift+5",
};

export type Matched =
  | { action: Exclude<AppAction, "nthTab" | "page"> }
  | { action: "nthTab"; nth: number }
  | { action: "page"; page: SessionMode };

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 数字键：先看 `code`（Digit1..9，跟布局无关），拿不到再看 `key`。
 * 按住 Shift 时 `key` 在美式布局上是 `!@#`，所以那一排也认；
 * 远程桌面、自动化工具合成的按键往往没有扫描码，`code` 是空的，那时只能靠 `key`。
 */
function digitOf(e: KeyLike): number | null {
  const byCode = /^Digit([1-9])$/.exec(e.code);
  if (byCode) return Number(byCode[1]);
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
  const shifted = "!@#$%^&*(".indexOf(e.key);
  return shifted >= 0 ? shifted + 1 : null;
}

/**
 * 按键事件 → 应用动作；不是应用快捷键就返回 null。
 * macOS 上 Cmd 当 Ctrl 用。
 */
export function matchShortcut(e: KeyLike): Matched | null {
  const ctrl = e.ctrlKey || e.metaKey;
  // Alt+1..9：跳到第几个标签（跟 Firefox / VS Code 一个规矩）
  if (e.altKey && !ctrl && !e.shiftKey) {
    const nth = digitOf(e);
    return nth ? { action: "nthTab", nth } : null;
  }
  if (!ctrl || e.altKey) return null;
  if (e.key === "Tab") return { action: e.shiftKey ? "prevTab" : "nextTab" };
  if (!e.shiftKey) return null;
  const key = e.key.toLowerCase();
  if (key === "p") return { action: "palette" };
  if (key === "t") return { action: "newConn" };
  if (key === "w") return { action: "closeTab" };
  if (key === "b") return { action: "sidebar" };
  if (e.code === "Comma" || e.key === "," || e.key === "<") return { action: "settings" };
  const page = digitOf(e);
  if (page && page <= PAGE_ORDER.length) return { action: "page", page: PAGE_ORDER[page - 1] };
  return null;
}

/** 设置页里的速查表 */
export const SHORTCUT_GROUPS: { title: string; items: { keys: string; what: string }[] }[] = [
  {
    title: "标签",
    items: [
      { keys: SHORTCUTS.nextTab, what: "下一个标签" },
      { keys: SHORTCUTS.prevTab, what: "上一个标签" },
      { keys: SHORTCUTS.nthTab, what: "跳到第几个标签，9 是最后一个" },
      { keys: SHORTCUTS.newConn, what: "新建连接" },
      { keys: SHORTCUTS.closeTab, what: "关掉当前标签" },
    ],
  },
  {
    title: "会话里的几页",
    items: [
      { keys: PAGE_SHORTCUTS.term, what: "终端" },
      { keys: PAGE_SHORTCUTS.files, what: "文件（SFTP）" },
      { keys: PAGE_SHORTCUTS.stats, what: "状态" },
      { keys: PAGE_SHORTCUTS.tunnel, what: "隧道" },
      { keys: PAGE_SHORTCUTS.config, what: "这条连接的配置" },
    ],
  },
  {
    title: "终端",
    items: [
      { keys: "Ctrl+Shift+C", what: "复制选中的（没选中时照常是中断）" },
      { keys: "Ctrl+Shift+V", what: "粘贴" },
      { keys: "Ctrl+Shift+F", what: "在回滚里找字" },
      { keys: "Ctrl+Shift+A", what: "全选" },
      { keys: "Ctrl+Shift+K", what: "清屏（只清本地回滚）" },
      { keys: "→", what: "采纳命令补全建议" },
    ],
  },
  {
    title: "全局",
    items: [
      { keys: SHORTCUTS.palette, what: "命令面板" },
      { keys: SHORTCUTS.settings, what: "设置" },
      { keys: SHORTCUTS.sidebar, what: "收起 / 展开侧栏" },
    ],
  },
  {
    title: "编辑器 / 文件面板",
    items: [
      { keys: "Ctrl+S", what: "编辑器：保存" },
      { keys: "Ctrl+F / Ctrl+H / Ctrl+G", what: "编辑器：查找 / 替换 / 跳行" },
      { keys: "Ctrl+C / X / V", what: "文件面板：复制 / 剪切 / 粘贴（粘到对面那栏就是传输）" },
      { keys: "F2 / Del / Backspace", what: "文件面板：改名 / 删除 / 上级目录" },
    ],
  },
];
