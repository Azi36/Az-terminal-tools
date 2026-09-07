export type Protocol = "ssh" | "sftp" | "ftp";
export type AuthType = "password" | "key";

export interface Connection {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  /** 密钥认证时的私钥文件路径（仅路径落盘，私钥内容/密码不落盘） */
  keyPath?: string;
  group: string;
  color: string;
  /** 终端字符编码；不填按 UTF-8。老服务器上常是 gbk */
  encoding?: string;
  /** 先过哪台跳板机（另一条连接的 id）；不填就直连 */
  jumpId?: string;
  /**
   * 把 shell 跑在 tmux / screen 里：断线时服务器那边的活儿还在，
   * 重连会接回同一个会话而不是开一个新的。不填就是普通 shell。
   */
  persist?: "tmux" | "screen";
  /**
   * 连上之后自动往终端里敲的命令，一行一条。
   * 明文存在配置里，所以别往这儿写密码 —— 要密码就让命令自己去读钥匙串/环境变量。
   */
  initCommand?: string;
  /** 这台机器配的端口转发 */
  tunnels?: Tunnel[];
  createdAt: number;
  /** 手动置顶，永远排最前 */
  pinned?: boolean;
  /** 上次连上的时间，用来把常用的排前面 */
  lastUsedAt?: number;
  // 注意：密码 / 私钥内容 / 密码短语一个都不在这儿。
  // 密码和密码短语存系统钥匙串（见 src-tauri/src/creds.rs），私钥只存路径、
  // 内容连接时才读。所以这个对象整体导出成 JSON 也不会带出任何凭据。
}

/**
 * 端口转发。三种，跟 ssh 命令行的三个开关一一对应：
 * - local（-L）：本机开个口，连它等于连到服务器那边的某个地址
 * - socks（-D）：本机开个 SOCKS5 代理，浏览器挂上去当跳板
 * - remote（-R）：服务器那边开个口，从那边连过来落到本机
 */
export type TunnelKind = "local" | "socks" | "remote";

export interface Tunnel {
  id: string;
  kind: TunnelKind;
  /** 监听地址：local/socks 是本机的，remote 是服务器上的 */
  listenHost: string;
  listenPort: number;
  /** 转到哪儿（socks 由客户端自己说，不用填） */
  destHost: string;
  destPort: number;
  /** 连上服务器就自动把它开起来 */
  auto?: boolean;
}

export const TUNNEL_KINDS: { value: TunnelKind; label: string; hint: string }[] = [
  { value: "local", label: "本地转发", hint: "-L · 本机端口 → 服务器能到的地址" },
  { value: "socks", label: "动态代理", hint: "-D · 本机 SOCKS5，整台机器走服务器出网" },
  { value: "remote", label: "远程转发", hint: "-R · 服务器端口 → 本机的服务" },
];

/** 常用指令：存一次，以后一键插入终端 */
export interface Snippet {
  id: string;
  title: string;
  command: string;
  tag: string;
  createdAt: number;
}

/** 备忘录：随手记，纯本地 */
export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

/** 收藏目录：本地和每台服务器各自一套 */
export interface Bookmark {
  id: string;
  /** "local" 或连接 id —— 远程收藏跟着服务器走 */
  scope: string;
  path: string;
  label: string;
}

/** 会话标签里的五页 */
export type SessionMode = "term" | "files" | "stats" | "tunnel" | "config";

/**
 * 叫醒一个已经开着的会话标签：去哪一页、要不要顺手连上。
 * 侧栏第二次点同一台机器时用，标签靠 seq 认出「这是新的一次」。
 */
export interface Wake {
  seq: number;
  mode: SessionMode;
  connect: boolean;
}

