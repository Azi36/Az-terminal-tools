import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Terminal } from "../components/Terminal";
import { SftpPanel } from "./SftpPanel";
import { ConnectionPage } from "./ConnectionPage";
import { StatsPanel } from "./StatsPanel";
import { TunnelPanel } from "./TunnelPanel";
import {
  IconCheck, IconFiles, IconGauge, IconKey, IconLink, IconLock, IconSettings, IconTerminal, IconX,
} from "../components/icons";
import { Dialog } from "../components/Dialog";
import type { MenuEntry } from "../components/ContextMenu";
import { PAGE_SHORTCUTS } from "../shortcuts";
import { newId } from "../store";
import { takeSecret } from "../secrets";
import { DEFAULT_ENCODING, ENCODINGS, persistNameOf, type Connection, type Tunnel, type Wake } from "../types";

type Mode = "term" | "files" | "stats" | "config" | "tunnel";

interface SessionViewProps {
  conn: Connection;
  /**
   * 有没有焦点。分屏时两块都在屏幕上，但只有一块是「当前」——
   * 拖拽上传、Del / F2 这类快捷键都得认焦点，两块都接就不知道该落到谁头上。
   */
  active: boolean;
  /** 在不在屏幕上（分屏时另一半也算）。只看不动手的东西（状态轮询）认它就够了 */
  visible: boolean;
  /** 空闲多少分钟自动断开；0 = 不断 */
  idleMinutes: number;
  /** 终端配色方案 id 和字号 */
  termScheme: string;
  termVariant: "dark" | "light";
  termFontSize: number;
  termDivider: boolean;
  /** 主机指纹校验策略 */
  hostPolicy: string;
  /** 同时传几个文件 */
  xferLanes: number;
  /** 掉线要不要自动接回来 */
  autoReconnect: boolean;
  /** 开标签时停在哪一页 */
  initialMode?: Mode;
  /** 开标签要不要顺手连上（双击进来是要连的，单击只是打开就不连） */
  autoConnect?: boolean;
  /** 侧栏又点了一次这台机器：切到它要的那页，该连就连 */
  wake?: Wake;
  /** 这个标签此刻停在哪一页：上层记下来，下次开应用摆回原样 */
  onMode?: (mode: Mode) => void;
  /** 会话建立 / 断开时告诉上层，指令库要往当前终端里塞命令 */
  onSession: (sessionId: string | null) => void;
  /** 文件面板里点了「编辑」→ 上层开一个编辑器标签 */
  onEditFile: (side: "local" | "remote", path: string) => void;
  /** 文件面板里点了「日志查看器」→ 上层开一个只读的大文件标签 */
  onOpenLog: (path: string) => void;
  /** 这个标签在不在同步输入组里 */
  inSync: boolean;
  /** 同步组里此刻有几台连着的（含自己）；小于 2 就等于没开 */
  syncCount: number;
  /** 把这个标签加入 / 移出同步组 */
  onToggleSync: () => void;
  /** 用户在这个终端里敲的东西，转给同步组里的其它会话 */
  onBroadcast: (data: string) => void;
  /** 配了跳板机的话，那条连接的配置（上层按 jumpId 找出来给我们） */
  jump?: Connection | null;
  onSaveConn: (conn: Connection) => void;
  onDeleteConn: (conn: Connection) => void;
  /** 配置页有没有没保存的改动 */
  onConfigDirty: (dirty: boolean) => void;
  /** 应用级的右键菜单条目（命令面板、新建连接……），接在终端菜单最后 */
  appMenu?: MenuEntry[];
}

interface HostKeyInfo {
  /** unknown 头一回见 · changed 指纹变了 */
  kind: "unknown" | "changed";
  algo: string;
  fingerprint: string;
}

/** 掉线后最多自动接几次 */
const RETRY_TIMES = 4;

/** 服务器在键盘交互认证里问的一组问题（2FA 验证码、过期密码之类） */
interface AuthPrompts {
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

type SshError = { message: string; detail?: string | null; hostKey?: HostKeyInfo; auth?: AuthPrompts };

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "open"; sessionId: string }
  /** 闲太久自动断的，回到这个标签就自己接上 */
  | { kind: "napped" }
  /** 服务器还要问几句（验证码之类），等用户回答 */
  | { kind: "asking" }
  | { kind: "error"; err: SshError };

/**
 * 一台服务器 = 一个标签：里面终端、文件、配置三页切换，不再往外开新页面。
 * 凭据记过一次（或用无密码短语的密钥）就直接连，不再拦一道输入框；
 * 密码本身存在系统钥匙串里，前端拿不到，只知道「存过没有」。
 */
