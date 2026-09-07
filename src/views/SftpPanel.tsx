import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconCornerUp,
  IconDownload,
  IconDrive,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFileEdit,
  IconFilePlus,
  IconFiles,
  IconFolderPlus,
  IconHome,
  IconLink,
  IconRefresh,
  IconSearch,
  IconStar,
  IconSync,
  IconTrash,
  IconUpload,
  IconX,
} from "../components/icons";
import { Dialog, type DialogSpec } from "../components/Dialog";
import { ChmodDialog } from "../components/ChmodDialog";
import { ContextMenu, menuAt, type MenuEntry, type MenuState } from "../components/ContextMenu";
import { copyText } from "../clipboard";
import { fmtDuration, fmtMode, fmtMtime, fmtSize } from "../format";
import { deleteBookmark, lastDir, loadBookmarks, newId, rememberDir, saveBookmark } from "../store";
import {
  findConflicts,
  joinRemote,
  planDownload,
  planDroppedPaths,
  planSync,
  planUpload,
  type Conflict,
  type Side,
  type SyncPlan,
  type XferTask,
} from "../transfer";
import type { Bookmark, FsEntry, FsListing } from "../types";

interface SftpPanelProps {
  /**
   * 已连上的 SSH 会话 id —— SFTP 复用它，不重新认证。
   * 断线时是 null：面板留着不卸载，传输队列和两边的目录都还看得见，
   * 不然掉一次线，「哪些传完了、哪些没传」这些信息就全没了。
   */
  sessionId: string | null;
  /** 连接 id：远程收藏目录跟着服务器走 */
  connId: string;
  /** 这个面板正显示着才接管拖拽 */
  active: boolean;
  /** 同时传几个文件 */
  lanes: number;
  /** 有动作就报一声，免得被空闲计时器误杀 */
  onActivity?: () => void;
  /** 用内置编辑器打开一个文本文件 */
  onEditFile: (side: Side, path: string) => void;
  /** 用日志查看器打开一个远程大文件（只读，按需一屏一屏取） */
  onOpenLog: (path: string) => void;
}

type SortKey = "name" | "size" | "mtime";

interface Progress {
  taskId: string;
  name: string;
  done: number;
  total: number;
  direction: "up" | "down";
  finished: boolean;
}

/** 正在传的那几条，按任务 id 摆着 */
type Live = Record<string, { name: string; done: number; total: number; direction: "up" | "down" }>;

interface Place {
  label: string;
  path: string;
  kind: string;
}

/** 远程常去的地方，省得一级级点 */
const REMOTE_PLACES: Place[] = [
  { label: "根目录", path: "/", kind: "drive" },
  { label: "/etc", path: "/etc", kind: "folder" },
  { label: "/var/log", path: "/var/log", kind: "folder" },
  { label: "/opt", path: "/opt", kind: "folder" },
  { label: "/tmp", path: "/tmp", kind: "folder" },
  { label: "/usr/local", path: "/usr/local", kind: "folder" },
];

