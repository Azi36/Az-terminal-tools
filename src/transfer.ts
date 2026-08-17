import { invoke } from "@tauri-apps/api/core";
import type { FsEntry, FsListing } from "./types";

/**
 * 传输计划：把「选中的这些东西」摊平成一串任务。
 * 目录递归展开成「先建目录，再传里面的文件」，所以目录整体传输也走同一套队列。
 */

export type Side = "local" | "remote";

export interface XferTask {
  id: string;
  /** mkdir 只建目录，file 才真传 */
  kind: "file" | "mkdir";
  dir: "up" | "down";
  from: string;
  to: string;
  name: string;
  size: number;
  /** 源文件的修改时间（Unix 秒）；目录同步靠它判断新旧 */
  mtime: number;
  status: "wait" | "run" | "done" | "fail";
  error?: string;
  /** 目标位置已经有东西了，用户点过头才准覆盖 */
  overwrite?: boolean;
  /** 从这个字节数接着传（断点续传）；0 或不填就是从头 */
  resume?: number;
}

/** 目标位置上已经存在的那个东西 */
export interface Stat {
  size: number;
  mtime: number;
  isDir: boolean;
}

/** 一处覆盖冲突：要传的这个，和目标位置上已经有的那个 */
export interface Conflict {
  task: XferTask;
  existing: Stat;
}

/**
 * 传之前先问一句目标位置有没有同名的。
 * 一次批量问完（本地一个调用、远程一个调用），不为每个文件来回跑。
 */
export async function findConflicts(tasks: XferTask[], sessionId: string): Promise<Conflict[]> {
  // 目录只要存在就复用，不算冲突；真会盖掉内容的只有文件
  const files = tasks.filter((one) => one.kind === "file");
  if (files.length === 0) return [];

  const up = files.filter((one) => one.dir === "up");
  const down = files.filter((one) => one.dir === "down");
  const found: Conflict[] = [];

  const collect = async (list: XferTask[], stats: (Stat | null)[]) => {
    list.forEach((task, i) => {
      const existing = stats[i];
      if (existing && !existing.isDir) found.push({ task, existing });
    });
  };

  try {
    if (up.length > 0) {
      const stats = await invoke<(Stat | null)[]>("sftp_stat", { sessionId, paths: up.map((one) => one.to) });
      await collect(up, stats);
    }
    if (down.length > 0) {
      const stats = await invoke<(Stat | null)[]>("local_stat", { paths: down.map((one) => one.to) });
      await collect(down, stats);
    }
  } catch {
    // 探测失败就当没冲突：Rust 侧还有一道 overwrite 兜底，不会闷声盖掉东西
    return [];
  }
  return found;
}

export const joinLocal = (dir: string, name: string) =>
  dir.includes("\\") ? `${dir.replace(/\\+$/, "")}\\${name}` : `${dir.replace(/\/+$/, "")}/${name}`;

export const joinRemote = (dir: string, name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

let seq = 0;
const nextId = () => `x${(seq += 1)}`;

/** 本地 → 远程 */
export async function planUpload(entries: FsEntry[], remoteDir: string): Promise<XferTask[]> {
  const tasks: XferTask[] = [];

  const walk = async (entry: FsEntry, targetDir: string) => {
    if (entry.kind === "dir") {
      const to = joinRemote(targetDir, entry.name);
      tasks.push({ id: nextId(), kind: "mkdir", dir: "up", from: entry.path, to, name: entry.name, size: 0, mtime: entry.mtime, status: "wait" });
      const listing = await invoke<FsListing>("local_list", { path: entry.path });
      for (const child of listing.entries) await walk(child, to);
      return;
    }
    tasks.push({
      id: nextId(), kind: "file", dir: "up",
      from: entry.path, to: joinRemote(targetDir, entry.name),
      name: entry.name, size: entry.size, mtime: entry.mtime, status: "wait",
    });
  };

  for (const entry of entries) await walk(entry, remoteDir);
  return tasks;
}

/** 远程 → 本地 */
export async function planDownload(entries: FsEntry[], localDir: string, sessionId: string): Promise<XferTask[]> {
  const tasks: XferTask[] = [];

  const walk = async (entry: FsEntry, targetDir: string) => {
    if (entry.kind === "dir") {
      const to = joinLocal(targetDir, entry.name);
      tasks.push({ id: nextId(), kind: "mkdir", dir: "down", from: entry.path, to, name: entry.name, size: 0, mtime: entry.mtime, status: "wait" });
      const listing = await invoke<FsListing>("sftp_list", { sessionId, path: entry.path });
      for (const child of listing.entries) await walk(child, to);
      return;
    }
    tasks.push({
      id: nextId(), kind: "file", dir: "down",
      from: entry.path, to: joinLocal(targetDir, entry.name),
      name: entry.name, size: entry.size, mtime: entry.mtime, status: "wait",
    });
  };

  for (const entry of entries) await walk(entry, localDir);
  return tasks;
}

/**
 * 目录同步：把源目录里「对面没有的」和「对面旧了的」挑出来，其余跳过。
 *
 * 判断标准跟 rsync 那套一致：大小不一样、或者源比目标新，就算要更新。
 * 不删对面多出来的东西 —— 同步删除是很容易出事的操作，不该藏在一个按钮后面。
 */
export interface SyncPlan {
  tasks: XferTask[];
  /** 对面没有的 */
  fresh: number;
  /** 对面有但旧了的 */
  changed: number;
  /** 一模一样，不用动的 */
  same: number;
}

export async function planSync(
  entries: FsEntry[],
  targetDir: string,
  dir: "up" | "down",
  sessionId: string,
): Promise<SyncPlan> {
  const all = dir === "up" ? await planUpload(entries, targetDir) : await planDownload(entries, targetDir, sessionId);
  const files = all.filter((one) => one.kind === "file");
  if (files.length === 0) return { tasks: all, fresh: 0, changed: 0, same: 0 };

  // 目标端的情况一次问完
  let stats: (Stat | null)[] = [];
  try {
    stats = dir === "up"
      ? await invoke<(Stat | null)[]>("sftp_stat", { sessionId, paths: files.map((one) => one.to) })
      : await invoke<(Stat | null)[]>("local_stat", { paths: files.map((one) => one.to) });
  } catch {
    // 问不到就当对面什么都没有，全传一遍（宁可多传，不要漏传）
    return { tasks: all, fresh: files.length, changed: 0, same: 0 };
  }

  const skip = new Set<string>();
  let fresh = 0;
  let changed = 0;
  let same = 0;

  files.forEach((task, i) => {
    const there = stats[i];
    if (!there) { fresh += 1; return; }
    // 大小一样、而且目标不比源旧 → 认为一致
    if (there.size === task.size && (task.mtime === 0 || there.mtime >= task.mtime)) {
      skip.add(task.id);
      same += 1;
      return;
    }
    changed += 1;
    task.overwrite = true;
  });

  return { tasks: all.filter((one) => !skip.has(one.id)), fresh, changed, same };
}

/** 从本机拖进来的裸路径（不知道是文件还是目录，问一下 Rust） */
export async function planDroppedPaths(paths: string[], remoteDir: string): Promise<XferTask[]> {
  const entries: FsEntry[] = [];
  for (const path of paths) {
    const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
    // 能当目录列出来就是目录
    try {
      await invoke<FsListing>("local_list", { path });
      entries.push({ name, path, kind: "dir", size: 0, mtime: 0 });
    } catch {
      entries.push({ name, path, kind: "file", size: 0, mtime: 0 });
    }
  }
  return planUpload(entries, remoteDir);
}
