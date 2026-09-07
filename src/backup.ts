import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  loadBookmarks,
  loadConnections,
  loadNotes,
  loadSettings,
  loadSnippets,
  newId,
  saveBookmark,
  saveConnection,
  saveNote,
  saveSettings,
  saveSnippet,
  type AppSettings,
} from "./store";
import {
  COLORS,
  DEFAULT_ENCODING,
  DEFAULT_GROUP,
  DEFAULT_USER,
  type Bookmark,
  type Connection,
  type Note,
  type Snippet,
  type Tunnel,
} from "./types";

/**
 * 备份文件。
 *
 * 连接、指令、备忘、收藏、偏好设置全在里面 —— 换台机器把这个文件搬过去就完事。
 * **密码不在里面**：它们在系统钥匙串里，导出到一个明文 JSON 会把整个「不落明文」
 * 的设计毁掉。到新机器上第一次连的时候再输一次，就这一次。
 */
export interface Backup {
  app: "az-term";
  version: number;
  exportedAt: number;
  connections: Connection[];
  snippets: Snippet[];
  notes: Note[];
  bookmarks: Bookmark[];
  settings: AppSettings;
}

const FORMAT = 1;

export const collect = (): Backup => ({
  app: "az-term",
  version: FORMAT,
  exportedAt: Date.now(),
  connections: loadConnections(),
  snippets: loadSnippets(),
  notes: loadNotes(),
  bookmarks: loadBookmarks(),
  settings: loadSettings(),
});

const stamp = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
};