/** 一行有多高（跟 .fs-row 的 CSS 对齐），虚拟滚动靠它算位置 */
const ROW_H = 28;
/** 超过这么多项才开虚拟滚动 */
const VIRTUAL_FROM = 200;

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
/** child 是不是就在 parent 里面（含 parent 自己）；按整段比，不是纯前缀 */
function under(parent: string, child: string): boolean {
  if (parent === child) return true;
  const sep = parent.includes("\\") ? "\\" : "/";
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

const parentRemote = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

/** 把路径拆成可点的各级：/var/log → [/, /var, /var/log]；C:\a\b 同理 */
function crumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  if (path.includes("\\")) {
    const parts = path.split("\\").filter(Boolean);
    return parts.map((part, i) => ({ label: part, path: parts.slice(0, i + 1).join("\\") + (i === 0 ? "\\" : "") }));
  }
  const parts = path.split("/").filter(Boolean);
  return [{ label: "/", path: "/" }, ...parts.map((part, i) => ({ label: part, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

const errText = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);

/**
 * 文件面板：左本地 右远程。
 * 多选（Ctrl / Shift）、目录整体传输、传输排队都在这儿；
 * 传输本身走 Rust 分块流，进度在底部队列条上走。
 */
export function SftpPanel({ sessionId, connId, active, lanes, onActivity, onEditFile, onOpenLog }: SftpPanelProps) {
  const [local, setLocal] = useState<FsListing | null>(null);
  const [remote, setRemote] = useState<FsListing | null>(null);
  const [sel, setSel] = useState<Record<Side, string[]>>({ local: [], remote: [] });
  /** 底部那条消息。tone=info 是「知道一下」，不带就是真出错了，画成红的 */
  const [err, setErr] = useState<{ message: string; detail?: string | null; tone?: "info" | "bad" } | null>(null);
  const [progress, setProgress] = useState<Live>({});
  /** 传输速度（字节/秒）和预计剩余秒数，由下面的采样算出来 */
  const [rate, setRate] = useState<{ speed: number; eta: number } | null>(null);
  const [dropping, setDropping] = useState<null | "ok" | "busy">(null);
  const [dialog, setDialog] = useState<(DialogSpec & { side: Side }) | null>(null);
  const [chmodTarget, setChmodTarget] = useState<{ entry: FsEntry; side: Side } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [marks, setMarks] = useState<Bookmark[]>(() => loadBookmarks());
  const [places, setPlaces] = useState<Place[]>([]);
  const [remoteHome, setRemoteHome] = useState("");

  /** 键盘操作认的是「刚点过哪一栏」 */
  const [focusSide, setFocusSide] = useState<Side>("local");
  /**
   * Ctrl+C / Ctrl+X 记下的东西。
   * 粘到对面那栏 = 传输；粘在同一栏 = 就地复制 / 移动。
   */
  const clipRef = useRef<{ side: Side; entries: FsEntry[]; cut: boolean } | null>(null);

  /** 面板内拖拽：拖的东西是谁、现在悬在哪 */
  const [drag, setDrag] = useState<{ from: Side; count: number; x: number; y: number; to: Side | null; dir: string | null } | null>(null);
  const dragRef = useRef<{ from: Side; entries: FsEntry[]; x: number; y: number; live: boolean } | null>(null);
  const hoverRef = useRef<{ to: Side | null; dir: string | null }>({ to: null, dir: null });

  // —— 传输队列：真源在 ref 里，state 只用来渲染 ——
  const [queue, setQueue] = useState<XferTask[]>([]);
  const listRef = useRef<XferTask[]>([]);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);
  const [queueOpen, setQueueOpen] = useState(false);
  /** 目标位置有同名文件，等用户决定覆盖还是跳过 */
  const [clash, setClash] = useState<{ tasks: XferTask[]; hits: Conflict[] } | null>(null);
  /** 目录同步算好了，等用户确认 */
  const [syncPlan, setSyncPlan] = useState<{ plan: SyncPlan; side: Side; target: string } | null>(null);
  /** 正在干一件要花点时间的活（批量删除之类），底部条上报一声 */
  const [busy, setBusy] = useState<{ text: string; name: string } | null>(null);

  const remotePaneRef = useRef<HTMLDivElement>(null);
  const remotePathRef = useRef("");
  remotePathRef.current = remote?.path ?? "";
  const localPathRef = useRef("");
  localPathRef.current = local?.path ?? "";
  // 队列泵和系统拖放的监听都是长跑闭包，重连后 sessionId 会换，只能从 ref 里拿
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // 目录切换的请求序号：慢的旧响应回来时序号对不上就丢掉，别盖住新目录
  const localSeq = useRef(0);
  const remoteSeq = useRef(0);
  const readyRef = useRef({ active, busy: false });
  readyRef.current = { active, busy: runningRef.current };

  const beat = useRef(onActivity);
  beat.current = onActivity;
  // 队列泵是长跑的闭包，并发数放 ref 里，设置改了当场生效
  const laneRef = useRef(lanes);
  laneRef.current = lanes;

  const fail = (e: unknown) => {
    setErr(
      e && typeof e === "object" && "message" in e
        ? (e as { message: string; detail?: string | null })
        : { message: "操作失败", detail: String(e) },
    );
  };

  const goLocal = useCallback(async (path: string, quiet = false) => {
    beat.current?.();
    const seq = (localSeq.current += 1);
    try {
      const listing = await invoke<FsListing>("local_list", { path });
      if (seq !== localSeq.current) return;
      setLocal(listing);
      rememberDir("local", listing.path);
      setSel((s) => ({ ...s, local: [] }));
      setErr(null);
    } catch (e) {
      if (seq !== localSeq.current) return;
      if (quiet) { void goLocal(""); return; }
      fail(e);
    }
  }, []);

  const goRemote = useCallback(async (path: string, quiet = false) => {
    if (!sessionId) return;
    beat.current?.();
    const seq = (remoteSeq.current += 1);
    try {
      const listing = await invoke<FsListing>("sftp_list", { sessionId, path });
      if (seq !== remoteSeq.current) return;
      setRemote(listing);
      setRemoteHome((home) => home || listing.path);
      rememberDir(connId, listing.path);
      setSel((s) => ({ ...s, remote: [] }));
      setErr(null);
    } catch (e) {
      if (seq !== remoteSeq.current) return;
      if (quiet) { void goRemote(""); return; }
      fail(e);
    }
  }, [sessionId, connId]);

  // 开面板：回到上次待的目录；顺手取「此电脑」的位置列表
  useEffect(() => {
    goLocal(lastDir("local"), true);
    goRemote(lastDir(connId), true);
    invoke<Place[]>("local_places").then(setPlaces).catch(() => {});
  }, [goLocal, goRemote, connId]);

  // 每个文件各自的传输进度（可能好几条同时在跑）
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let dead = false;
    listen<Progress & { sessionId: string }>("sftp://progress", (event) => {
      const p = event.payload;
      if (p.sessionId !== sessionId) return;
      beat.current?.();
      // 这条传完了，它的字节数并进累计里，速度才不会在换文件时掉一下。
      // 放在 setState 的 updater 外面：updater 得是纯函数，StrictMode 会调两遍
      if (p.finished) finishedBytes.current += p.done;
      setProgress((old) => {
        if (p.finished) {
          if (!old[p.taskId]) return old;
          const next = { ...old };
          delete next[p.taskId];
          return next;
        }
        return { ...old, [p.taskId]: { name: p.name, done: p.done, total: p.total, direction: p.direction } };
      });
    }).then((fn) => {
      if (dead) fn();
      else un = fn;
    });
    return () => { dead = true; un?.(); };
  }, [sessionId]);

  // —— 速度和剩余时间 ——
  // 拿「这一秒又传了多少字节」算瞬时速度，再用几次的平均抹掉抖动。
  // 只看当前这批正在传的字节数：文件切换的那一下会归零，所以累计值另外记。
  const flowed = useRef({ at: 0, bytes: 0, ema: 0 });
  const doneBytes = useMemo(
    () => Object.values(progress).reduce((sum, one) => sum + one.done, 0),
    [progress],
  );
  const doneRef = useRef(0);
  doneRef.current = doneBytes;
  const finishedBytes = useRef(0);

  useEffect(() => {
    const running = Object.keys(progress).length > 0;
    if (!running) { setRate(null); flowed.current = { at: 0, bytes: 0, ema: 0 }; return; }
    const timer = setInterval(() => {
      const now = Date.now();
      const seen = flowed.current;
      const total = finishedBytes.current + doneRef.current;
      if (seen.at === 0) { flowed.current = { at: now, bytes: total, ema: 0 }; return; }
      const seconds = (now - seen.at) / 1000;
      if (seconds <= 0) return;
      const speed = Math.max(0, (total - seen.bytes) / seconds);
      // 指数平滑：数字别一秒一跳，看着心慌
      const ema = seen.ema === 0 ? speed : seen.ema * 0.6 + speed * 0.4;
      flowed.current = { at: now, bytes: total, ema };

      const left = listRef.current
        .filter((one) => one.kind === "file" && (one.status === "wait" || one.status === "run"))
        .reduce((sum, one) => sum + one.size, 0) - doneRef.current;
      setRate({ speed: ema, eta: ema > 1024 ? Math.max(0, left) / ema : 0 });
    }, 1000);
    return () => clearInterval(timer);
  }, [progress]);

  // 读 ref 而不是 state：传输结束时刷新的得是"现在"待的目录，不是传输开始时那个
  const refresh = useCallback((side: Side) => {
    if (side === "local") { if (localPathRef.current) void goLocal(localPathRef.current); }
    else if (remotePathRef.current) void goRemote(remotePathRef.current);
  }, [goLocal, goRemote]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // 编辑器存完文件 → 就在当前目录的话刷新一下
  useEffect(() => {
    const onSaved = (e: Event) => {
      const { side, path } = (e as CustomEvent<{ side: Side; path: string }>).detail ?? {};
      if (!path) return;
      const dir = path.replace(/[\\/][^\\/]*$/, "") || (side === "remote" ? "/" : path);
      if (side === "local" && local?.path === dir) void goLocal(local.path);
      if (side === "remote" && remote?.path === dir) void goRemote(remote.path);
    };
    window.addEventListener("az-term:fs-changed", onSaved);
    return () => window.removeEventListener("az-term:fs-changed", onSaved);
  }, [local, remote, goLocal, goRemote]);

  // —— 队列 ——
  const sync = () => setQueue([...listRef.current]);

  const patch = (id: string, next: Partial<XferTask>) => {
    const task = listRef.current.find((one) => one.id === id);
    if (task) Object.assign(task, next);
    sync();
  };

  /** 跑一条任务；目录任务顺带处理「已经在了」的情况 */
  const runTask = useCallback(async (task: XferTask) => {
    const sessionId = sessionIdRef.current;
    patch(task.id, { status: "run" });
    beat.current?.();
    try {
      if (task.kind === "mkdir") {
        // 目录已经在就算数，接着往里传；真建不了（没权限）才算失败，
        // 不然里面的文件会一个个失败，用户还以为目录是好的
        const exists = task.dir === "up"
          ? await invoke<(unknown | null)[]>("sftp_stat", { sessionId, paths: [task.to] }).then((r) => !!r[0]).catch(() => false)
          : await invoke<(unknown | null)[]>("local_stat", { paths: [task.to] }).then((r) => !!r[0]).catch(() => false);
        if (!exists) {
          if (task.dir === "up") await invoke("sftp_mkdir", { sessionId, path: task.to });
          else await invoke("local_mkdir", { path: task.to });
        }
      } else if (task.dir === "up") {
        await invoke("sftp_upload", {
          sessionId, taskId: task.id, localPath: task.from, remotePath: task.to,
          overwrite: !!task.overwrite, resume: task.resume ?? 0,
        });
      } else {
        await invoke("sftp_download", {
          sessionId, taskId: task.id, remotePath: task.from, localPath: task.to,
          overwrite: !!task.overwrite, resume: task.resume ?? 0,
        });
      }
      patch(task.id, { status: "done" });
    } catch (e) {
      patch(task.id, { status: "fail", error: errText(e) });
    } finally {
      // 这条完了，进度条上就不用再挂着它
      setProgress((old) => {
        if (!old[task.id]) return old;
        const next = { ...old };
        delete next[task.id];
        return next;
      });
    }
  }, []);
  const runTaskRef = useRef(runTask);
  runTaskRef.current = runTask;

  /**
   * 队列泵：文件可以几条一起传（小文件多的目录靠这个提速），
   * 建目录必须等前面的都落定再做 —— 后面的文件要往里面放。
   */
  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        if (cancelRef.current) {
          // 剩下没跑的直接丢掉，跑完的留着给人看
          listRef.current = listRef.current.filter((one) => one.status !== "wait");
          sync();
          break;
        }
        const waiting = listRef.current.filter((one) => one.status === "wait");
        if (waiting.length === 0) break;

        const head = waiting[0];
        if (head.kind === "mkdir") {
          await runTaskRef.current(head);
          continue;
        }
        // 从队头连着取一批文件，撞上目录任务就先停在那儿
        const batch: XferTask[] = [];
        for (const one of waiting) {
          if (one.kind !== "file" || batch.length >= Math.max(1, laneRef.current)) break;
          batch.push(one);
        }
        await Promise.all(batch.map((one) => runTaskRef.current(one)));
      }
    } finally {
      runningRef.current = false;
      cancelRef.current = false;
      setProgress({});
      refreshRef.current("local");
      refreshRef.current("remote");
    }
  }, []);

  /** 真正下队：到这一步该问的都问过了 */
  const push = (tasks: XferTask[]) => {
    if (tasks.length === 0) return;
    if (!sessionIdRef.current) { setErr({ message: "连接断了，重连之后再传" }); return; }
    listRef.current.push(...tasks);
    sync();
    setQueueOpen(true);
    void pump();
  };

  /**
   * 下队前先看一眼目标位置有没有同名文件。
   * 有就把两边的大小和时间摆出来让用户挑：覆盖 / 跳过 / 算了。
   * 在这之前，一个字节都不会写出去。
   */
  const enqueue = async (tasks: XferTask[]) => {
    if (tasks.length === 0) return;
    const sessionId = sessionIdRef.current;
    if (!sessionId) { setErr({ message: "连接断了，重连之后再传" }); return; }
    const hits = await findConflicts(tasks, sessionId);
    if (hits.length === 0) { push(tasks); return; }
    setClash({ tasks, hits });
  };
  const enqueueRef = useRef(enqueue);
  enqueueRef.current = enqueue;

  /** 取消：排队的丢掉，正在传的也叫停（引擎会把半截文件收干净） */
  const cancelQueue = () => {
    cancelRef.current = true;
    const running = listRef.current.filter((one) => one.status === "run").map((one) => one.id);
    if (running.length > 0) invoke("sftp_cancel", { taskIds: running }).catch(() => {});
  };
  const clearDone = () => {
    listRef.current = listRef.current.filter((one) => one.status === "wait" || one.status === "run");
    sync();
  };
  const retryFailed = () => {
    listRef.current.forEach((one) => { if (one.status === "fail") { one.status = "wait"; one.error = undefined; } });
    sync();
    void pump();
  };

  /** 正在传的那几条，以及它们合起来的进度 */
  const live = useMemo(() => Object.values(progress), [progress]);
  const liveDone = useMemo(() => live.reduce((sum, one) => sum + one.done, 0), [live]);
  const liveTotal = useMemo(() => live.reduce((sum, one) => sum + one.total, 0), [live]);

  const stats = useMemo(() => ({
    total: queue.length,
    done: queue.filter((one) => one.status === "done").length,
    fail: queue.filter((one) => one.status === "fail").length,
    left: queue.filter((one) => one.status === "wait" || one.status === "run").length,
  }), [queue]);

  // —— 传输入口 ——
  const entriesOf = (side: Side, fallback?: FsEntry): FsEntry[] => {
    const listing = side === "local" ? local : remote;
    const picked = sel[side];
    const found = (listing?.entries ?? []).filter((one) => picked.includes(one.path));
    if (found.length > 0) return found;
    return fallback ? [fallback] : [];
  };

  /**
   * 「在这一行上」的操作认哪些东西：这一行本来就在选中里，就是整批；
   * 不在选中里，就只有它自己 —— 跟资源管理器一个规矩。
   * 不这么分的话，「选了 A、B，再点 C 那行的删除」删掉的会是 A、B。
   */
  const entriesFor = (side: Side, entry: FsEntry): FsEntry[] =>
    sel[side].includes(entry.path) ? entriesOf(side, entry) : [entry];

  const upload = async (entries: FsEntry[]) => {
    if (!remote || entries.length === 0) return;
    try {
      await enqueue(await planUpload(entries, remote.path));
    } catch (e) { fail(e); }
  };

  const download = async (entries: FsEntry[]) => {
    if (!local || !sessionId || entries.length === 0) return;
    try {
      await enqueue(await planDownload(entries, local.path, sessionId));
    } catch (e) { fail(e); }
  };

  /**
   * 目录同步：把这一栏当前目录里「对面没有的」和「对面旧了的」推过去。
   * 一模一样的跳过，对面多出来的东西一个不动 —— 同步删除太容易出事，不做。
   */
  const sync2 = async (side: Side) => {
    const from = side === "local" ? local : remote;
    const to = side === "local" ? remote : local;
    if (!from || !to) return;
    // 选中了就同步选中的，没选就整个目录
    const picked = sel[side].length > 0 ? entriesOf(side) : from.entries;
    if (picked.length === 0) { setErr({ message: "这个目录是空的，没什么可同步的" }); return; }
    if (!sessionId) { setErr({ message: "连接断了，重连之后再同步" }); return; }
    try {
      const plan = await planSync(picked, to.path, side === "local" ? "up" : "down", sessionId);
      setSyncPlan({ plan, side, target: to.path });
    } catch (e) { fail(e); }
  };

  /**
   * 两栏之间拖拽：从一栏按住拖到另一栏就传。
   * 用鼠标事件自己实现（不用 HTML5 DnD）—— Windows 上 webview 开了系统拖放捕获，
   * HTML5 那套会被吃掉，两个功能只能留一个，所以自己算。
   */
  const beginDrag = (side: Side, entry: FsEntry, e: React.MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // 按住的这一项不在选中里 → 拖的就是它，不是「上次选中的那些」。
    // 跟资源管理器一个手感；否则「选了 A，按住 B 拖过去」传的会是 A。
    const held = entriesFor(side, entry);
    dragRef.current = { from: side, entries: held, x: e.clientX, y: e.clientY, live: false };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const held = dragRef.current;
      if (!held) return;
      if (!held.live && Math.hypot(e.clientX - held.x, e.clientY - held.y) < 6) return;
      held.live = true;
      const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const paneSide = (under?.closest("[data-side]") as HTMLElement | null)?.dataset.side as Side | undefined;
      const to = paneSide && paneSide !== held.from ? paneSide : null;
      const dir = to ? (under?.closest("[data-dir]") as HTMLElement | null)?.dataset.dir ?? null : null;
      hoverRef.current = { to, dir };
      setDrag({ from: held.from, count: held.entries.length, x: e.clientX, y: e.clientY, to, dir });
    };

    const up = () => {
      const held = dragRef.current;
      const { to, dir } = hoverRef.current;
      dragRef.current = null;
      hoverRef.current = { to: null, dir: null };
      setDrag(null);
      if (!held?.live || !to) return;
      const target = dir ?? (to === "remote" ? remote?.path : local?.path);
      if (!target) return;
      if (to === "remote") planUpload(held.entries, target).then(enqueue).catch(fail);
      else if (sessionId) planDownload(held.entries, target, sessionId).then(enqueue).catch(fail);
    };

    // 窗口失焦或按 Esc：把拖拽状态收干净，别让小牌子和高亮挂在那儿
    const abort = () => {
      dragRef.current = null;
      hoverRef.current = { to: null, dir: null };
      setDrag(null);
    };
    const onEsc = (ev: KeyboardEvent) => { if (ev.key === "Escape") abort(); };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", abort);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", abort);
      window.removeEventListener("keydown", onEsc);
    };
    // enqueue / entriesOf 用的都是 ref 或当前渲染值，跟着目录变就够
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, remote, sessionId]);

  // —— 快捷键：Del 删 · Ctrl+A 全选 · Ctrl+C / Ctrl+V 传到对面 · F2 改名 · Backspace 上级 ——
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      // 正在输入框里打字，或者有弹窗开着，就别抢键
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (dialog || chmodTarget || document.querySelector(".modal-backdrop")) return;

      const side = focusSide;
      const listing = side === "local" ? local : remote;
      if (!listing) return;
      const picked = entriesOf(side);
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "Escape" && picked.length) {
        e.preventDefault();
        setSel((old) => ({ ...old, [side]: [] }));
        return;
      }
      if (e.key === "Delete" && picked.length) { e.preventDefault(); remove(side, picked); return; }
      if (e.key === "F2" && picked.length === 1) { e.preventDefault(); rename(side, picked[0]); return; }
      if (e.key === "Backspace") {
        e.preventDefault();
        if (side === "local") { if (listing.parent) void goLocal(listing.parent); }
        else void goRemote(listing.parent ?? parentRemote(listing.path));
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSel((s) => ({ ...s, [side]: listing.entries.map((one) => one.path) }));
        return;
      }
      if (mod && e.key.toLowerCase() === "c" && picked.length) {
        e.preventDefault();
        clipRef.current = { side, entries: picked, cut: false };
        setErr({ tone: "info", message: `记下 ${picked.length} 项 · 同一栏 Ctrl+V 就地复制，对面那栏 Ctrl+V 传过去` });
        return;
      }
      if (mod && e.key.toLowerCase() === "x" && picked.length) {
        e.preventDefault();
        clipRef.current = { side, entries: picked, cut: true };
        setErr({ tone: "info", message: `剪下 ${picked.length} 项 · 换个目录按 Ctrl+V 移过去` });
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const held = clipRef.current;
        if (!held) return;
        // 同一栏：就地复制或移动；对面那栏：传过去
        if (held.side === side) { void pasteHere(side, held); return; }
        void pasteOver(side, held);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 从系统拖文件（或整个目录）进右栏 = 上传到远程当前目录
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let dead = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const host = remotePaneRef.current;
        if (!host || !host.offsetParent || !readyRef.current.active) return;
        const p = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        if (p.type === "leave") { setDropping(null); return; }
        const rect = host.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        const x = (p.position?.x ?? -1) / scale;
        const y = (p.position?.y ?? -1) / scale;
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        const dir = remotePathRef.current;
        if (p.type === "drop") {
          setDropping(null);
          if (!inside) return;
          if (!dir) { setErr({ message: "连接不在了，重连后再拖" }); return; }
          planDroppedPaths(p.paths ?? [], dir).then((tasks) => enqueueRef.current(tasks)).catch(fail);
          return;
        }
        setDropping(inside ? (dir ? "ok" : "busy") : null);
      })
      .then((fn) => {
        if (dead) fn();
        else un = fn;
      })
      .catch(() => {});
    return () => { dead = true; un?.(); };
    // 监听只挂一次；enqueue 每次渲染都新建，所以经 enqueueRef 取最新的那个
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 单项操作 ——
  /** 新建 / 改名用的名字：带路径分隔符或 `..` 的不收，不然 `../x` 会把东西挪到上级去 */
  const badName = (name: string): string | null => {
    const one = name.trim();
    if (!one) return "名字不能空着";
    if (one === "." || one === "..") return "这个名字不能用";
    if (/[\\/]/.test(one)) return "名字里不能带 / 或 \\";
    return null;
  };

  const mkdir = (side: Side) => {
    const listing = side === "local" ? local : remote;
    if (!listing) return;
    setDialog({
      side,
      title: "新建目录",
      input: { label: "目录名", placeholder: "new-folder" },
      confirmText: "建",
      onConfirm: async (name) => {
        const why = badName(name);
        if (why) { setErr({ message: why }); return; }
        try {
          if (side === "local") await invoke("local_mkdir", { path: await invoke<string>("local_join", { dir: listing.path, name }) });
          else await invoke("sftp_mkdir", { sessionId, path: joinRemote(listing.path, name) });
          refresh(side);
        } catch (e) { fail(e); }
      },
    });
  };

  const touch = (side: Side) => {
    const listing = side === "local" ? local : remote;
    if (!listing) return;
    setDialog({
      side,
      title: "新建文件",
      input: { label: "文件名", placeholder: "notes.conf" },
      confirmText: "建",
      onConfirm: async (name) => {
        const why = badName(name);
        if (why) { setErr({ message: why }); return; }
        try {
          let path: string;
          if (side === "local") {
            path = await invoke<string>("local_join", { dir: listing.path, name });
            await invoke("local_touch", { path });
          } else {
            path = joinRemote(listing.path, name);
            await invoke("sftp_touch", { sessionId, path });
          }
          refresh(side);
          onEditFile(side, path);
        } catch (e) { fail(e); }
      },
    });
  };

  const rename = (side: Side, entry: FsEntry) => {
    const listing = side === "local" ? local : remote;
    if (!listing) return;
    setDialog({
      side,
      title: "改个名",
      input: { label: "新名字", initial: entry.name },
      confirmText: "改",
      onConfirm: async (name) => {
        if (name === entry.name) return;
        const why = badName(name);
        if (why) { setErr({ message: why }); return; }
        try {
          if (side === "local") {
            const to = await invoke<string>("local_join", { dir: listing.path, name });
            await invoke("local_rename", { from: entry.path, to });
          } else {
            await invoke("sftp_rename", { sessionId, from: entry.path, to: joinRemote(listing.path, name) });
          }
          refresh(side);
        } catch (e) { fail(e); }
      },
    });
  };

  const remove = (side: Side, entries: FsEntry[]) => {
    if (entries.length === 0) return;
    const many = entries.length > 1;
    setDialog({
      side,
      title: many ? `删除选中的 ${entries.length} 项` : `删除「${entries[0].name}」`,
      message: entries.some((one) => one.kind === "dir")
        ? "目录连里面的东西一起删，删了找不回来。"
        : "删了找不回来。",
      confirmText: "删",
      danger: true,
      onConfirm: async () => {
        // 删一大堆时界面不能是死的，走一个报一个；错误攒起来一次说完，
        // 不然后一条会把前一条的错误盖掉，用户只看得见最后那个
        const bad: string[] = [];
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i];
          if (entries.length > 1) setBusy({ text: `删除中 ${i + 1}/${entries.length}`, name: entry.name });
          try {
            if (side === "local") await invoke("local_remove", { path: entry.path });
            else await invoke("sftp_remove", { sessionId, path: entry.path });
          } catch (e) {
            bad.push(`${entry.name}：${errText(e)}`);
          }
        }
        setBusy(null);
        if (bad.length > 0) {
          setErr({
            message: bad.length === entries.length ? "一个都没删掉" : `有 ${bad.length} 个没删掉`,
            detail: bad.slice(0, 5).join(" · ") + (bad.length > 5 ? ` …还有 ${bad.length - 5} 个` : ""),
          });
        }
        refresh(side);
      },
    });
  };

  /**
   * 粘到对面那栏 = 传输。
   *
   * 剪切的东西粘到对面，只传不删 —— 跨机器的「移动」要先传完、校验、再删源文件，
   * 中间任何一步出岔子都是不可逆的丢文件。与其偷偷替用户决定，
   * 不如把它当复制办完，然后明说一句「源文件还在，你自己确认了再删」。
   */
  const pasteOver = async (side: Side, held: { entries: FsEntry[]; cut: boolean }) => {
    if (side === "remote") await upload(held.entries);
    else await download(held.entries);
    if (held.cut) {
      setErr({
        tone: "info",
        message: "跨两栏只传不删",
        detail: `${held.entries.length} 项正在传过去。源文件原样留着 —— 传完自己核对一下再删，别让程序替你决定。`,
      });
    }
  };

  /**
   * 在同一栏里粘贴：复制就地复制一份（重名自动排 `xxx (2)`），
   * 剪切就是挪过来（同一个文件系统内的改名，不搬字节）。
   */
  const pasteHere = async (side: Side, held: { entries: FsEntry[]; cut: boolean }) => {
    const listing = side === "local" ? local : remote;
    if (!listing) return;
    if (side === "remote" && !sessionId) { setErr({ message: "连接断了，重连之后再操作" }); return; }

    const bad: string[] = [];
    for (let i = 0; i < held.entries.length; i += 1) {
      const entry = held.entries[i];
      // 把一个目录挪进它自己里面，等于把它弄丢。
      // 按「整段」比：/a/bc 不在 /a/b 里面，纯 startsWith 会把它错拦下来
      if (entry.kind === "dir" && under(entry.path, listing.path)) {
        bad.push(`${entry.name}：不能放进它自己里面`);
        continue;
      }
      if (held.entries.length > 1) {
        setBusy({ text: `${held.cut ? "移动" : "复制"}中 ${i + 1}/${held.entries.length}`, name: entry.name });
      }
      try {
        if (held.cut) {
          const to = side === "local"
            ? await invoke<string>("local_join", { dir: listing.path, name: entry.name })
            : joinRemote(listing.path, entry.name);
          if (to === entry.path) continue; // 原地不动，不用折腾
          if (side === "local") await invoke("local_rename", { from: entry.path, to });
          else await invoke("sftp_rename", { sessionId, from: entry.path, to });
        } else if (side === "local") {
          await invoke<string>("local_copy", { from: entry.path, toDir: listing.path });
        } else {
          await invoke<string>("sftp_copy", { sessionId, from: entry.path, toDir: listing.path });
        }
      } catch (e) {
        bad.push(`${entry.name}：${errText(e)}`);
      }
    }
    setBusy(null);
    // 剪切用掉就清空，跟资源管理器一样；复制留着可以连粘几次
    if (held.cut) clipRef.current = null;
    if (bad.length > 0) {
      setErr({ message: `有 ${bad.length} 项没弄成`, detail: bad.slice(0, 5).join(" · ") });
    }
    refresh(side);
  };

  const applyChmod = async (entry: FsEntry, mode: number) => {
    try {
      await invoke("sftp_chmod", { sessionId, path: entry.path, mode });
      refresh("remote");
    } catch (e) { fail(e); }
  };

  // —— 收藏目录 ——
  const addMark = (side: Side) => {
    const listing = side === "local" ? local : remote;
    if (!listing) return;
    const scope = side === "local" ? "local" : connId;
    if (marks.some((m) => m.scope === scope && m.path === listing.path)) return;
    setMarks(saveBookmark({ id: newId(), scope, path: listing.path, label: baseName(listing.path) || listing.path }));
  };

  const dropMark = (mark: Bookmark) => setMarks(deleteBookmark(mark.id));

  // —— 右键菜单 ——
  const rowMenu = (side: Side, entry: FsEntry, e: React.MouseEvent) => {
    const picked = entriesFor(side, entry);
    const many = picked.length > 1;
    const items: MenuEntry[] = [];

    if (!many && entry.kind !== "dir") {
      // 编辑器 2MB 就拦下了，而 /var/log 底下动辄几百 MB —— 大文件把日志查看器摆前面，
      // 省得用户先点「编辑」撞一次「文件太大」再回来找别的路
      const huge = entry.size > 2 * 1024 * 1024;
      const edit: MenuEntry = { label: "编辑", hint: "内置编辑器", onClick: () => onEditFile(side, entry.path) };
      const log: MenuEntry = { label: "日志查看器", hint: "只读，多大都开得动", onClick: () => onOpenLog(entry.path) };
      if (side === "remote" && huge) items.push(log, edit);
      else if (side === "remote") items.push(edit, log);
      else items.push(edit);
    }
    if (!many && entry.kind === "dir") {
      items.push({ label: "打开", onClick: () => (side === "local" ? goLocal(entry.path) : goRemote(entry.path)) });
    }
    items.push({
      label: side === "local" ? `上传${many ? ` ${picked.length} 项` : ""}` : `下载${many ? ` ${picked.length} 项` : ""}`,
      hint: picked.some((one) => one.kind === "dir") ? "含目录" : undefined,
      onClick: () => (side === "local" ? upload(picked) : download(picked)),
    });
    items.push(null);
    items.push({
      label: many ? `复制这 ${picked.length} 项` : "复制",
      hint: "Ctrl+C",
      onClick: () => {
        clipRef.current = { side, entries: picked, cut: false };
        setErr({ tone: "info", message: `记下 ${picked.length} 项 · 同一栏 Ctrl+V 就地复制，对面那栏 Ctrl+V 传过去` });
      },
    });
    items.push({
      label: many ? `剪切这 ${picked.length} 项` : "剪切",
      hint: "Ctrl+X",
      onClick: () => {
        clipRef.current = { side, entries: picked, cut: true };
        setErr({ tone: "info", message: `剪下 ${picked.length} 项 · 换个目录按 Ctrl+V 移过去` });
      },
    });
    if (clipRef.current?.side === side) {
      const held = clipRef.current;
      items.push({
        label: `粘贴到这儿（${held.entries.length} 项${held.cut ? "，移动" : ""}）`,
        hint: "Ctrl+V",
        onClick: () => void pasteHere(side, held),
      });
    }
    items.push(null);
    if (!many) items.push({ label: "改名", hint: "F2", onClick: () => rename(side, entry) });
    if (side === "remote" && !many) {
      items.push({ label: "改权限", hint: fmtMode(entry.mode) || "chmod", onClick: () => setChmodTarget({ entry, side }) });
    }
    items.push({ label: many ? "复制这些路径" : "复制完整路径", onClick: () => void copyText(picked.map((one) => one.path).join("\n")) });
    items.push(null);
    items.push({ label: many ? `删除这 ${picked.length} 项` : "删除", hint: "Del", danger: true, onClick: () => remove(side, picked) });
    setMenu(menuAt(e, items));
  };

  const paneMenu = (side: Side, e: React.MouseEvent) => {
    const listing = side === "local" ? local : remote;
    setMenu(menuAt(e, [
      { label: "刷新", onClick: () => refresh(side) },
      {
        label: "全选",
        hint: "Ctrl+A",
        onClick: () => {
          const all = (side === "local" ? local : remote)?.entries.map((one) => one.path) ?? [];
          setSel((old) => ({ ...old, [side]: all }));
        },
      },
      {
        label: "上级目录",
        hint: "Backspace",
        disabled: !listing?.parent,
        onClick: () => (side === "local"
          ? listing?.parent && goLocal(listing.parent)
          : listing && goRemote(listing.parent ?? parentRemote(listing.path))),
      },
      null,
      ...(clipRef.current
        ? [{
            label: clipRef.current.side === side
              ? `粘贴到这儿（${clipRef.current.entries.length} 项${clipRef.current.cut ? "，移动" : ""}）`
              : `从对面传过来（${clipRef.current.entries.length} 项）`,
            // 跨栏的剪切在这儿先把话说清楚，别等用户点完才发现源文件还在
            hint: clipRef.current.side === side ? "Ctrl+V" : clipRef.current.cut ? "只传不删" : "Ctrl+V",
            onClick: () => {
              const held = clipRef.current;
              if (!held) return;
              if (held.side === side) void pasteHere(side, held);
              else void pasteOver(side, held);
            },
          }]
        : []),
      { label: "新建文件", hint: "建完就打开", onClick: () => touch(side) },
      { label: "新建目录", onClick: () => mkdir(side) },
      { label: "收藏这个目录", onClick: () => addMark(side) },
      { label: "复制当前路径", onClick: () => void copyText(listing?.path ?? "") },
    ]));
  };

  return (
    <div className={`sftp ${sessionId ? "" : "offline"}`}>
      {!sessionId && (
        <div className="sftp-offline">
          连接断了 · 远程这一栏先冻在这儿，队列也留着；回终端页重连之后接着用
        </div>
      )}

      <FilePane
        side="local"
        title="本地"
        listing={local}
        selected={sel.local}
        marks={marks.filter((m) => m.scope === "local")}
        places={places}
        dropping={null}
        onSelect={(paths) => setSel({ local: paths, remote: [] })}
        onEnter={(entry) => (entry.kind === "dir" ? goLocal(entry.path) : onEditFile("local", entry.path))}
        onGo={goLocal}
        onUp={() => local?.parent && goLocal(local.parent)}
        onRefresh={() => refresh("local")}
        onMkdir={() => mkdir("local")}
        onTouch={() => touch("local")}
        onRename={(entry) => rename("local", entry)}
        onRemove={(entry) => remove("local", entriesFor("local", entry))}
        onEdit={(entry) => onEditFile("local", entry.path)}
        onRowMenu={(entry, e) => rowMenu("local", entry, e)}
        onPaneMenu={(e) => paneMenu("local", e)}
        onRowMouseDown={(entry, e) => beginDrag("local", entry, e)}
        onFocus={() => setFocusSide("local")}
        focused={focusSide === "local"}
        dragging={!!drag}
        dropTarget={drag?.to === "local"}
        dropDir={drag?.to === "local" ? drag.dir : null}
        onTransfer={(entry) => upload(entriesFor("local", entry))}
        onTransferSelected={() => upload(entriesOf("local"))}
        onAddMark={() => addMark("local")}
        onDropMark={dropMark}
        onSync={() => void sync2("local")}
      />

      <FilePane
        side="remote"
        title="远程"
        paneRef={remotePaneRef}
        listing={remote}
        selected={sel.remote}
        marks={marks.filter((m) => m.scope === connId)}
        places={remoteHome ? [{ label: "主目录", path: remoteHome, kind: "home" }, ...REMOTE_PLACES] : REMOTE_PLACES}
        dropping={dropping}
        onSelect={(paths) => setSel({ local: [], remote: paths })}
        onEnter={(entry) => (entry.kind === "dir" ? goRemote(entry.path) : onEditFile("remote", entry.path))}
        onGo={goRemote}
        onUp={() => remote && goRemote(remote.parent ?? parentRemote(remote.path))}
        onRefresh={() => refresh("remote")}
        onMkdir={() => mkdir("remote")}
        onTouch={() => touch("remote")}
        onRename={(entry) => rename("remote", entry)}
        onRemove={(entry) => remove("remote", entriesFor("remote", entry))}
        onEdit={(entry) => onEditFile("remote", entry.path)}
        onRowMenu={(entry, e) => rowMenu("remote", entry, e)}
        onPaneMenu={(e) => paneMenu("remote", e)}
        onRowMouseDown={(entry, e) => beginDrag("remote", entry, e)}
        onFocus={() => setFocusSide("remote")}
        focused={focusSide === "remote"}
        dragging={!!drag}
        dropTarget={drag?.to === "remote"}
        dropDir={drag?.to === "remote" ? drag.dir : null}
        onTransfer={(entry) => download(entriesFor("remote", entry))}
        onTransferSelected={() => download(entriesOf("remote"))}
        onAddMark={() => addMark("remote")}
        onDropMark={dropMark}
        onSync={() => void sync2("remote")}
      />

      {/* 消息自己占一行：传输跑着的时候出了错，也得看得见 */}
      {err && (
        <div className={`sftp-status note ${err.tone === "info" ? "info" : "bad"}`}>
          <span className={err.tone === "info" ? "xfer-tip" : "xfer-err"}>{err.message}</span>
          {err.detail && <small>{err.detail}</small>}
          <span className="foot-spacer" />
          <button className="xfer-close" type="button" onClick={() => setErr(null)} aria-label="知道了" title="知道了">
            <IconX size={13} />
          </button>
        </div>
      )}

      {(stats.total > 0 || busy) && (
        <div className="sftp-status">
          {busy ? (
            <>
              <span className="spin" />
              <span className="xfer-name">{busy.text} · {busy.name}</span>
            </>
          ) : stats.total > 0 ? (
            <>
              <button className="queue-toggle" type="button" onClick={() => setQueueOpen(!queueOpen)} title="展开 / 收起队列">
                {queueOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                队列 {stats.done}/{stats.total}
                {stats.fail > 0 && <b className="queue-fail"> · 失败 {stats.fail}</b>}
              </button>
              {live.length > 0 ? (
                <>
                  <span className="xfer-dir">{live[0].direction === "up" ? "↑" : "↓"}</span>
                  <span className="xfer-name" title={live.map((one) => one.name).join("\n")}>
                    {live[0].name}
                    {live.length > 1 && <i className="xfer-more">+{live.length - 1}</i>}
                  </span>
                  <span className="xfer-bar">
                    <i style={{ width: `${liveTotal ? Math.min(100, (liveDone / liveTotal) * 100) : 100}%` }} />
                  </span>
                  <span className="xfer-num">{fmtSize(liveDone)} / {fmtSize(liveTotal)}</span>
                  {rate && rate.speed > 0 && (
                    <span className="xfer-rate">
                      {fmtSize(rate.speed)}/s
                      {rate.eta > 0 && <small>剩 {fmtDuration(rate.eta)}</small>}
                    </span>
                  )}
                </>
              ) : (
                <span className="xfer-name">{stats.left > 0 ? `还剩 ${stats.left} 个` : "都传完了"}</span>
              )}
              <span className="foot-spacer" />
              {stats.fail > 0 && <button className="xfer-act" type="button" onClick={retryFailed}>重试失败</button>}
              {stats.left > 0 ? (
                <button className="xfer-act" type="button" onClick={cancelQueue} title="排队的丢掉，正在传的也叫停（半截文件由引擎收干净）">取消</button>
              ) : (
                <button className="xfer-act" type="button" onClick={clearDone}>清空</button>
              )}
            </>
          ) : null}
        </div>
      )}

      {stats.total > 0 && queueOpen && (
        <div className="xfer-list">
          {queue.map((task) => (
            <div
              className={`xfer-row ${task.status} ${task.dir}`}
              key={task.id}
              title={`${task.from}\n→ ${task.to}${task.error ? `\n\n${task.error}` : ""}`}
            >
              <span className="xfer-icon">{task.kind === "mkdir" ? "＋" : task.dir === "up" ? "↑" : "↓"}</span>
              <span className="xfer-row-name">{task.name}</span>
              <span className="xfer-row-size">{task.kind === "file" ? fmtSize(task.size) : "目录"}</span>
              <span className="xfer-row-state">
                {task.status === "done" ? "已完成"
                  : task.status === "run" ? "传输中"
                  : task.status === "fail" ? "失败"
                  : "排队中"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 拖拽时跟着鼠标的小牌子 */}
      {drag && (
        <div className="drag-chip" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          {drag.count} 项
          {drag.to
            ? drag.dir
              ? ` → 放进 ${baseName(drag.dir)}/`
              : drag.to === "remote" ? " → 上传" : " → 下载"
            : " · 拖到对面那栏"}
        </div>
      )}

      {dialog && (
        <div className={`fs-pop ${dialog.side}`}>
          <div className="fs-pop-away" onMouseDown={() => setDialog(null)} />
          <Dialog {...dialog} inline onClose={() => setDialog(null)} />
        </div>
      )}

      {chmodTarget && (
        <div className={`fs-pop ${chmodTarget.side}`}>
          <div className="fs-pop-away" onMouseDown={() => setChmodTarget(null)} />
          <ChmodDialog
            name={chmodTarget.entry.name}
            mode={chmodTarget.entry.mode ?? 0o644}
            inline
            onApply={(mode) => applyChmod(chmodTarget.entry, mode)}
            onClose={() => setChmodTarget(null)}
          />
        </div>
      )}

      {clash && (
        <ClashDialog
          tasks={clash.tasks}
          hits={clash.hits}
          onDecide={(tasks) => { setClash(null); push(tasks); }}
          onClose={() => setClash(null)}
        />
      )}

      {syncPlan && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSyncPlan(null)}>
          <div className="modal">
            <div className="modal-head">
              <h3>同步到{syncPlan.side === "local" ? "远程" : "本地"}</h3>
              <button className="icon-btn sm" type="button" onClick={() => setSyncPlan(null)} aria-label="关闭">
                <IconX size={15} />
              </button>
            </div>
            <div className="modal-body">
              <p className="dialog-msg">目标目录：<code>{syncPlan.target}</code></p>
              <div className="sync-nums">
                <span className="sync-num new"><b>{syncPlan.plan.fresh}</b>新增</span>
                <span className="sync-num up"><b>{syncPlan.plan.changed}</b>更新</span>
                <span className="sync-num same"><b>{syncPlan.plan.same}</b>已一致，跳过</span>
              </div>
              <p className="page-meta">
                只往对面推，不删对面多出来的东西。判断依据是大小和修改时间 —— 大小一样、对面又不比这边旧，就当一致。
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" type="button" onClick={() => setSyncPlan(null)}>取消</button>
              <button
                className="btn-primary"
                type="button"
                disabled={syncPlan.plan.fresh + syncPlan.plan.changed === 0}
                onClick={() => { const list = syncPlan.plan.tasks; setSyncPlan(null); push(list); }}
              >
                {syncPlan.plan.fresh + syncPlan.plan.changed === 0
                  ? "已经是一致的"
                  : `传这 ${syncPlan.plan.fresh + syncPlan.plan.changed} 个`}
              </button>
            </div>
          </div>
        </div>
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

interface ClashDialogProps {
  tasks: XferTask[];
  hits: Conflict[];
  onDecide: (tasks: XferTask[]) => void;
  onClose: () => void;
}

/**
 * 覆盖确认：目标位置已经有同名文件时，把「要传的」和「已经在的」摆在一起，
 * 让用户自己看大小和时间再决定。默认什么都不做 —— 传输覆盖是不可撤销的。
 */
function ClashDialog({ tasks, hits, onDecide, onClose }: ClashDialogProps) {
  const clashing = new Set(hits.map((one) => one.task.id));
  // 目标比源小 = 上次多半传了一半断了，这些可以接着传
  const resumable = new Map(
    hits.filter(({ task, existing }) => existing.size > 0 && existing.size < task.size)
      .map(({ task, existing }) => [task.id, existing.size]),
  );

  // 全覆盖：冲突的那些盖掉，其余照传
  const overwriteAll = () =>
    onDecide(tasks.map((one) => (clashing.has(one.id) ? { ...one, overwrite: true } : one)));

  // 续传：能接着传的从断点接着传，接不上的（目标比源还大）就覆盖
  const resumeAll = () =>
    onDecide(
      tasks.map((one) =>
        clashing.has(one.id)
          ? resumable.has(one.id)
            ? { ...one, resume: resumable.get(one.id) }
            : { ...one, overwrite: true }
          : one,
      ),
    );

  // 全跳过：冲突的文件直接不传，目录任务留着（里面可能还有新文件）
  const skipAll = () => onDecide(tasks.filter((one) => !clashing.has(one.id)));

  const rest = tasks.filter((one) => one.kind === "file").length - hits.length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>目标位置已经有 {hits.length} 个同名文件</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body clash-body">
          <p className="dialog-msg">覆盖了就找不回来了。看一眼是不是要盖的那个：</p>
          <div className="clash-cols">
            <span />
            <span>要传过去的</span>
            <span>已经在那儿的</span>
          </div>
          {hits.map(({ task, existing }) => (
            <div className="clash-row" key={task.id}>
              <span className="clash-name" title={task.to}>{task.name}</span>
              <span className="clash-side">
                {fmtSize(task.size)}
                <small>{task.dir === "up" ? "本地" : "远程"}</small>
              </span>
              <span className="clash-side old">
                {fmtSize(existing.size)}
                <small>
                  {resumable.has(task.id)
                    ? `传了一半 · 可续传`
                    : fmtMtime(existing.mtime) || "时间未知"}
                </small>
              </span>
            </div>
          ))}
          {rest > 0 && <p className="page-meta">另外 {rest} 个文件不冲突，照传。</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>算了，都不传</button>
          <button className="btn-ghost" type="button" onClick={skipAll}>跳过这些，传其余的</button>
          {resumable.size > 0 && (
            <button className="btn-ghost" type="button" onClick={resumeAll} title="从上次断掉的地方接着传">
              续传 {resumable.size} 个
            </button>
          )}
          <button className="btn-primary danger" type="button" onClick={overwriteAll}>
            覆盖这 {hits.length} 个
          </button>
        </div>
      </div>
    </div>
  );
}

interface FilePaneProps {
  side: Side;
  title: string;
  paneRef?: React.RefObject<HTMLDivElement>;
  listing: FsListing | null;
  /** 选中的路径们 */
  selected: string[];
  marks: Bookmark[];
  places: Place[];
  dropping: null | "ok" | "busy";
  onSelect: (paths: string[]) => void;
  onEnter: (entry: FsEntry) => void;
  onGo: (path: string) => void;
  onUp: () => void;
  onRefresh: () => void;
  onMkdir: () => void;
  onTouch: () => void;
  onRename: (entry: FsEntry) => void;
  onRemove: (entry: FsEntry) => void;
  onEdit: (entry: FsEntry) => void;
  onRowMenu: (entry: FsEntry, e: React.MouseEvent) => void;
  onPaneMenu: (e: React.MouseEvent) => void;
  /** 按下左键准备拖 */
  onRowMouseDown: (entry: FsEntry, e: React.MouseEvent) => void;
  /** 点了这一栏：键盘快捷键跟着它走 */
  onFocus: () => void;
  focused: boolean;
  /** 现在拖拽悬在这一栏 */
  dropTarget: boolean;
  /** 全局正在拖东西：这时候别弹 hover 图标 */
  dragging: boolean;
  /** 悬在某个目录上就往它里面放 */
  dropDir: string | null;
  onTransfer: (entry: FsEntry) => void;
  onTransferSelected: () => void;
  onAddMark: () => void;
  onDropMark: (mark: Bookmark) => void;
  /** 把这个目录同步到对面 */
  onSync: () => void;
}

function FilePane(props: FilePaneProps) {
  const { side, title, listing, selected, marks, places, dropping, dropTarget, dropDir, focused, dragging } = props;
  const [typing, setTyping] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const anchor = useRef<number | null>(null);
  /** 空白处按住拖出来的选择框 */
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const listBoxRef = useRef<HTMLDivElement>(null);

  // 去过的路径，供「后退」和下拉里的「最近」
  const history = useRef<string[]>([]);
  /** 正在「后退」去的那个路径：到了再出栈，没到（目标目录已经没了）历史就不动 */
  const goingBack = useRef<string | null>(null);
  const path = listing?.path;
  useEffect(() => {
    if (!path) return;
    const list = history.current;
    const arrived = goingBack.current === path;
    goingBack.current = null;
    if (arrived) { list.pop(); return; }
    if (list[list.length - 1] !== path) list.push(path);
    if (list.length > 40) list.shift();
  }, [path]);

  const back = () => {
    const list = history.current;
    if (list.length < 2) return;
    const target = list[list.length - 2];
    goingBack.current = target;
    props.onGo(target);
  };

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const keyword = filter?.trim().toLowerCase() ?? "";
    const visible = showHidden ? all : all.filter((one) => !one.name.startsWith("."));
    const shown = keyword ? visible.filter((one) => one.name.toLowerCase().includes(keyword)) : visible;
    const dir = (one: FsEntry) => (one.kind === "dir" ? 0 : 1);
    const sorted = [...shown].sort((a, b) => {
      if (dir(a) !== dir(b)) return dir(a) - dir(b);
      const flip = sort.desc ? -1 : 1;
      if (sort.key === "size") return (a.size - b.size) * flip;
      if (sort.key === "mtime") return (a.mtime - b.mtime) * flip;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * flip;
    });
    return { shown: sorted, hidden: all.length - shown.length };
  }, [listing, showHidden, sort, filter]);

  const counts = useMemo(() => {
    const dirs = entries.shown.filter((one) => one.kind === "dir").length;
    return { dirs, files: entries.shown.length - dirs };
  }, [entries]);

  // —— 长目录只画看得见的那些 ——
  // /usr/bin 这种几千个文件的目录，全画出来就是几千个 DOM 节点，滚起来明显卡。
  // 行高是固定的，所以能直接算出「现在该画第几行到第几行」，上下各多画一屏兜底。
  const [view, setView] = useState({ top: 0, height: 600 });
  const onScroll = () => {
    const box = listBoxRef.current;
    if (box) setView({ top: box.scrollTop, height: box.clientHeight });
  };
  useEffect(() => {
    const box = listBoxRef.current;
    if (!box) return;
    const measure = () => setView({ top: box.scrollTop, height: box.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // 目录换了就回到顶上，别停在上一个目录的滚动位置
  useEffect(() => { listBoxRef.current?.scrollTo({ top: 0 }); }, [path]);

  const window_ = useMemo(() => {
    const total = entries.shown.length;
    // 少于这个数就全画，省得为几十行还去算窗口
    if (total <= VIRTUAL_FROM) return { from: 0, to: total, padTop: 0, padBottom: 0 };
    const over = 20;
    const from = Math.max(0, Math.floor(view.top / ROW_H) - over);
    const to = Math.min(total, Math.ceil((view.top + view.height) / ROW_H) + over);
    return { from, to, padTop: from * ROW_H, padBottom: (total - to) * ROW_H };
  }, [entries.shown.length, view]);

  /** 单击 = 只选它 · Ctrl 单击 = 加减 · Shift 单击 = 选一段 */
  const pick = (entry: FsEntry, index: number, e: React.MouseEvent) => {
    const paths = entries.shown.map((one) => one.path);
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = anchor.current <= index ? [anchor.current, index] : [index, anchor.current];
      props.onSelect(paths.slice(from, to + 1));
      return;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) {
      props.onSelect(selected.includes(entry.path) ? selected.filter((one) => one !== entry.path) : [...selected, entry.path]);
      return;
    }
    props.onSelect([entry.path]);
  };

  /** 在列表空白处按下 → 拉框选择，框到哪些行就选哪些 */
  const startBand = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-path]") || target.closest("button")) return; // 点在行上/按钮上不算框选
    const origin = { x: e.clientX, y: e.clientY };
    const additive = e.ctrlKey || e.metaKey;
    const before = additive ? selected : [];
    let moved = false;
    setBand({ x1: origin.x, y1: origin.y, x2: origin.x, y2: origin.y });

    const move = (ev: MouseEvent) => {
      // 没挪动就还不算框选，留给「点空白 = 取消选择」
      if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 4) return;
      moved = true;
      const box = { x1: origin.x, y1: origin.y, x2: ev.clientX, y2: ev.clientY };
      setBand(box);
      const top = Math.min(box.y1, box.y2);
      const bottom = Math.max(box.y1, box.y2);

      // 长目录只画了看得见的那几行，靠 DOM 查是框不到屏幕外的。
      // 行高是固定的，直接按几何算命中的区间 —— 屏幕外的也照样算得到。
      const list = listBoxRef.current;
      if (!list) return;
      const rect = list.getBoundingClientRect();
      // 列表顶部可能还顶着一行 ".."，它不算数据行
      const offset = list.querySelector<HTMLElement>(".fs-row.up")?.offsetHeight ?? 0;
      const toIndex = (y: number) => Math.floor((y - rect.top + list.scrollTop - offset) / ROW_H);
      const first = Math.max(0, toIndex(top));
      const last = Math.min(entries.shown.length - 1, toIndex(bottom));
      const hit = first <= last ? entries.shown.slice(first, last + 1).map((one) => one.path) : [];
      props.onSelect([...new Set([...before, ...hit])]);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", abort);
      window.removeEventListener("keydown", onEsc);
    };
    // 切走窗口（截图、Alt+Tab）收不到 mouseup，得靠 blur 兜底，不然框会一直挂着
    function abort() { setBand(null); cleanup(); }
    function onEsc(ev: KeyboardEvent) { if (ev.key === "Escape") abort(); }
    const up = () => {
      setBand(null);
      // 点一下空白（没拖出框）= 取消选择；按着 Ctrl 点则保留原选
      if (!moved && !additive) {
        props.onSelect([]);
        anchor.current = null;
      }
      cleanup();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", abort);
    window.addEventListener("keydown", onEsc);
  };

  /**
   * 方向键在列表里走。
   * 之前只能靠鼠标 —— 一个文件管理器不能用键盘选东西是说不过去的。
   * 只在「这一栏是当前焦点」而且没在输入框里打字时接管。
   */
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (document.querySelector(".modal-backdrop") || document.querySelector(".ctx-menu")) return;

      const list = entries.shown;
      if (list.length === 0) return;
      const at = anchor.current ?? list.findIndex((one) => selected.includes(one.path));

      const goTo = (index: number, extend: boolean) => {
        const clamped = Math.min(list.length - 1, Math.max(0, index));
        anchor.current = clamped;
        if (extend && at >= 0) {
          const [from, to] = at <= clamped ? [at, clamped] : [clamped, at];
          props.onSelect(list.slice(from, to + 1).map((one) => one.path));
        } else {
          props.onSelect([list[clamped].path]);
        }
        // 走出可视范围就把它滚回来。长目录只渲染看得见的那几行，End / PageDown 的目标行
        // 多半还不在 DOM 里，靠 querySelector 找不到；行高固定，直接按几何算位置
        const box = listBoxRef.current;
        if (box) {
          const offset = box.querySelector<HTMLElement>(".fs-row.up")?.offsetHeight ?? 0;
          const top = offset + clamped * ROW_H;
          if (top < box.scrollTop) box.scrollTo({ top });
          else if (top + ROW_H > box.scrollTop + box.clientHeight) box.scrollTo({ top: top + ROW_H - box.clientHeight });
        }
      };

      if (e.key === "ArrowDown") { e.preventDefault(); goTo(at < 0 ? 0 : at + 1, e.shiftKey); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); goTo(at < 0 ? list.length - 1 : at - 1, e.shiftKey); return; }
      if (e.key === "Home") { e.preventDefault(); goTo(0, e.shiftKey); return; }
      if (e.key === "End") { e.preventDefault(); goTo(list.length - 1, e.shiftKey); return; }
      if (e.key === "PageDown") { e.preventDefault(); goTo((at < 0 ? 0 : at) + 12, e.shiftKey); return; }
      if (e.key === "PageUp") { e.preventDefault(); goTo((at < 0 ? 0 : at) - 12, e.shiftKey); return; }
      if (e.key === "Enter" && at >= 0 && list[at]) { e.preventDefault(); props.onEnter(list[at]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleSort = (key: SortKey) => setSort((old) => ({ key, desc: old.key === key ? !old.desc : key !== "name" }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.desc ? " ↓" : " ↑") : "");

  const known = new Set([...places.map((one) => one.path), ...marks.map((one) => one.path)]);
  const recent = [...new Set([...history.current].reverse())].filter((one) => one !== path && !known.has(one)).slice(0, 4);
  const jump = (target: string) => { setMenuOpen(false); props.onGo(target); };

  return (
    <section
      className={`fs-pane ${dropping ? "dropping" : ""} ${dropTarget ? "drop-in" : ""} ${focused ? "focused" : ""}`}
      ref={props.paneRef}
      data-side={side}
      onMouseDown={props.onFocus}
    >
      <header className="fs-head">
        <span className="fs-side">{title}</span>
        <button className="fs-nav" type="button" title="后退（回上一个目录）" aria-label="后退" onClick={back}>
          <IconArrowLeft size={15} />
        </button>
        <button className="fs-nav" type="button" title="上级目录" aria-label="上级目录" onClick={props.onUp}>
          <IconCornerUp size={15} />
        </button>

        <div className="fs-path-wrap">
          {typing === null ? (
            <button
              className="fs-path"
              type="button"
              title={`${listing?.path ?? ""}\n点开看各级目录、最近去过和收藏`}
              onClick={() => setMenuOpen((on) => !on)}
            >
              <span>{listing?.path ?? "……"}</span>
              <IconChevronDown size={13} />
            </button>
          ) : (
            <input
              className="fs-path-input"
              autoFocus
              value={typing}
              spellCheck={false}
              placeholder="敲个路径，回车跳过去"
              onChange={(e) => setTyping(e.target.value)}
              onBlur={() => setTyping(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setTyping(null);
                if (e.key === "Enter" && !e.nativeEvent.isComposing) { props.onGo(typing); setTyping(null); }
              }}
            />
          )}

          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="fs-path-menu">
                {places.length > 0 && (
                  <>
                    <div className="menu-sec">{side === "local" ? "此电脑" : "常去的地方"}</div>
                    {places.map((place) => (
                      <button className="menu-row" type="button" key={place.path} onClick={() => jump(place.path)}>
                        {place.kind === "drive" ? <IconDrive size={13} /> : place.kind === "home" ? <IconHome size={13} /> : <IconFiles size={13} />}
                        {place.label}
                        <small>{place.path}</small>
                      </button>
                    ))}
                  </>
                )}

                <div className="menu-sec">当前路径各级</div>
                {crumbs(listing?.path ?? "").map((crumb) => (
                  <button className="menu-row" type="button" key={crumb.path} onClick={() => jump(crumb.path)}>
                    <IconFiles size={13} />{crumb.label}
                    <small>{crumb.path}</small>
                  </button>
                ))}

                {recent.length > 0 && (
                  <>
                    <div className="menu-sec">最近去过</div>
                    {recent.map((one) => (
                      <button className="menu-row" type="button" key={one} onClick={() => jump(one)}>
                        <IconArrowLeft size={13} />{baseName(one) || one}
                        <small>{one}</small>
                      </button>
                    ))}
                  </>
                )}

                {marks.length > 0 && (
                  <>
                    <div className="menu-sec">收藏</div>
                    {marks.map((mark) => (
                      <button className="menu-row" type="button" key={mark.id} onClick={() => jump(mark.path)}>
                        <IconStar size={13} />{mark.label}
                        <small>{mark.path}</small>
                      </button>
                    ))}
                  </>
                )}

                <div className="menu-foot">
                  <button type="button" onClick={() => { setMenuOpen(false); setTyping(listing?.path ?? ""); }}>
                    手动输入路径
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <span className="fs-tools">
          <button
            type="button"
            className={filter !== null ? "on" : ""}
            title="按名字过滤当前目录"
            aria-label="过滤"
            onClick={() => setFilter((one) => (one === null ? "" : null))}
          >
            <IconSearch size={14} />
          </button>
          <button
            type="button"
            title={`同步到${side === "local" ? "远程" : "本地"}：只推新增和改过的，不删对面的东西`}
            aria-label="同步到对面"
            onClick={props.onSync}
          >
            <IconSync size={14} />
          </button>
          <button type="button" title="刷新" aria-label="刷新" onClick={props.onRefresh}><IconRefresh size={14} /></button>
          <button type="button" title="在这里新建文件" aria-label="新建文件" onClick={props.onTouch}><IconFilePlus size={14} /></button>
          <button type="button" title="在这里新建目录" aria-label="新建目录" onClick={props.onMkdir}><IconFolderPlus size={14} /></button>
          <button type="button" title="收藏当前目录" aria-label="收藏当前目录" onClick={props.onAddMark}><IconStar size={14} /></button>
          <button
            type="button"
            className={showHidden ? "on" : ""}
            title={showHidden ? "隐藏「.」开头的文件" : "显示「.」开头的隐藏文件"}
            aria-label="隐藏文件开关"
            onClick={() => setShowHidden((on) => !on)}
          >
            {showHidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
          </button>
        </span>
      </header>

      {filter !== null && (
        <div className="fs-filter">
          <IconSearch size={13} />
          <input
            autoFocus
            value={filter}
            placeholder="只看名字里带……的"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter(null)}
          />
          <button type="button" title="收起（Esc）" onClick={() => setFilter(null)}><IconX size={12} /></button>
        </div>
      )}

      {marks.length > 0 && (
        <div className="fs-marks">
          {marks.map((mark) => (
            <span className="fs-mark" key={mark.id}>
              <button type="button" title={`去 ${mark.path}`} onClick={() => props.onGo(mark.path)}>
                <IconStar size={11} />{mark.label}
              </button>
              <button className="fs-mark-x" type="button" aria-label="取消收藏" title="取消收藏" onClick={() => props.onDropMark(mark)}>
                <IconX size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="fs-cols">
        <span />
        <button type="button" title="按名字排序" onClick={() => toggleSort("name")}>名称{arrow("name")}</button>
        <button type="button" title="按大小排序" onClick={() => toggleSort("size")}>大小{arrow("size")}</button>
        <span>权限</span>
        <button type="button" title="按修改时间排序" onClick={() => toggleSort("mtime")}>修改时间{arrow("mtime")}</button>
      </div>

      <div
        className={`fs-list ${band || dragging ? "no-hover" : ""}`}
        ref={listBoxRef}
        onContextMenu={props.onPaneMenu}
        onMouseDown={startBand}
        onScroll={onScroll}
      >
        {!listing ? (
          <p className="fs-empty">读取中……</p>
        ) : (
          <>
            {listing.parent && (
              <div
                className="fs-row up"
                role="button"
                tabIndex={0}
                title={`上级目录：${listing.parent}`}
                onClick={props.onUp}
                onKeyDown={(e) => e.key === "Enter" && props.onUp()}
              >
                <span className="fs-icon dir"><IconCornerUp size={14} /></span>
                <span className="fs-name">..</span>
                <span className="fs-size" />
                <span className="fs-mode" />
                <span className="fs-time">上级目录</span>
              </div>
            )}

            {entries.shown.length === 0 ? (
              <p className="fs-empty">
                {filter ? "这个目录里没有名字带这串的。" : entries.hidden > 0 ? `只有 ${entries.hidden} 个隐藏项，点眼睛看。` : "空目录。"}
              </p>
            ) : (
              <>
              {window_.padTop > 0 && <div style={{ height: window_.padTop }} />}
              {entries.shown.slice(window_.from, window_.to).map((entry, offset) => {
                const index = window_.from + offset;
                return (
                <div
                  key={entry.path}
                  className={`fs-row ${selected.includes(entry.path) ? "on" : ""} ${dropDir === entry.path ? "drop-here" : ""}`}
                  role="button"
                  tabIndex={0}
                  title={entry.kind === "dir" ? `${entry.name} —— 双击进入` : `${entry.name} —— 双击用编辑器打开`}
                  data-path={entry.path}
                  data-dir={entry.kind === "dir" ? entry.path : undefined}
                  onMouseDown={(e) => {
                    // Shift / Ctrl 点会顺带选中一片文字，拦掉
                    if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
                    props.onRowMouseDown(entry, e);
                  }}
                  onClick={(e) => pick(entry, index, e)}
                  onDoubleClick={() => props.onEnter(entry)}
                  onContextMenu={(e) => {
                    if (!selected.includes(entry.path)) pick(entry, index, e);
                    props.onRowMenu(entry, e);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && props.onEnter(entry)}
                >
                  <span className={`fs-icon ${entry.kind}`}>
                    {entry.kind === "dir" ? <IconFiles size={14} /> : entry.kind === "link" ? <IconLink size={14} /> : <IconFile size={14} />}
                  </span>
                  <span className="fs-name">{entry.name}</span>
                  <span className="fs-size">{entry.kind === "dir" ? "" : fmtSize(entry.size)}</span>
                  <span className="fs-mode">{fmtMode(entry.mode)}</span>
                  <span className="fs-time">{fmtMtime(entry.mtime)}</span>
                  <span className="fs-row-actions">
                    {entry.kind !== "dir" && (
                      <button type="button" aria-label="编辑" title="用内置编辑器打开" onClick={(e) => { e.stopPropagation(); props.onEdit(entry); }}>
                        <IconFileEdit size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={side === "local" ? "上传" : "下载"}
                      title={side === "local" ? "上传到远程当前目录（目录也行）" : "下载到本地当前目录（目录也行）"}
                      onClick={(e) => { e.stopPropagation(); props.onTransfer(entry); }}
                    >
                      {side === "local" ? <IconUpload size={13} /> : <IconDownload size={13} />}
                    </button>
                    <button type="button" aria-label="改名" title="改名" onClick={(e) => { e.stopPropagation(); props.onRename(entry); }}>
                      <IconEdit size={13} />
                    </button>
                    <button type="button" aria-label="删除" title="删除" onClick={(e) => { e.stopPropagation(); props.onRemove(entry); }}>
                      <IconTrash size={13} />
                    </button>
                  </span>
                </div>
                );
              })}
              {window_.padBottom > 0 && <div style={{ height: window_.padBottom }} />}
              </>
            )}
          </>
        )}
        {band && (
          <div
            className="fs-band"
            style={{
              left: Math.min(band.x1, band.x2),
              top: Math.min(band.y1, band.y2),
              width: Math.abs(band.x2 - band.x1),
              height: Math.abs(band.y2 - band.y1),
            }}
          />
        )}
        {dropping && (
          <div className={`fs-drop-hint ${dropping === "busy" ? "warn" : ""}`}>
            {dropping === "busy" ? "连接不在了" : `松手就传到 ${listing?.path ?? "这儿"}`}
          </div>
        )}
      </div>

      <footer className="fs-foot">
        <span>{counts.dirs} 个目录 · {counts.files} 个文件</span>
        {entries.hidden > 0 && <span className="fs-foot-dim">藏着 {entries.hidden} 个</span>}
        {selected.length === 0 && (
          <span className="fs-foot-dim">↑↓ 选 · Del 删 · Ctrl+C/X/V 复制剪切粘贴（粘到对面那栏就是传输）</span>
        )}
        {selected.length > 0 && (
          <>
            <span className="foot-spacer" />
            <span className="fs-foot-sel">选中 {selected.length} 个</span>
            <button className="fs-foot-btn" type="button" onClick={props.onTransferSelected}>
              {side === "local" ? <IconUpload size={12} /> : <IconDownload size={12} />}
              {side === "local" ? "上传" : "下载"}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
