import type { Bookmark, Connection, Note, Snippet } from "./types";

/**
 * 本地存储。
 * 连接只存元数据（不含密码/私钥）；指令、备忘、收藏都是纯本地内容。
 * localStorage 在 Tauri webview 里是本地磁盘持久化，不出这台机器、不触网。
 * 后续可平滑换成 Tauri store 插件 + keyring 加密敏感字段。
 */

const KEYS = {
  connections: "az-term-connections",
  snippets: "az-term-snippets",
  notes: "az-term-notes",
  bookmarks: "az-term-bookmarks",
} as const;

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, list: T[]): T[] {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
  return list;
}

/** 通用增改：按 id 覆盖，没有就追加 */
function upsert<T extends { id: string }>(key: string, item: T): T[] {
  const list = read<T>(key);
  const index = list.findIndex((one) => one.id === item.id);
  if (index >= 0) list[index] = item;
  else list.push(item);
  return write(key, list);
}

function drop<T extends { id: string }>(key: string, id: string): T[] {
  return write(key, read<T>(key).filter((one) => one.id !== id));
}

// —— 连接 ——
export const loadConnections = () => read<Connection>(KEYS.connections);
export const saveConnection = (conn: Connection) => upsert(KEYS.connections, conn);
export const deleteConnection = (id: string) => drop<Connection>(KEYS.connections, id);

// —— 指令库 ——
export const loadSnippets = () => read<Snippet>(KEYS.snippets);
export const saveSnippet = (snippet: Snippet) => upsert(KEYS.snippets, snippet);
export const deleteSnippet = (id: string) => drop<Snippet>(KEYS.snippets, id);

// —— 备忘录 ——
export const loadNotes = () => read<Note>(KEYS.notes);
export const saveNote = (note: Note) => upsert(KEYS.notes, note);
export const deleteNote = (id: string) => drop<Note>(KEYS.notes, id);

// —— 收藏目录 ——
export const loadBookmarks = () => read<Bookmark>(KEYS.bookmarks);
export const saveBookmark = (mark: Bookmark) => upsert(KEYS.bookmarks, mark);
export const deleteBookmark = (id: string) => drop<Bookmark>(KEYS.bookmarks, id);

// —— 上次待的目录 ——
// scope："local" 或连接 id。下次开文件面板直接回到那儿，不用从主目录一层层点。
const DIRS_KEY = "az-term-lastdirs";

export function lastDir(scope: string): string {
  try {
    const raw = localStorage.getItem(DIRS_KEY);
    if (!raw) return "";
    const map = JSON.parse(raw);
    return typeof map?.[scope] === "string" ? map[scope] : "";
  } catch {
    return "";
  }
}

export function rememberDir(scope: string, path: string) {
  if (!path) return;
  try {
    const raw = localStorage.getItem(DIRS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[scope] = path;
    localStorage.setItem(DIRS_KEY, JSON.stringify(map));
  } catch {}
}

// —— 偏好设置 ——
export interface AppSettings {
  /** 空闲多少分钟自动断开；0 = 不断 */
  idleMinutes: number;
  /** 侧栏分区折起来了没 */
  foldServers: boolean;
  foldDb: boolean;
  /** 终端配色方案 id 和字号 */
  termScheme: string;
  termFontSize: number;
  /** 终端用深版还是浅版：auto = 跟着界面深浅走 */
  termVariant: "auto" | "dark" | "light";
  /** 每条命令之间画一条细分割线 */
  termDivider: boolean;
  /** 主机指纹校验：auto 头回自动记 · ask 头回问一句 · off 不校验 */
  hostPolicy: "auto" | "ask" | "off";
  /** 同时传几个文件：小文件多的目录靠这个提速，但线路差的时候别开太大 */
  xferLanes: number;
  /** 掉线自动接回来（手上有凭据时才会自动，否则还是要你输密码） */
  autoReconnect: boolean;
  /** 下次打开时把上次的标签摆回来 */
  restoreTabs: boolean;
  /** 开起来之后顺手问一句「有没有新版」（只发一个 GET，不带身份不上报） */
  updateNotice: boolean;
}

const SETTINGS_KEY = "az-term-settings";
const DEFAULT_SETTINGS: AppSettings = {
  idleMinutes: 0,
  foldServers: false,
  foldDb: true,
  termScheme: "az",
  termFontSize: 13,
  termVariant: "auto",
  termDivider: true,
  hostPolicy: "auto",
  xferLanes: 3,
  autoReconnect: true,
  restoreTabs: true,
  updateNotice: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
  return settings;
}

// —— 上次开着哪些标签 ——
// 只记「哪台服务器 / 哪条备忘」这种能重新摆出来的东西。
// 编辑器标签不记：那要求远程会话还活着，恢复出来只会是一堆报错。
const TABS_KEY = "az-term-open-tabs";

export type SavedTab =
  | { kind: "session"; connId: string; mode?: string }
  | { kind: "note"; noteId: string }
  | { kind: "settings" };

export function loadOpenTabs(): SavedTab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveOpenTabs(tabs: SavedTab[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {}
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
}
