import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  loadBookmarks,
  loadConnections,
  loadDbs,
  loadNotes,
  loadSettings,
  loadSnippets,
  newId,
  saveBookmark,
  saveConnection,
  saveDb,
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
  type DbConn,
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
  /** 数据库连接（密码不在里面，跟 SSH 一样在钥匙串）；老备份没有这一段 */
  dbs?: DbConn[];
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
  dbs: loadDbs(),
});

const stamp = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
};

/**
 * 导出：选个位置，把上面那堆写成 JSON。
 *
 * 给了口令就加密（Argon2id + XChaCha20-Poly1305，见 src-tauri/src/vault.rs）。
 * 里面本来就没有密码，但主机名、用户名、跳板机链路、内网端口本身就是情报 ——
 * 这份文件要是进了网盘或者聊天记录，等于把内网地图递出去。
 */
export async function exportAll(passphrase?: string): Promise<string | null> {
  const sealed = !!passphrase;
  const path = await save({
    title: sealed ? "加密导出 AzTerm 配置" : "导出 AzTerm 配置",
    defaultPath: `az-term-备份-${stamp()}${sealed ? ".enc" : ""}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  const plain = JSON.stringify(collect(), null, 2);
  const content = sealed
    ? await invoke<string>("vault_seal", { plaintext: plain, passphrase })
    : plain;
  await invoke("local_write_text", { path, content, encoding: "utf-8" });
  return path;
}

/** 导入的结果，好告诉用户到底进来了多少东西 */
export interface ImportResult {
  connections: number;
  snippets: number;
  notes: number;
  bookmarks: number;
  settings: boolean;
  dbs: number;
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
    // 这一栏连上就自动执行，理论上别人的备份文件里能藏东西。还是留着：
    // 这个文件的正经用途是「自己换台机器搬家」，丢了它自己的备份就还不回来。
    // 真要防「拿别人的文件」，丢一个 initCommand 也不顶用 —— 上面 jumpId 和
    // tunnels 本来就没还原，这个格式从来就不保证能完整搬运别人的配置。
    // 只截断到一屏能看完的长度，配置页上那一栏一眼扫得到，藏不住长脚本。
    initCommand:
      typeof raw.initCommand === "string" && raw.initCommand.trim()
        ? raw.initCommand.trim().slice(0, 1000)
        : undefined,
    persist: raw.persist === "tmux" || raw.persist === "screen" ? raw.persist : undefined,
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
 * 挑一个备份文件读进来，顺便告诉调用方它是不是加密的。
 *
 * 「读文件」和「套用」分成两步，是因为加密的那种中间要停下来问口令 ——
 * 揉在一个函数里就得在数据层弹窗，那是界面的事。
 */
export async function pickBackup(): Promise<{ path: string; content: string; sealed: boolean } | null> {
  const picked = await open({
    title: "导入 AzTerm 配置",
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;
  const file = await invoke<{ content: string }>("local_read_text", { path, encoding: "utf-8" });
  const sealed = await invoke<boolean>("vault_is_sealed", { text: file.content });
  return { path, content: file.content, sealed };
}

/** 拿口令把加密的那种解开，返回里面的明文 JSON */
export const unseal = (content: string, passphrase: string) =>
  invoke<string>("vault_open", { sealed: content, passphrase });

/**
 * 套用一份（已经是明文的）备份：按 id 覆盖同一条，其余追加。
 * 同一份备份导两次不会变成两套 —— id 是同一个，第二次就是覆盖。
 */
export async function applyBackup(content: string): Promise<ImportResult> {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error("这个文件不是合法的 JSON");
  }
  const backup = data as Partial<Backup>;
  if (!backup || backup.app !== "az-term") {
    throw new Error("这不像是 AzTerm 导出的备份文件");
  }

  const result: ImportResult = { connections: 0, snippets: 0, notes: 0, bookmarks: 0, settings: false, dbs: 0 };

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
  if (isArray(backup.dbs)) {
    for (const raw of backup.dbs as Partial<DbConn>[]) {
      const kind = raw?.kind === "mysql" || raw?.kind === "postgres" || raw?.kind === "redis" ? raw.kind : null;
      const host = typeof raw?.host === "string" ? raw.host.trim() : "";
      if (!kind || !host) continue;
      const port = Number(raw.port);
      saveDb({
        id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
        kind,
        name: (typeof raw.name === "string" && raw.name.trim()) || host,
        host,
        port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 3306,
        username: typeof raw.username === "string" ? raw.username : "",
        database: typeof raw.database === "string" && raw.database ? raw.database : undefined,
        color: typeof raw.color === "string" && raw.color ? raw.color : COLORS[0],
        group: (typeof raw.group === "string" && raw.group.trim()) || DEFAULT_GROUP,
        createdAt: Number(raw.createdAt) || Date.now(),
        lastUsedAt: Number(raw.lastUsedAt) || undefined,
      });
      result.dbs += 1;
    }
  }
  if (isArray(backup.dbs)) {
    for (const raw of backup.dbs as Partial<DbConn>[]) {
      const kind = raw?.kind === "mysql" || raw?.kind === "postgres" || raw?.kind === "redis" ? raw.kind : null;
      const host = typeof raw?.host === "string" ? raw.host.trim() : "";
      if (!kind || !host) continue;
      const port = Number(raw.port);
      saveDb({
        id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
        kind,
        name: (typeof raw.name === "string" && raw.name.trim()) || host,
        host,
        port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 3306,
        username: typeof raw.username === "string" ? raw.username : "",
        database: typeof raw.database === "string" && raw.database ? raw.database : undefined,
        color: typeof raw.color === "string" && raw.color ? raw.color : COLORS[0],
        group: (typeof raw.group === "string" && raw.group.trim()) || DEFAULT_GROUP,
        createdAt: Number(raw.createdAt) || Date.now(),
        lastUsedAt: Number(raw.lastUsedAt) || undefined,
      });
      result.dbs += 1;
    }
  }
  if (backup.settings && typeof backup.settings === "object") {
    // 全局热键、网盘地址 / 账号 / 上次同步时间是这台机器自己的事，不该被别的机器的备份改掉
    const { hotkey: _hotkey, syncUrl: _url, syncUser: _user, syncedAt: _at, ...portable } = backup.settings as Partial<AppSettings>;
    saveSettings({ ...loadSettings(), ...portable });
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

/** 别的工具的导出文件里认出来的一台机器 */
export interface Found {
  name: string;
  host: string;
  port: number;
  username: string;
  /** "xshell" / "putty" / "json" */
  source: string;
}

const SOURCE_LABEL: Record<string, string> = { xshell: "Xshell", putty: "PuTTY", json: "JSON" };
export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source;

/**
 * 从别的 SSH 工具的导出文件里捞服务器。
 *
 * 只认主机 / 端口 / 用户名三样。**密码一概不认** —— 那几家的密码是用它们自己的
 * 密钥加密的，解得开也不该解；导进来的连接第一次连的时候自己输一次。
 */
export async function scanForeign(): Promise<Found[] | null> {
  const picked = await open({
    title: "选别的工具导出的文件",
    multiple: true,
    filters: [
      { name: "会话文件", extensions: ["xsh", "reg", "json"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (paths.length === 0) return null;
  return invoke<Found[]>("import_scan", { paths });
}

/** 把认出来的那些变成连接（跟 ssh config 那条路一个规矩：密码留到第一次连再输） */
export function adoptForeign(rows: Found[]): number {
  const had = new Set(loadConnections().map((one) => `${one.host}|${one.username}|${one.port}`));
  let count = 0;
  rows.forEach((one, i) => {
    const username = one.username || DEFAULT_USER;
    // 已经有同样一台就跳过，导两次不该变成两条；同一批文件里重复的也只收一条
    const key = `${one.host}|${username}|${one.port}`;
    if (had.has(key)) return;
    had.add(key);
    saveConnection({
      id: newId(),
      name: one.name || one.host,
      protocol: "ssh",
      host: one.host,
      port: one.port,
      username,
      authType: "password",
      group: "导入",
      color: COLORS[i % COLORS.length],
      encoding: DEFAULT_ENCODING,
      createdAt: Date.now() + i,
    });
    count += 1;
  });
  return count;
}

// ─────────────────────────── WebDAV 同步 ───────────────────────────

/**
 * 上传：先用口令封起来再传。
 *
 * **传上去的永远是密文**，这一条不给开关。备份里虽然没有密码，但主机名、用户名、
 * 跳板机链路、内网端口就是一张内网地图，放在别人的服务器上必须是加密的。
 */
export async function syncPush(url: string, username: string, passphrase: string): Promise<void> {
  const sealed = await invoke<string>("vault_seal", {
    plaintext: JSON.stringify(collect(), null, 2),
    passphrase,
  });
  await invoke("sync_put_saved", { url, username, body: sealed });
}

/**
 * 下载并套用。返回 null 表示服务器上还没有这个文件（第一次同步的正常情况）。
 *
 * 是覆盖式的：同 id 的覆盖，其余追加 —— 跟本地导入一个规矩。
 * 不做三方合并，一个人用的工具里，「上次在哪台机器上改的」他自己清楚，
 * 替他猜反而会把东西弄丢。
 */
export async function syncPull(
  url: string,
  username: string,
  passphrase: string,
): Promise<ImportResult | null> {
  const got = await invoke<{ content: string | null }>("sync_get_saved", { url, username });
  if (got.content === null) return null;
  const plain = await unseal(got.content, passphrase);
  return applyBackup(plain);
}