/** 工作区标签页 */
export type Tab =
  /** 一台服务器一个标签，终端 / 文件 / 隧道 / 配置都在里面；同一台可以开多个 */
  | { id: string; kind: "session"; connId: string; initialMode?: SessionMode; autoConnect?: boolean }
  /** 只用于「新建连接」，存下来就变成会话标签 */
  | { id: string; kind: "conn"; connId: null }
  | { id: string; kind: "settings" }
  | { id: string; kind: "note"; noteId: string }
  /** 内置编辑器：远程文件靠 sourceTabId 找到那条还活着的会话 */
  | { id: string; kind: "file"; side: "local" | "remote"; path: string; name: string; sourceTabId: string }
  /** 日志查看器：大到编辑器不肯开的远程文件走这条路，只读，按需一屏一屏取 */
  | { id: string; kind: "log"; path: string; name: string; sourceTabId: string }
  /** 本地终端：本机起一个 shell，可以开好几个；cwd 是上次待的目录，恢复标签时从那儿起 */
  | { id: string; kind: "local"; cwd?: string }
  /** 数据库：一条连接一个标签，控制台 / 配置在里面 */
  | { id: string; kind: "db"; dbId: string; initialMode?: "console" | "config"; autoConnect?: boolean }
  /** 只用于「新建数据库连接」，存下来就变成 db 标签 */
  | { id: string; kind: "dbconn"; dbId: null };

// —— 数据库 ——
export type DbKind = "mysql" | "postgres" | "redis";

export interface DbConn {
  id: string;
  kind: DbKind;
  name: string;
  host: string;
  port: number;
  username: string;
  /** MySQL 的默认库 / PG 的库名 / Redis 的库编号 */
  database?: string;
  color: string;
  group: string;
  createdAt: number;
  lastUsedAt?: number;
  // 密码不在这儿：存系统钥匙串，按 id 取（跟 SSH 连接一个规矩）
}

export const DB_KINDS: { value: DbKind; label: string; port: number; user: string }[] = [
  { value: "mysql", label: "MySQL", port: 3306, user: "root" },
  { value: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  { value: "redis", label: "Redis", port: 6379, user: "" },
];

/** 目录项：本地 / 远程同一套形状（由 Rust 侧给出） */
export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link";
  size: number;
  /** Unix 秒 */
  mtime: number;
  mode?: number | null;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

/**
 * 协议。FTP 还没接上引擎 —— 标成 soon 让它在界面上灰着，
 * 不能选、也就不会出现「存好了一条连接，点进去发现连不了」这种事。
 */
export const PROTOCOLS: { value: Protocol; label: string; defaultPort: number; soon?: boolean }[] = [
  { value: "ssh", label: "SSH", defaultPort: 22 },
  { value: "sftp", label: "SFTP", defaultPort: 22 },
  { value: "ftp", label: "FTP", defaultPort: 21, soon: true },
];

/**
 * 字符编码。用的是 WHATWG 那套标签，跟浏览器和 Xshell 的编码菜单对得上。
 * 默认 UTF-8；国内老服务器和存量配置文件多半是 GBK。
 */
export const ENCODINGS: { value: string; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "gbk", label: "GBK / GB2312" },
  { value: "gb18030", label: "GB18030" },
  { value: "big5", label: "Big5（繁体）" },
  { value: "shift_jis", label: "Shift_JIS（日文）" },
  { value: "euc-kr", label: "EUC-KR（韩文）" },
  { value: "windows-1252", label: "Latin-1" },
];

export const DEFAULT_ENCODING = "utf-8";

/** 连接标签色（家族调色板） */
export const COLORS = ["#1e40d8", "#00953a", "#d96716", "#7c3aed", "#d63384", "#0aa5a5"];

export const DEFAULT_GROUP = "默认";

/** 用户名留空就按它连 —— 十有八九就是 root，没必要逼着人敲一遍 */
export const DEFAULT_USER = "root";
export const DEFAULT_TAG = "常用";

export const PERSIST_KINDS: { value: "" | "tmux" | "screen"; label: string; hint: string }[] = [
  { value: "", label: "不用", hint: "普通 shell。断线时正在跑的命令会跟着没" },
  { value: "tmux", label: "tmux", hint: "断了活儿还在，重连接回同一个会话（tmux new-session -A）" },
  { value: "screen", label: "screen", hint: "同上，给没装 tmux 的老机器用（screen -xRR）" },
];

/**
 * 这条连接固定用哪个持久会话名。
 * 必须是稳定的 —— 每次算出来的不一样的话，重连就接不回原来那个了。
 * 只取 id 的前 8 位十六进制，够分辨，也在 tmux 的命名规矩里。
 */
export const persistNameOf = (connId: string) => `az-${connId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "default"}`;