export function SessionView({
  conn,
  active,
  visible,
  idleMinutes,
  termScheme,
  termVariant,
  termFontSize,
  termDivider,
  hostPolicy,
  xferLanes,
  autoReconnect,
  initialMode = "term",
  autoConnect = true,
  wake,
  onMode,
  jump,
  onSession,
  onEditFile,
  onOpenLog,
  inSync,
  syncCount,
  onToggleSync,
  onBroadcast,
  onSaveConn,
  onDeleteConn,
  onConfigDirty,
  appMenu,
}: SessionViewProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // 刚在配置页填过密码就接过来（只在内存里传，见 secrets.ts）：
  // 用 useState 的惰性初始化取，第一次 render 就到位，下面的自动连能直接用上
  const [seed] = useState(() => takeSecret(conn.id));
  const tellMode = useRef(onMode);
  tellMode.current = onMode;
  const [password, setPassword] = useState(conn.authType === "key" ? "" : seed?.secret ?? "");
  const [passphrase, setPassphrase] = useState(conn.authType === "key" ? seed?.secret ?? "" : "");
  const [saved, setSaved] = useState(false);
  const [remember, setRemember] = useState(seed?.remember ?? true);
  const [mode, setMode] = useState<Mode>(initialMode);
  /** 这条会话此刻用的编码（可以连着改，不用重连） */
  const [encoding, setEncoding] = useState(conn.encoding || DEFAULT_ENCODING);
  // 文件面板懒挂载，挂了就留着，切回来目录还在原处
  const [filesMounted, setFilesMounted] = useState(false);

  const isKey = conn.authType === "key";
  const open = phase.kind === "open";

  // 回调放 ref 里，父组件每次渲染都不会把下面的监听重挂一遍
  const notify = useRef(onSession);
  notify.current = onSession;

  const [askHost, setAskHost] = useState<HostKeyInfo | null>(null);
  const [askAuth, setAskAuth] = useState<AuthPrompts | null>(null);
  /** 掉线后自动重连的倒计时；null = 没在重连 */
  const [retry, setRetry] = useState<{ left: number; seconds: number } | null>(null);
  /** 端口表点了「转发到本地」，等用户确认本地开哪个口 */
  const [forwarding, setForwarding] = useState<{ port: number; label: string } | null>(null);
  /** 会话日志开着没有 */
  const [logging, setLogging] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  /** 这次断开是用户自己点的，不是掉线 */
  const byHand = useRef(false);
  const retryOn = useRef(autoReconnect);
  retryOn.current = autoReconnect;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  /** 认证没走完那条连接的 id：用户答完题要拿它接着往下认 */
  const attempt = useRef<{ sessionId: string; typed: string; silent: boolean } | null>(null);
  /** 「登录后执行」那一下的定时器；断开 / 卸载时要撤掉，不能敲进下一条会话 */
  const kickoff = useRef<number | null>(null);
  const dropKickoff = () => {
    if (kickoff.current !== null) window.clearTimeout(kickoff.current);
    kickoff.current = null;
  };

  /** 连上了：收拾输入框、挂上会话 */
  const settle = useCallback((sessionId: string) => {
    const tried = attempt.current;
    attempt.current = null;
    // 连上的时候标签已经关了（连接慢、用户等不及）：这条会话没人要，直接收掉
    if (!mounted.current) {
      invoke("ssh_close", { sessionId }).catch(() => {});
      return;
    }
    if (tried && !tried.silent && remember && tried.typed) setSaved(true);
    // 上次手动断开的标记到这儿一定过期了：close 事件有可能晚于监听卸掉才到，
    // 标记留着的话下一次真掉线会被当成"用户自己点的"吞掉
    byHand.current = false;
    setAskHost(null);
    setAskAuth(null);
    setPassword("");
    setPassphrase("");
    setPhase({ kind: "open", sessionId });
    notify.current(sessionId);
    // 落在文件页（或 SFTP 协议的连接）就直接把文件面板挂上
    setMode((current) => {
      const next = conn.protocol === "sftp" && current === "term" ? "files" : current;
      if (next === "files") setFilesMounted(true);
      return next;
    });

    // 「登录后执行」：走 ssh_write 当成用户自己敲的，命令和回显都留在终端里，
    // 编码转换也跟着这条会话走（GBK 的机器上照样能敲中文路径）。
    // 缓一下再敲 —— 登录 banner 和第一个提示符还在路上，抢在前头会跟 motd 挤成一行。
    const script = (conn.initCommand ?? "").trim();
    if (script) {
      dropKickoff();
      kickoff.current = window.setTimeout(() => {
        kickoff.current = null;
        const data = `${script.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n`;
        void invoke("ssh_write", { sessionId, data }).catch(() => {});
      }, 400);
    }
  }, [conn.protocol, conn.initCommand, remember]);

  /** 认证失败 / 断在半路：统一在这儿分流成「问指纹」「问验证码」「报错」 */
  const stumble = useCallback((e: unknown) => {
    // Rust 侧返回结构化错误 {message, detail, hostKey?, auth?}
    const err: SshError =
      e && typeof e === "object" && "message" in e
        ? (e as SshError)
        : { message: "连接失败", detail: String(e) };
    // 服务器还要问几句（2FA 验证码、过期密码）：把问题原样摆出来
    if (err.auth) {
      setAskAuth(err.auth);
      setPhase({ kind: "asking" });
      return;
    }
    attempt.current = null;
    // 不是在问验证码了，旧的问题卡片得撤掉，不然错误被它盖住、界面像卡死
    setAskAuth(null);
    // 主机指纹没过：把指纹摆出来让用户自己判断；已经信任过还报错就是别的问题，指纹卡片也撤
    setAskHost(err.hostKey ?? null);
    setPhase({ kind: "error", err });
  }, []);

  const connect = useCallback(async (silent = false, trustHost = false) => {
    if (conn.protocol === "ftp") return;
    // 已经在连或已经连上就别再来一条：密码框连按两下 Enter、倒计时归零撞上手动点击，
    // 都会走到这儿，第二条会话没人管，会一直挂在引擎里
    const live = phaseRef.current.kind;
    if (live === "connecting" || live === "open") return;
    if (isKey && !conn.keyPath) {
      setPhase({ kind: "error", err: { message: "这个连接没有配置私钥路径，去「配置」页补上" } });
      return;
    }
    // 配了跳板机却找不到那条连接（多半是被删了）：宁可停下，也不能闷声直连 ——
    // 本来就是因为直连不通（或者不该直连）才配的跳板
    if (conn.jumpId && !jump) {
      setPhase({
        kind: "error",
        err: { message: "这条连接配的跳板机不见了", detail: "那条连接可能已经删掉。去「配置」页重新指一台，或者改成直连。" },
      });
      return;
    }
    const typed = isKey ? passphrase : password;
    const sessionId = `${conn.id}-${Date.now()}`;
    attempt.current = { sessionId, typed, silent };
    setPhase({ kind: "connecting" });
    try {
      await invoke("ssh_connect", {
        params: {
          sessionId,
          connId: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          authType: conn.authType,
          password: isKey ? null : password || null,
          keyPath: isKey ? conn.keyPath : null,
          passphrase: isKey && passphrase ? passphrase : null,
          // 自动连的时候没有新凭据可记，别去动钥匙串
          remember: !silent && remember && typed !== "",
          trustHost,
          // 用户核对过的就是这一串；引擎拿它跟服务器这次给的钥匙比对，
          // 对不上照样拦下来 —— 不然「点信任」等于对任意钥匙放行
          trustFingerprint: trustHost ? askHost?.fingerprint ?? null : null,
          hostPolicy,
          encoding,
          // 断线重连要接回同一个持久会话，所以名字必须是这条连接固定的那个
          persist: conn.persist ?? null,
          persistName: conn.persist ? persistNameOf(conn.id) : null,
          // 配了跳板机就把那条连接的信息带上；它的密码从钥匙串里取，不在这儿传
          jump: jump
            ? {
                connId: jump.id,
                host: jump.host,
                port: jump.port,
                username: jump.username,
                authType: jump.authType,
                keyPath: jump.keyPath ?? null,
                hostPolicy,
              }
            : null,
        },
      });
      settle(sessionId);
    } catch (e) {
      stumble(e);
    }
  }, [conn, isKey, password, passphrase, remember, hostPolicy, encoding, jump, askHost, settle, stumble]);

  /** 把用户的回答送回引擎，接着往下认证 */
  const answer = useCallback(async (answers: string[]) => {
    const tried = attempt.current;
    if (!tried) return;
    setPhase({ kind: "connecting" });
    try {
      await invoke("ssh_answer", { sessionId: tried.sessionId, answers });
      settle(tried.sessionId);
    } catch (e) {
      stumble(e);
    }
  }, [settle, stumble]);

  /** 不答了：让引擎把那条半截连接丢掉，别挂在内存里 */
  const dropAuth = useCallback(() => {
    const tried = attempt.current;
    if (tried) invoke("ssh_cancel_auth", { sessionId: tried.sessionId }).catch(() => {});
    attempt.current = null;
    setAskAuth(null);
    setPhase({ kind: "idle" });
  }, []);

  const connectNow = useRef(connect);
  connectNow.current = connect;

  /** 用户自己点的连接：自动重连的倒计时作废，别一会儿又替他连一次 */
  const connectByHand = useCallback((trustHost = false) => {
    lastRetry.current = null;
    setRetry(null);
    void connect(false, trustHost);
  }, [connect]);

  // 标签关掉时这条连接还开着、还在连、或还在答验证码：App 那边只认已登记的会话，
  // 半截的得自己收，否则引擎里会漏一条连接一直挂到退出。登录后自动执行的计时器也一并清掉
  useEffect(() => () => {
    const live = phaseRef.current;
    if (live.kind === "open") invoke("ssh_close", { sessionId: live.sessionId }).catch(() => {});
    if (attempt.current) invoke("ssh_cancel_auth", { sessionId: attempt.current.sessionId }).catch(() => {});
    if (kickoff.current !== null) window.clearTimeout(kickoff.current);
  }, []);

  // 开标签先问钥匙串：记过密码（或用密钥）且这次是奔着连来的，就直接连上
  const probed = useRef(false);
  useEffect(() => {
    if (conn.protocol === "ftp" || probed.current) return;
    probed.current = true;
    invoke<boolean>("creds_has", { connId: conn.id })
      .then((has) => {
        if (!mounted.current) return;
        setSaved(has);
        if (!autoConnect) return;
        // 刚填的那条要走「非静默」：静默连是拿钥匙串里的旧凭据，不会记新密码
        if (seed?.secret) { void connectNow.current(false); return; }
        if (has || isKey) void connectNow.current(true);
      })
      .catch(() => {});
  }, [conn.id, conn.protocol, isKey, autoConnect, seed]);

  // 服务器主动断开（exit / 超时 / 网络抖）→ 回到连接面板，能自动接的就自动接
  const openSessionId = open ? phase.sessionId : null;
  useEffect(() => {
    if (!openSessionId) return;
    let un: UnlistenFn | undefined;
    let dead = false;
    listen(`ssh://close/${openSessionId}`, () => {
      notify.current(null);
      setLogging(false);
      // 用户自己点的断开不算「掉线」，别在这儿又给他接回去
      if (byHand.current) { byHand.current = false; return; }
      setPhase({ kind: "error", err: { message: "连接断了，再连一次？" } });
      // 手上有凭据（记过密码或用密钥）才自动重连 —— 否则弹密码框更烦人
      if (retryOn.current && (isKey || savedRef.current)) setRetry({ left: RETRY_TIMES, seconds: 3 });
    }).then((fn) => {
      if (dead) fn();
      else un = fn;
    });
    return () => { dead = true; un?.(); };
  }, [openSessionId, isKey]);

  // —— 自动重连 ——
  // 网线抖一下、Wi-Fi 换个热点，不该让人手动点回来。
  // 退避着来（3 秒 → 6 秒 → 12 秒），试几次不行就停下，别一直骚扰服务器。
  useEffect(() => {
    if (!retry) return;
    if (retry.seconds <= 0) {
      setRetry(null);
      void connectNow.current(true);
      return;
    }
    const timer = setTimeout(() => setRetry((one) => (one ? { ...one, seconds: one.seconds - 1 } : null)), 1000);
    return () => clearTimeout(timer);
  }, [retry]);

  // 重连又断了：还有次数就翻倍等着再来
  const lastRetry = useRef<number | null>(null);
  useEffect(() => {
    if (phase.kind === "open") { lastRetry.current = null; return; }
    if (phase.kind !== "error" || retry) return;
    const left = lastRetry.current;
    if (left === null || left <= 1) return;
    lastRetry.current = null;
    setRetry({ left: left - 1, seconds: Math.min(24, (RETRY_TIMES - left + 2) * 3) });
  }, [phase, retry]);
  useEffect(() => { if (retry) lastRetry.current = retry.left; }, [retry]);

  // —— 空闲自动断开 ——
  const lastActive = useRef(Date.now());
  const touch = useCallback(() => { lastActive.current = Date.now(); }, []);

  useEffect(() => {
    if (!openSessionId || idleMinutes <= 0) return;
    lastActive.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastActive.current < idleMinutes * 60_000) return;
      invoke("ssh_close", { sessionId: openSessionId }).catch(() => {});
      notify.current(null);
      setPhase({ kind: "napped" });
    }, 20_000);
    return () => clearInterval(timer);
  }, [openSessionId, idleMinutes]);

  // 从别处切回这个标签 → 把打盹的会话接上；在当前标签上打的盹等用户叫醒
  const wasActive = useRef(active);
  useEffect(() => {
    const cameBack = active && !wasActive.current;
    wasActive.current = active;
    if (cameBack && phase.kind === "napped") connectNow.current(true);
  }, [active, phase.kind]);

  // 侧栏第二次点同一台机器（双击连接 / 打开文件面板 / 看配置）就走这儿。
  // 没有它的话，标签已经开着时那一下点击只是切过去，「连接」那件事没人做。
  const wokeAt = useRef(wake?.seq ?? 0);
  useEffect(() => {
    const seq = wake?.seq ?? 0;
    if (seq === wokeAt.current) return;
    wokeAt.current = seq;
    const next = wake?.mode ?? "term";
    setMode(next);
    const live = phaseRef.current.kind;
    if (next === "files" && live === "open") setFilesMounted(true);
    if (!wake?.connect || live === "open" || live === "connecting") return;
    if (conn.protocol === "ftp") return;
    const typedNow = isKey ? passphrase : password;
    // 手上没凭据就别去撞一次认证，停在密码框那儿等用户输。
    // 钥匙串那一问可能还没回来（开标签和这次点击就隔了一次双击的功夫），所以再问一次。
    if (!isKey && !savedRef.current && typedNow === "") {
      void invoke<boolean>("creds_has", { connId: conn.id })
        .then((has) => {
          if (!mounted.current || !has) return;
          setSaved(true);
          if (phaseRef.current.kind !== "open" && phaseRef.current.kind !== "connecting") void connectNow.current(true);
        })
        .catch(() => {});
      return;
    }
    void connectNow.current(typedNow === "");
  }, [wake, conn.protocol, isKey, password, passphrase]);

  // 停在哪一页要往上报一声，「记住上次的标签」才不是只记住服务器
  useEffect(() => { tellMode.current?.(mode); }, [mode]);

  const disconnect = async () => {
    // 标一下：接下来那个 close 事件是我自己弄的，别触发自动重连
    byHand.current = true;
    dropKickoff();
    setRetry(null);
    setLogging(false);
    if (open) await invoke("ssh_close", { sessionId: phase.sessionId }).catch(() => {});
    // 认证走到一半也算这条连接，一并收掉
    if (attempt.current) invoke("ssh_cancel_auth", { sessionId: attempt.current.sessionId }).catch(() => {});
    attempt.current = null;
    setAskAuth(null);
    notify.current(null);
    setFilesMounted(false);
    setMode((current) => (current === "files" ? "term" : current));
    setPhase({ kind: "idle" });
  };

  const forget = async () => {
    await invoke("creds_forget", { connId: conn.id }).catch(() => {});
    setSaved(false);
  };

  /** 配置页里填了密码：直接落进这张连接卡，不再另外弹一个框问一遍 */
  const takeTyped = useCallback((secret: string, keep: boolean) => {
    if (conn.authType === "key") setPassphrase(secret); else setPassword(secret);
    setRemember(keep);
  }, [conn.authType]);

  /** 文件页可以单独进：没连就顺手连上，连上直接落在文件面板 */
  const goFiles = () => {
    setMode("files");
    if (open) { setFilesMounted(true); return; }
    if (!connecting && conn.protocol !== "ftp" && (isKey || saved)) void connect(true);
  };

  /** 真的在广播：自己在组里，而且组里不止自己一台 */
  const casting = open && inSync && syncCount > 1;

  // 终端右键菜单里会话这一层的条目：几页之间切换、断开。键位跟工具条上的提示一致
  const termMenu: MenuEntry[] = [
    { label: "文件面板", hint: PAGE_SHORTCUTS.files, onClick: goFiles },
    { label: "状态", hint: PAGE_SHORTCUTS.stats, onClick: () => setMode("stats") },
    { label: "隧道", hint: PAGE_SHORTCUTS.tunnel, onClick: () => setMode("tunnel") },
    { label: "这条连接的配置", hint: PAGE_SHORTCUTS.config, onClick: () => setMode("config") },
    null,
    { label: "断开连接", danger: true, onClick: () => void disconnect() },
    ...(appMenu && appMenu.length > 0 ? [null, ...appMenu] : []),
  ];

  /**
   * 端口表 →「转发到本地」。
   *
   * 本地口默认跟远端同号（好记）；1024 以下的除外 —— macOS / Linux 上绑那一段要 root，
   * 直接给个 10000+ 的同尾号（80 → 10080），比让人撞一次「权限不足」强。
   */
  const suggestLocal = (remote: number) => (remote >= 1024 ? remote : remote + 10000);

  const doForward = (localPort: number) => {
    if (!forwarding) return;
    const one: Tunnel = {
      id: newId(),
      kind: "local",
      listenHost: "127.0.0.1",
      listenPort: localPort,
      destHost: "127.0.0.1",
      destPort: forwarding.port,
    };
    setForwarding(null);
    // 先存进配置再切过去：隧道面板是照着 conn.tunnels 画的，
    // 存之前切过去会看到一个空位，然后那一行才「跳」出来
    onSaveConn({ ...conn, tunnels: [...(conn.tunnels ?? []), one] });
    setMode("tunnel");
  };

  const connecting = phase.kind === "connecting";
  /** 这次手上现有的密码 / 密码短语（连接卡里填的，或者配置页刚递过来的） */
  const typed = isKey ? passphrase : password;
  // 记过凭据 / 密钥认证时可以空手连
  const canConnect = isKey || saved || password !== "";

  /**
   * 连着的时候换编码：告诉引擎一声，下一块输出就按新的解。
   * 顺手把选择存回这条连接的配置，下次开就是对的，不用每次改。
   */
  /** 会话日志：把这条会话的输出抄一份到文件里，事后能翻能 grep */
  const toggleLog = async () => {
    if (!open) return;
    if (logging) {
      await invoke("ssh_log_stop", { sessionId: phase.sessionId }).catch(() => {});
      setLogging(false);
      return;
    }
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `${conn.name || conn.host}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.log`;
    const path = await save({
      title: "会话日志存到哪儿",
      defaultPath: name.replace(/[\\/:*?"<>|]/g, "_"),
      filters: [{ name: "日志", extensions: ["log", "txt"] }],
    }).catch(() => null);
    if (!path) return;
    try {
      await invoke("ssh_log_start", { sessionId: phase.sessionId, path });
      setLogErr(null);
      setLogging(true);
    } catch (e) {
      const text = e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);
      setLogErr(text);
    }
  };

  const switchEncoding = async (next: string) => {
    setEncoding(next);
    if (open) await invoke("ssh_set_encoding", { sessionId: phase.sessionId, encoding: next }).catch(() => {});
    if ((conn.encoding || DEFAULT_ENCODING) !== next) onSaveConn({ ...conn, encoding: next });
  };

  return (
    <div className="session">
      <div className="session-bar">
        <span className={`status-dot ${open ? "live" : "down"}`} title={open ? "连着" : "没连上"} />
        <b>{conn.name}</b>
        <span className="session-meta">{conn.username}@{conn.host}</span>

        <div className="seg mini">
          <button type="button" title={`终端 · ${PAGE_SHORTCUTS.term}`} className={mode === "term" ? "on" : ""} onClick={() => setMode("term")}>
            <IconTerminal size={13} />终端
          </button>
          <button
            type="button"
            title={`${open ? "文件（SFTP）" : "直接进文件面板，没连的话顺手连上"} · ${PAGE_SHORTCUTS.files}`}
            className={mode === "files" ? "on" : ""}
            onClick={goFiles}
          >
            <IconFiles size={13} />文件
          </button>
          <button
            type="button"
            title={`${open ? "CPU / 内存 / 磁盘 / 进程" : "连上之后能看这台机器的实时状态"} · ${PAGE_SHORTCUTS.stats}`}
            className={mode === "stats" ? "on" : ""}
            onClick={() => setMode("stats")}
          >
            <IconGauge size={13} />状态
          </button>
          <button
            type="button"
            title={`端口转发 / SOCKS 代理 · ${PAGE_SHORTCUTS.tunnel}`}
            className={mode === "tunnel" ? "on" : ""}
            onClick={() => setMode("tunnel")}
          >
            <IconLink size={13} />隧道
            {(conn.tunnels?.length ?? 0) > 0 && <i className="seg-badge">{conn.tunnels?.length}</i>}
          </button>
          <button type="button" title={`这条连接的配置 · ${PAGE_SHORTCUTS.config}`} className={mode === "config" ? "on" : ""} onClick={() => setMode("config")}>
            <IconSettings size={13} />配置
          </button>
        </div>

        <span className="foot-spacer" />

        {/* 乱码是当场才看得出来的，所以换编码也得能当场换，不用断开重连 */}
        {open && (
          <select
            className="enc-pick"
            value={encoding}
            title="终端字符编码 —— 看到乱码就换一个"
            aria-label="字符编码"
            onChange={(e) => void switchEncoding(e.target.value)}
          >
            {ENCODINGS.map((one) => (
              <option key={one.value} value={one.value}>{one.label}</option>
            ))}
          </select>
        )}

        {open && (
          <button
            className={`sync-btn ${inSync ? "on" : ""} ${casting ? "live" : ""}`}
            type="button"
            onClick={onToggleSync}
            title={
              inSync
                ? syncCount > 1
                  ? `同步组里有 ${syncCount} 台，你敲的东西会同时发过去。点一下把这台退出去`
                  : "这台已经在同步组里了，再把另一台也加进来才会开始广播"
                : "把这台加入同步组：组里有两台以上时，在任一台里敲的东西会同时发给其它台"
            }
          >
            同步{inSync && syncCount > 1 ? ` ${syncCount}` : ""}
          </button>
        )}

        {open && (
          <button
            className={`log-btn ${logging ? "on" : ""}`}
            type="button"
            onClick={toggleLog}
            title={logErr ?? (logging ? "正在记录这条会话，点一下停" : "把这条会话的输出记到文件里")}
          >
            <span className="log-dot" />
            {logErr ? "记不了" : logging ? "记录中" : "记录"}
          </button>
        )}

        {open ? (
          <button className="session-close" type="button" onClick={disconnect} title="断开这条连接">
            <IconX size={14} /> 断开
          </button>
        ) : (
          <button
            className="btn-primary sm"
            type="button"
            disabled={connecting || !canConnect || conn.protocol === "ftp" || !!askAuth}
            onClick={() => { if (mode === "config") setMode("term"); connectByHand(); }}
            title={canConnect ? "连上去" : "先在下面填一次密码"}
          >
            {connecting ? "连接中……" : "连接"}
          </button>
        )}
      </div>

      <div className="session-body" onMouseDown={touch}>
        {open && (
          <div className="session-pane" style={{ display: mode === "term" ? "flex" : "none" }}>
            {/* 广播开着的时候给一条显眼的横幅：往十台生产机同时敲 rm 是真会发生的事，
                这个状态绝不能只靠一个小按钮的高亮来提示 */}
            {casting && (
              <div className="sync-banner">
                你敲的每一个字会同时发给 <b>{syncCount}</b> 台机器
                <button type="button" onClick={onToggleSync}>把这台退出去</button>
              </div>
            )}
            <Terminal
              sessionId={phase.sessionId}
              scheme={termScheme}
              variant={termVariant}
              fontSize={termFontSize}
              divider={termDivider}
              onActivity={touch}
              onInput={casting ? onBroadcast : undefined}
              extraMenu={termMenu}
            />
          </div>
        )}

        {/* 没连上时，终端页和文件页都摆同一张连接卡（配置页照常能看） */}
        <div className="session-pane" style={{ display: !open && mode !== "config" ? "flex" : "none" }}>
          {phase.kind === "napped" ? (
            <div className="connect-panel">
              <div className="connect-card nap-card">
                <h2>闲了 {idleMinutes} 分钟，连接先睡了</h2>
                <p className="dim">切回这个标签会自己接上；现在也能直接叫醒。</p>
                <button className="btn-primary" type="button" onClick={() => connect(true)}>叫醒它</button>
              </div>
            </div>
          ) : (
            <div className="connect-panel">
              {askAuth ? (
                <AuthAsk
                  ask={askAuth}
                  busy={connecting}
                  onSubmit={answer}
                  onCancel={dropAuth}
                />
              ) : askHost ? (
                <div className={`connect-card host-key ${askHost.kind === "changed" ? "danger" : ""}`}>
                  <h2>{askHost.kind === "changed" ? "这台的指纹变了" : "第一次连这台"}</h2>
                  <p className="dim">
                    {askHost.kind === "changed"
                      ? "服务器重装或换过密钥会这样，被人插在中间也会这样。不确定就别点信任，先去问清楚。"
                      : "核对一下指纹，对得上再信任。信任后会写进 ~/.ssh/known_hosts，跟系统 ssh 共用一份。"}
                  </p>
                  <div className="fp-box">
                    <span>{conn.host}:{conn.port}</span>
                    <b>{askHost.fingerprint}</b>
                    <small>{askHost.algo}</small>
                  </div>
                  <div className="fp-actions">
                    <button
                      className={askHost.kind === "changed" ? "btn-primary danger" : "btn-primary"}
                      type="button"
                      onClick={() => connectByHand(true)}
                    >
                      {askHost.kind === "changed" ? "我确认过，更新指纹" : "信任并连接"}
                    </button>
                    <button className="btn-ghost" type="button" onClick={() => setAskHost(null)}>先不连</button>
                  </div>
                </div>
              ) : (
              <div className="connect-card">
                {conn.protocol === "ftp" ? (
                  <p className="dim">FTP 还没接上，先用 SFTP。</p>
                ) : (
                  <>
                    {/* 卡片自己说清楚要连谁，光一个密码框看不出是哪台 */}
                    <div className="connect-head">
                      <h2>{conn.name || conn.host}</h2>
                      <span>{conn.username}@{conn.host}:{conn.port}</span>
                    </div>

                    {isKey && (
                      <div className="key-row">
                        <IconKey size={15} />
                        <span className="key-path" title={conn.keyPath}>{conn.keyPath || "未配置私钥路径"}</span>
                      </div>
                    )}

                    {/* 钥匙串里有、手上又没现填的，就不摆输入框了 */}
                    {saved && !typed ? (
                      <div className="saved-row">
                        <IconCheck size={15} />
                        <span>已记住{isKey ? "密码短语" : "密码"}，点连接就走</span>
                        <button type="button" onClick={forget} title="从系统钥匙串里删掉">忘掉</button>
                      </div>
                    ) : isKey ? (
                      <label className="field">
                        <span>密码短语（私钥没设就留空）</span>
                        <div className="pw-input">
                          <IconLock size={15} />
                          <input
                            type="password"
                            value={passphrase}
                            placeholder="多数私钥无需密码短语"
                            onChange={(e) => setPassphrase(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && connectByHand()}
                          />
                        </div>
                      </label>
                    ) : (
                      <label className="field">
                        <span>密码</span>
                        <div className="pw-input">
                          <IconLock size={15} />
                          <input
                            type="password"
                            value={password}
                            autoFocus={active}
                            placeholder="输一次，勾上记住就不用再输"
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && connectByHand()}
                          />
                        </div>
                      </label>
                    )}

                    {(!saved || typed) && (
                      <label className="check-row" title="存进系统钥匙串（Windows 凭据管理器 / macOS 钥匙串）">
                        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                        <span>连上之后记住{isKey ? "密码短语" : "密码"}，下次直接连</span>
                      </label>
                    )}

                    {retry ? (
                      <div className="connect-retry">
                        <span className="spin" />
                        <b>{retry.seconds} 秒后自动重连</b>
                        <small>还会再试 {retry.left} 次</small>
                        <button type="button" onClick={() => { lastRetry.current = null; setRetry(null); }}>不用了</button>
                      </div>
                    ) : phase.kind === "error" && (
                      <div className="connect-error">
                        <b>{phase.err.message}</b>
                        {phase.err.detail && <small>{phase.err.detail}</small>}
                      </div>
                    )}

                    <button className="btn-primary" type="button" disabled={connecting || !canConnect} onClick={() => connectByHand()}>
                      {connecting ? "连接中……" : mode === "files" ? "连上并进文件面板" : "连接"}
                    </button>
                    {/* 没有那个勾的时候就别提「勾了记住」，说的是屏幕上不存在的东西 */}
                    {(!saved || typed) && (
                      <p className="form-note">
                        <IconLock size={13} />
                        勾了记住就交给系统钥匙串保管（Windows 凭据管理器 / macOS 钥匙串），我们自己的文件里没有明文。
                      </p>
                    )}
                  </>
                )}
              </div>
              )}
            </div>
          )}
        </div>

        {/* 断了也不卸载：传输队列和两边的目录留在那儿，重连回来接着用 */}
        {filesMounted && (
          <div className="session-pane" style={{ display: mode === "files" ? "flex" : "none" }}>
            <SftpPanel
              sessionId={open ? phase.sessionId : null}
              connId={conn.id}
              active={active && mode === "files"}
              lanes={xferLanes}
              onActivity={touch}
              onEditFile={onEditFile}
              onOpenLog={onOpenLog}
            />
          </div>
        )}

        {/* 没连上就让上面那张连接卡说话，别在这儿摆一个空面板 */}
        <div className="session-pane" style={{ display: open && mode === "stats" ? "flex" : "none" }}>
          <StatsPanel
            sessionId={open ? phase.sessionId : null}
            active={visible && mode === "stats"}
            onActivity={touch}
            onForward={(port, label) => setForwarding({ port, label })}
            onRunInTerminal={(command) => {
              // 交互式的东西（docker exec -it）得在真终端里跑：
              // 状态面板那条通道后面没有 PTY，在那儿执行只会挂住
              if (!open) return;
              setMode("term");
              void invoke("ssh_write", { sessionId: phase.sessionId, data: `${command}
` }).catch(() => {});
            }}
          />
        </div>

        <div className="session-pane" style={{ display: mode === "tunnel" ? "flex" : "none" }}>
          <TunnelPanel
            sessionId={open ? phase.sessionId : null}
            tunnels={conn.tunnels ?? []}
            onChange={(tunnels) => onSaveConn({ ...conn, tunnels })}
            onActivity={touch}
          />
        </div>

        <div className="session-pane" style={{ display: mode === "config" ? "flex" : "none" }}>
          <ConnectionPage
            conn={conn}
            status={open ? "live" : "down"}
            embedded
            onSave={onSaveConn}
            onSecret={takeTyped}
            onDelete={onDeleteConn}
            onDirtyChange={onConfigDirty}
          />
        </div>
      </div>

      {forwarding && (
        <Dialog
          title={`把 ${forwarding.port} 转发到本地`}
          message={
            `连本机这个端口，等于连 ${conn.host} 上的 ${forwarding.port}` +
            `${forwarding.label ? `（${forwarding.label}）` : ""}。
` +
            "存进这条连接的隧道里，之后在「隧道」页随时开关。"
          }
          input={{
            label: "本地开哪个口",
            initial: String(suggestLocal(forwarding.port)),
            hint: "1024 以下的端口在 macOS / Linux 上要 root 才绑得住",
          }}
          confirmText="建这条隧道"
          onConfirm={(value) => {
            const port = Number(value);
            if (Number.isFinite(port) && port > 0 && port < 65536) doForward(port);
          }}
          onClose={() => setForwarding(null)}
        />
      )}
    </div>
  );
}