/** 导出：选个位置，把上面那堆写成 JSON */
export async function exportAll(): Promise<string | null> {
  const path = await save({
    title: "导出 AzTerm 配置",
    defaultPath: `az-term-备份-${stamp()}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  await invoke("local_write_text", {
    path,
    content: JSON.stringify(collect(), null, 2),
    encoding: "utf-8",
  });
  return path;
}

/** 导入的结果，好告诉用户到底进来了多少东西 */
export interface ImportResult {
  connections: number;
  snippets: number;
  notes: number;
  bookmarks: number;
  settings: boolean;
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * 一条连接从外面进来时要洗一遍：
 * 别人的文件里什么都可能有，缺字段的补上默认值，不该有的（密码之类）扔掉。
 */
const cleanPort = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

/** 隧道逐条校验：类型、端口不对的整条丢掉，别把坏配置带进引擎 */
function cleanTunnel(raw: unknown): Tunnel | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const kind = t.kind === "local" || t.kind === "socks" || t.kind === "remote" ? t.kind : null;
  if (!kind) return null;
  const listenPort = cleanPort(t.listenPort);
  if (!listenPort) return null;
  // socks 不用填目标，其它两种目标端口必须合法
  const destPort = kind === "socks" ? (cleanPort(t.destPort) ?? 0) : cleanPort(t.destPort);
  if (destPort === null) return null;
  return {
    id: typeof t.id === "string" && t.id ? t.id : newId(),
    kind,
    listenHost: typeof t.listenHost === "string" && t.listenHost ? t.listenHost : "127.0.0.1",
    listenPort,
    destHost: typeof t.destHost === "string" ? t.destHost : "",
    destPort,
    auto: !!t.auto,
  };
}

function cleanConn(raw: Record<string, unknown>): Connection | null {
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  // 用户名空着按 root（跟新建页一个规矩），别为这个把整条连接丢掉
  const username = (typeof raw.username === "string" ? raw.username.trim() : "") || DEFAULT_USER;
  if (!host) return null;
  const port = Number(raw.port);
  const tunnels = Array.isArray(raw.tunnels) ? raw.tunnels.map(cleanTunnel).filter((one): one is Tunnel => !!one) : [];
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    name: (typeof raw.name === "string" && raw.name.trim()) || host,
    protocol: raw.protocol === "sftp" || raw.protocol === "ftp" ? raw.protocol : "ssh",
    host,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 22,
    username,
    authType: raw.authType === "key" ? "key" : "password",
    keyPath: typeof raw.keyPath === "string" && raw.keyPath ? raw.keyPath : undefined,
    group: (typeof raw.group === "string" && raw.group.trim()) || DEFAULT_GROUP,
    color: typeof raw.color === "string" && raw.color ? raw.color : COLORS[0],
    encoding: typeof raw.encoding === "string" && raw.encoding ? raw.encoding : DEFAULT_ENCODING,
    pinned: !!raw.pinned,
    createdAt: Number(raw.createdAt) || Date.now(),
    lastUsedAt: Number(raw.lastUsedAt) || undefined,
    // 跳板机和隧道不能丢：导入按 id 整条覆盖，少了这两个字段，
    // 本来过堡垒机的连接会变成直连
    jumpId: typeof raw.jumpId === "string" && raw.jumpId ? raw.jumpId : undefined,
    tunnels: tunnels.length > 0 ? tunnels : undefined,
  };
}

/**
 * 导入：按 id 覆盖同一条，其余追加。
 * 同一份备份导两次不会变成两套 —— id 是同一个，第二次就是覆盖。
 */
export async function importAll(): Promise<ImportResult | null> {
  const picked = await open({
    title: "导入 AzTerm 配置",
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;

  const file = await invoke<{ content: string }>("local_read_text", { path, encoding: "utf-8" });
  let data: unknown;
  try {
    data = JSON.parse(file.content);
  } catch {
    throw new Error("这个文件不是合法的 JSON");
  }
  const backup = data as Partial<Backup>;
  if (!backup || backup.app !== "az-term") {
    throw new Error("这不像是 AzTerm 导出的备份文件");
  }

  const result: ImportResult = { connections: 0, snippets: 0, notes: 0, bookmarks: 0, settings: false };

  if (isArray(backup.connections)) {
    for (const raw of backup.connections) {
      const conn = cleanConn((raw ?? {}) as unknown as Record<string, unknown>);
      if (conn) { saveConnection(conn); result.connections += 1; }
    }
  }
  if (isArray(backup.snippets)) {
    for (const raw of backup.snippets as Snippet[]) {
      if (typeof raw?.command !== "string" || !raw.command.trim()) continue;
      saveSnippet({
        id: raw.id || newId(),
        title: raw.title?.trim() || raw.command.trim().slice(0, 24),
        command: raw.command,
        tag: raw.tag?.trim() || "常用",
        createdAt: Number(raw.createdAt) || Date.now(),
      });
      result.snippets += 1;
    }
  }
  if (isArray(backup.notes)) {
    for (const raw of backup.notes as Note[]) {
      if (typeof raw?.body !== "string" && typeof raw?.title !== "string") continue;
      saveNote({
        id: raw.id || newId(),
        title: raw.title ?? "",
        body: raw.body ?? "",
        updatedAt: Number(raw.updatedAt) || Date.now(),
      });
      result.notes += 1;
    }
  }
  if (isArray(backup.bookmarks)) {
    for (const raw of backup.bookmarks as Bookmark[]) {
      if (!raw?.path || !raw?.scope) continue;
      saveBookmark({ id: raw.id || newId(), scope: raw.scope, path: raw.path, label: raw.label || raw.path });
      result.bookmarks += 1;
    }
  }
  if (backup.settings && typeof backup.settings === "object") {
    saveSettings({ ...loadSettings(), ...backup.settings });
    result.settings = true;
  }

  return result;
}

/** ~/.ssh/config 里的一台机器 */
export interface ConfigHost {
  alias: string;
  host: string;
  user: string;
  port: number;
  keyPath: string | null;
}

/** 读 ~/.ssh/config，返回还没导进来的那些（已经有同样 host+user+port 的就不重复列） */
export async function scanSshConfig(): Promise<{ hosts: ConfigHost[]; already: number }> {
  const hosts = await invoke<ConfigHost[]>("ssh_config_hosts");
  const had = new Set(loadConnections().map((one) => `${one.host}|${one.username}|${one.port}`));
  const fresh = hosts.filter((one) => !had.has(`${one.host}|${one.user || "root"}|${one.port}`));
  return { hosts: fresh, already: hosts.length - fresh.length };
}

/** 把挑中的那些变成连接（密码还是要连的时候现输，配置文件里本来也没有） */
export function adoptSshConfig(hosts: ConfigHost[]): number {
  hosts.forEach((one, i) => {
    saveConnection({
      id: newId(),
      name: one.alias,
      protocol: "ssh",
      host: one.host,
      port: one.port,
      username: one.user || "root",
      authType: one.keyPath ? "key" : "password",
      keyPath: one.keyPath ?? undefined,
      group: "ssh config",
      color: COLORS[i % COLORS.length],
      encoding: DEFAULT_ENCODING,
      createdAt: Date.now() + i,
    });
  });
  return hosts.length;
}