interface AuthAskProps {
  ask: AuthPrompts;
  busy: boolean;
  onSubmit: (answers: string[]) => void;
  onCancel: () => void;
}

/**
 * 服务器问一句、用户答一句。
 * 2FA 验证码、到期要改的密码、堡垒机的自定义问题，走的都是这条路
 * （SSH 的 keyboard-interactive）。问题文字原样照搬服务器的，不自己编。
 */
function AuthAsk({ ask, busy, onSubmit, onCancel }: AuthAskProps) {
  // 服务器每换一组问题就重新来过，别把上一组的答案留在框里
  const [answers, setAnswers] = useState<string[]>(() => ask.prompts.map(() => ""));
  useEffect(() => { setAnswers(ask.prompts.map(() => "")); }, [ask]);

  const put = (index: number, value: string) =>
    setAnswers((old) => old.map((one, i) => (i === index ? value : one)));

  const send = () => { if (!busy) onSubmit(answers); };

  return (
    <div className="connect-card auth-ask">
      <h2>{ask.name.trim() || "服务器要验证一下"}</h2>
      {ask.instructions.trim() && <p className="dim auth-inst">{ask.instructions.trim()}</p>}

      {ask.prompts.map((one, index) => (
        <label className="field" key={`${one.prompt}-${index}`}>
          <span>{one.prompt.trim() || "请输入"}</span>
          <div className="pw-input">
            {one.echo ? <IconKey size={15} /> : <IconLock size={15} />}
            <input
              // echo=true 是验证码这类可以看见的，false 是密码，遮起来
              type={one.echo ? "text" : "password"}
              autoFocus={index === 0}
              autoComplete="off"
              value={answers[index] ?? ""}
              onChange={(e) => put(index, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
          </div>
        </label>
      ))}

      <button className="btn-primary" type="button" disabled={busy} onClick={send}>
        {busy ? "验证中……" : "提交"}
      </button>
      <button className="btn-ghost" type="button" onClick={onCancel}>算了，不连了</button>
      <p className="form-note">
        <IconLock size={13} />
        一次性验证码只在这一次连接里用，不会存进钥匙串。
      </p>
    </div>
  );
}
