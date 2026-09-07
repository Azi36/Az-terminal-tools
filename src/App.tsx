import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  IconChevronDown, IconChevronRight, IconCommand, IconDatabase, IconNote, IconPlus, IconServer, IconSettings, IconArrowLeft, IconX, IconTerminal,
} from "./components/icons";
import { ConnectionList, type ConnStatus } from "./components/ConnectionList";
import { SnippetPanel } from "./components/SnippetPanel";
import { NotePanel } from "./components/NotePanel";
import { TabBar, type TabItem } from "./components/TabBar";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { Dialog, type DialogSpec } from "./components/Dialog";
import { Settings } from "./views/Settings";
import { ConnectionPage } from "./views/ConnectionPage";
import { SessionView } from "./views/SessionView";
import { NoteView } from "./views/NoteView";
import { FileEditor } from "./views/FileEditor";
import { LogView } from "./views/LogView";
import { applyMode, initMode, resolveMode, setMode as persistMode, watchSystem, type ThemeMode } from "./theme";
import {
  deleteConnection,
  deleteNote,
  deleteSnippet,
  forgetScope,
  loadConnections,
  loadDbs,
  loadNotes,
  loadOpenTabs,
  loadSettings,
  loadSnippets,
  newId,
  saveOpenTabs,
  saveConnection,
  saveDb,
  deleteDb,
  saveNote,
  saveSettings,
  saveSnippet,
  type AppSettings,
  type SavedTab,
} from "./store";
import { applyHotkey } from "./hotkey";
import { matchShortcut, PAGE_SHORTCUTS, SHORTCUTS } from "./shortcuts";
import { LocalView } from "./views/LocalView";
import { DbView } from "./views/DbView";
import { DbPage } from "./views/DbPage";
import { DbList } from "./components/DbList";
import { HomeView } from "./views/HomeView";
import type { MenuEntry } from "./components/ContextMenu";
import { dropSecret } from "./secrets";
import { checkRelease, type Release } from "./update";
import type { Connection, DbConn, Note, SessionMode, Snippet, Tab, Wake } from "./types";

type Drawer = "conns" | "snippets" | "notes";

/**
 * Az-term 外壳：
 * 左边三个抽屉（连接 / 指令 / 备忘），右边多标签工作区。
 * 一台服务器一个标签，终端 / 文件 / 配置都在标签里面切，不拿浮层盖窗口。
 * 会话标签全程挂载不卸载，切走的终端还活着，回来接着敲。
 */
function App() {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  /** 命令面板开着没有（Ctrl+Shift+P） */
  const [palette, setPalette] = useState(false);
  /**
   * 同步输入组：哪些会话标签在里面。
   *
   * **故意不落盘**。往十台生产机同时敲命令这件事，重开一次应用就该重新决定一遍，
   * 不该因为上次开着、这次开机就默默还开着。
   */
  const [syncTabs, setSyncTabs] = useState<Record<string, true>>({});
  /**
   * 分屏：另一半摆哪个标签。null = 没分屏。
   *
   * 拆的是工作区不是终端 —— 一个标签里再切一个同一条会话的终端没有意义，
   * 人要的是「左边跑着日志，右边敲命令」，那是两个标签的事。
   */
  const [splitTab, setSplitTab] = useState<string | null>(null);
  /**
   * 分屏时有焦点的那块摆在前面（左 / 上）还是后面。
   * 焦点和位置得拆开：点右半那块拿焦点时，它不该跳到左边去 ——
   * 鼠标底下的东西换了，终端场景基本没法用。
   */
  const [mainFirst, setMainFirst] = useState(true);
  const [splitDir, setSplitDir] = useState<"row" | "col">("row");
  /** 左边（上边）那块占多少，0.2 ~ 0.8 */
  const [splitRatio, setSplitRatio] = useState(0.5);
  /** 全局热键上次注册失败的原因 —— 组合被别的软件占了是最常见的一种 */
  const [hotkeyErr, setHotkeyErr] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<string>("检测中……");
  const [drawer, setDrawer] = useState<Drawer>("conns");

  const [connections, setConnections] = useState<Connection[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** tabId -> 活着的 SSH 会话 id（没连上就是 null） */
  const [sessions, setSessions] = useState<Record<string, string | null>>({});
  /** tabId -> 会话标签停在哪一页，下次开应用照着摆回来 */
  const [tabModes, setTabModes] = useState<Record<string, SessionMode>>({});
  /** 标签有没有没保存的改动（编辑器、连接配置） */
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  /**
   * 侧栏又点了一次已经开着的那台：让那个标签切到对应的页、该连就连。
   * 不这样的话，先单击开了标签、再双击就只是切过去，连接那一下没人执行。
   */
  const [wakes, setWakes] = useState<Record<string, Wake>>({});
  /** 本地终端标签此刻待在哪个目录（恢复标签时从那儿起） */
  const [localCwd, setLocalCwd] = useState<Record<string, string>>({});
  /** 本地终端标签里活着的 pty id；shell 退了就是 null */
  const [localPtys, setLocalPtys] = useState<Record<string, string | null>>({});
  const [dbs, setDbs] = useState<DbConn[]>([]);

  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  // 初值直接从落盘的那份读（没有就是 cleanSettings 给的默认值），别在这儿再抄一份默认值
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  /** 界面此刻实际是深还是浅（system 模式也算出来），终端「跟随界面」靠它 */
  const [uiVariant, setUiVariant] = useState<"dark" | "light">("dark");
  /** 后端说有新版了；null = 没有或者没查到 */
  const [fresh, setFresh] = useState<Release | null>(null);
  // 版本号只有 package.json 一个来源，vite 在构建时塞进来。
  // 以前这儿硬写一个 "0.6.0"，改版本时四个地方要同时记得改，迟早对不上。
  const version = __APP_VERSION__;

  /** 从本地存储把所有东西重读一遍（导入备份之后要用） */
  const reloadAll = useCallback(() => {
    setConnections(loadConnections());
    setSnippets(loadSnippets());
    setNotes(loadNotes());
    setDbs(loadDbs());
    setSettings(loadSettings());
  }, []);

  useEffect(() => {
    const start = initMode();
    setModeState(start);
    setUiVariant(resolveMode(start));
    reloadAll();
    invoke<string>("engine_ping")
      .then((reply) => setEngineStatus(reply))
      .catch(() => setEngineStatus("引擎未响应"));

    // 把上次开着的标签摆回来。**不自动连** —— 一开应用就往一堆服务器上连，
    // 有的还要弹密码框，这不是好客人的做法；点一下「连接」就行。
    const conf = loadSettings();
    if (!conf.restoreTabs) return;
    const conns = loadConnections();
    const notes = loadNotes();
    const back: Tab[] = [];
    for (const one of loadOpenTabs()) {
      if (one.kind === "session" && conns.some((conn) => conn.id === one.connId)) {
        back.push({
          id: newId(),
          kind: "session",
          connId: one.connId,
          initialMode: (one.mode as SessionMode) ?? "term",
          autoConnect: false,
        });
      } else if (one.kind === "note" && notes.some((note) => note.id === one.noteId)) {
        back.push({ id: newId(), kind: "note", noteId: one.noteId });
      } else if (one.kind === "settings") {
        back.push({ id: newId(), kind: "settings" });
      } else if (one.kind === "local") {
        back.push({ id: newId(), kind: "local", cwd: one.cwd });
      } else if (one.kind === "db" && loadDbs().some((db) => db.id === one.dbId)) {
        back.push({ id: newId(), kind: "db", dbId: one.dbId, initialMode: "console", autoConnect: false });
      }
    }
    if (back.length > 0) {
      setTabs(back);
      setActiveTab(back[0].id);
    }
  }, []);

  // 开起来之后过一会儿，顺手问一句有没有新版。
  // 「过一会儿」是故意的：启动那几秒该留给用户连服务器，不跟他抢网络。
  // 拿不到就当没有，界面上什么都不会出现。
  // 全局热键跟着设置走：换一个就先摘掉旧的再挂新的。
  // 注册失败（组合被别的软件占了）不能装作成功，得把话说回去。
  useEffect(() => {
    let dead = false;
    applyHotkey(settings.hotkey).then((why) => { if (!dead) setHotkeyErr(why); });
    return () => { dead = true; };
  }, [settings.hotkey]);

  useEffect(() => {
    if (!settings.updateNotice) { setFresh(null); return; }
    // 关掉提示后已经发出去的那次请求回来了也别再弹
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkRelease(version).then((got) => { if (!cancelled) setFresh(got); });
    }, 4000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settings.updateNotice, version]);

  // 标签变了就记一笔，下次开应用照着摆回来
  const restoring = useRef(true);
  useEffect(() => {
    // 首屏那次是「恢复」本身，别拿空列表把记录冲了
    if (restoring.current) { restoring.current = false; return; }
    saveOpenTabs(
      tabs.flatMap<SavedTab>((tab) => {
        if (tab.kind === "session") return [{ kind: "session", connId: tab.connId, mode: tabModes[tab.id] }];
        if (tab.kind === "note") return [{ kind: "note", noteId: tab.noteId }];
        if (tab.kind === "settings") return [{ kind: "settings" }];
        if (tab.kind === "local") return [{ kind: "local", cwd: localCwd[tab.id] ?? tab.cwd }];
        if (tab.kind === "db") return [{ kind: "db", dbId: tab.dbId }];
        return [];
      }),
    );
  }, [tabs, tabModes, localCwd]);

  // 关窗口前拦一句：编辑器里没保存的内容、正跑着的会话，关掉就没了。
  // 拦下来之后必须自己 destroy()，否则窗口关不掉 —— 权限在 capabilities/default.json。
  useEffect(() => {
    const win = getCurrentWindow();
    let un: UnlistenFn | undefined;
    let dead = false;
    win
      .onCloseRequested((event) => {
        const unsaved = Object.values(dirtyRef.current).filter(Boolean).length;
        const live = Object.values(sessionsRef.current).filter(Boolean).length;
        // 没什么可丢的就别拦，正常关
        if (unsaved === 0 && live === 0) return;
        event.preventDefault();
        const parts = [unsaved > 0 ? `${unsaved} 个标签没保存` : "", live > 0 ? `${live} 条会话连着` : ""].filter(Boolean);
        setDialog({
          title: "关掉 AzTerm？",
          message: `还有 ${parts.join(" · ")}。关了改动就没了，会话也会断。`,
          confirmText: "关掉",
          danger: true,
          onConfirm: () => void win.destroy(),
        });
      })
      .then((fn) => {
        if (dead) fn();
        else un = fn;
      });
    return () => { dead = true; un?.(); };
  }, []);

  // 屏蔽 webview 自带的右键菜单（重新加载 / 查看源代码），一律用我们自己的
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  // —— 应用级快捷键 ——
  // 键位表在 shortcuts.ts：一律带 Shift 或 Alt，不跟 shell 里的 Ctrl 组合抢
  // （Ctrl+W 是删词、Ctrl+P 是上一条历史）。Terminal.tsx 按同一张表放行，事件才到得了这儿。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = matchShortcut(e);
      if (!hit) return;
      const list = tabsRef.current;
      const here = list.find((tab) => tab.id === activeTab);
      switch (hit.action) {
        case "palette":
          e.preventDefault();
          setPalette((on) => !on);
          return;
        case "nextTab":
        case "prevTab": {
          if (list.length < 2) return;
          e.preventDefault();
          const at = list.findIndex((tab) => tab.id === activeTab);
          const step = hit.action === "prevTab" ? -1 : 1;
          focusTab(list[(at + step + list.length) % list.length].id);
          return;
        }
        case "nthTab": {
          // 9 是最后一个，跟浏览器一个规矩
          const target = hit.nth === 9 ? list[list.length - 1] : list[hit.nth - 1];
          if (!target) return;
          e.preventDefault();
          focusTab(target.id);
          return;
        }
        case "closeTab":
          // 没保存的照样会问一句
          if (!activeTab) return;
          e.preventDefault();
          closeTab(activeTab);
          return;
        case "newConn":
          e.preventDefault();
          openNewConn();
          return;
        case "settings":
          e.preventDefault();
          openSettings();
          return;
        case "newLocal":
          e.preventDefault();
          openLocal();
          return;
        case "newTab":
          e.preventDefault();
          openHome();
          return;
        case "sidebar":
          e.preventDefault();
          toggleSide();
          return;
        case "page":
          // 只在会话标签里有意义；别的标签上按了就当没按
          if (here?.kind !== "session") return;
          e.preventDefault();
          wake(here.id, hit.page, false);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 跟随系统时，系统换深浅要立刻跟上（终端配色也跟着换）
  useEffect(() => {
    if (mode !== "system") return;
    return watchSystem(() => {
      applyMode("system");
      setUiVariant(resolveMode("system"));
    });
  }, [mode]);

  const changeMode = (next: ThemeMode) => {
    persistMode(next);
    setModeState(next);
    setUiVariant(resolveMode(next));
  };

  /** 终端最终用哪版色板 */
  const termVariant = settings.termVariant === "auto" ? uiVariant : settings.termVariant;

  // 以落盘的那份为底而不是内存里的 settings：网盘拉下来、导入备份都是直接写 localStorage 的，
  // 紧接着的一次 changeSettings（比如记 syncedAt）拿闭包里的旧值展开，会把刚导入的偏好整份盖回去
  const changeSettings = (patch: Partial<AppSettings>) => setSettings(saveSettings({ ...loadSettings(), ...patch }));

  // —— 标签页 ——
  const openTab = (tab: Tab) => {
    setTabs((list) => [...list, tab]);
    setActiveTab(tab.id);
  };

  const focusTab = (tabId: string) => {
    // 点的正是分屏那一半：焦点过去、两块的位置不动（所以前后顺序标记要翻一下）
    if (tabId === splitRef.current) {
      setSplitTab(activeTab);
      splitRef.current = activeTab;
      setMainFirst((first) => !first);
    }
    setActiveTab(tabId);
  };

  // 兜底：不管哪条路把当前标签设成了分屏那一半（关标签的回退、恢复标签……），
  // 一个标签不能同时占两块，这时分屏就散
  useEffect(() => {
    if (activeTab && activeTab === splitTab) {
      splitRef.current = null;
      setSplitTab(null);
      setMainFirst(true);
    }
  }, [activeTab, splitTab]);

  /** 把某个标签摆到分屏的另一半 */
  const putInSplit = (tabId: string) => {
    if (tabId === activeTab) return;
    setSplitTab(tabId);
    splitRef.current = tabId;
    setMainFirst(true);
  };

  const endSplit = () => { setSplitTab(null); splitRef.current = null; setMainFirst(true); };

  /** 拖那条分隔线 */
  const dragSplit = (e: React.MouseEvent) => {
    const stack = (e.currentTarget as HTMLElement).parentElement;
    if (!stack) return;
    e.preventDefault();
    const box = stack.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const raw = splitDir === "row"
        ? (ev.clientX - box.left) / box.width
        : (ev.clientY - box.top) / box.height;
      // 卡在 20%~80%：再窄下去那一半就只剩边框了，还不如不分
      setSplitRatio(Math.min(0.8, Math.max(0.2, raw)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("dragging-split");
    };
    document.body.classList.add("dragging-split");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 「关闭其他」这类操作会在同一个事件里连着关好几个标签。
  // 每次都从渲染时那份快照算「剩下哪些」的话，后一次会把前一次的结果盖掉，
  // 最后只有最后关的那个真的消失（SSH 却已经全断了）—— 所以真源放 ref 里，
  // 关一个就地更新，下一次接着上一次的结果算。
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const dirtyRef = useRef(dirtyTabs);
  dirtyRef.current = dirtyTabs;

  const syncRef = useRef(syncTabs);
  syncRef.current = syncTabs;
  const splitRef = useRef(splitTab);
  splitRef.current = splitTab;

  /** 同步组里此刻真连着的标签 */
  const syncLive = useMemo(
    () => Object.keys(syncTabs).filter((id) => sessions[id]),
    [syncTabs, sessions],
  );

  const toggleSync = useCallback((tabId: string) => {
    setSyncTabs((old) => {
      const next = { ...old };
      if (next[tabId]) delete next[tabId];
      else next[tabId] = true;
      return next;
    });
  }, []);

  /** 一台里敲的东西，发给同步组里其它连着的会话 */
  const broadcast = useCallback((fromTabId: string, data: string) => {
    if (!syncRef.current[fromTabId]) return;
    for (const [tabId, on] of Object.entries(syncRef.current)) {
      if (!on || tabId === fromTabId) continue;
      const sid = sessionsRef.current[tabId];
      if (sid) invoke("ssh_write", { sessionId: sid, data }).catch(() => {});
    }
  }, []);

  /** 这个标签关掉会连带关掉哪些（会话标签带走它下面的编辑器） */
  const doomedBy = (ids: string[]) => {
    const all = new Set(ids);
    for (const tab of tabsRef.current) {
      if ((tab.kind === "file" || tab.kind === "log") && ids.includes(tab.sourceTabId)) all.add(tab.id);
    }
    return [...all];
  };

  const dropTab = useCallback((id: string) => {
    const list = tabsRef.current;
    const index = list.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    // 会话标签关掉 = 断开这条 SSH，别把连接漏在引擎里（数据库标签自己在卸载时关）
    const sessionId = sessionsRef.current[id];
    if (sessionId && list[index].kind === "session") invoke("ssh_close", { sessionId }).catch(() => {});

    // 会话没了，挂在它下面的编辑器标签也留不住
    const gone = new Set(doomedBy([id]));
    const rest = list.filter((tab) => !gone.has(tab.id));

    tabsRef.current = rest;
    // 分屏的那一半被关掉了就退回单屏，别留一个指向不存在标签的分屏
    if (splitRef.current && gone.has(splitRef.current)) {
      splitRef.current = null;
      setSplitTab(null);
    }
    // 关掉的标签要退出同步组：留着的话，下次某个新标签复用了同一个 id
    // （或者只剩一台还在组里）会让「同步 N 台」那个数字对不上实际
    if (Object.keys(syncRef.current).some((one) => gone.has(one))) {
      const nextSync = { ...syncRef.current };
      for (const dead of gone) delete nextSync[dead];
      syncRef.current = nextSync;
      setSyncTabs(nextSync);
    }
    const nextSessions = { ...sessionsRef.current };
    const nextDirty = { ...dirtyRef.current };
    for (const dead of gone) {
      delete nextSessions[dead];
      delete nextDirty[dead];
    }
    sessionsRef.current = nextSessions;
    dirtyRef.current = nextDirty;
    setWakes((map) => {
      const next = { ...map };
      for (const dead of gone) delete next[dead];
      return next;
    });
    setTabModes((map) => {
      const next = { ...map };
      for (const dead of gone) delete next[dead];
      return next;
    });

    setTabs(rest);
    setSessions(nextSessions);
    setDirtyTabs(nextDirty);
    setActiveTab((current) =>
      rest.some((tab) => tab.id === current) ? current : rest[Math.min(index, rest.length - 1)]?.id ?? null,
    );
  }, []);

  /** 关一批标签：没存的改动一次问清楚，别一个标签弹一个框（弹了也只看得见最后一个） */
  const closeTabs = useCallback((ids: string[]) => {
    const gone = doomedBy(ids);
    const unsaved = gone.filter((one) => dirtyRef.current[one]);
    const go = () => ids.forEach(dropTab);
    if (unsaved.length === 0) { go(); return; }

    const first = tabsRef.current.find((tab) => tab.id === unsaved[0]);
    setDialog({
      title:
        unsaved.length > 1
          ? `还有 ${unsaved.length} 个标签没保存`
          : first?.kind === "file"
            ? `「${first.name}」还没保存`
            : "这一页还没保存",
      message: "关了改动就没了，确定？",
      confirmText: "关掉不存",
      danger: true,
      onConfirm: go,
    });
  }, [dropTab]);

  const closeTab = useCallback((id: string) => closeTabs([id]), [closeTabs]);

  const closeTabsOf = useCallback((match: (tab: Tab) => boolean) => {
    tabsRef.current.filter(match).forEach((tab) => dropTab(tab.id));
  }, [dropTab]);

  const markDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyTabs((map) => (map[tabId] === dirty ? map : { ...map, [tabId]: dirty }));
  }, []);

  const handleSession = useCallback((tabId: string, sessionId: string | null) => {
    setSessions((map) => ({ ...map, [tabId]: sessionId }));
    if (!sessionId) {
      // 断了就退出同步组：重连之后要不要继续广播，得重新决定一遍
      setSyncTabs((map) => {
        if (!map[tabId]) return map;
        const next = { ...map };
        delete next[tabId];
        return next;
      });
      return;
    }
    // 连上了就记一笔，侧栏按最近使用排序
    setTabs((list) => {
      const tab = list.find((one) => one.id === tabId);
      if (tab?.kind === "session") {
        setConnections((conns) => {
          const conn = conns.find((one) => one.id === tab.connId);
          return conn ? saveConnection({ ...conn, lastUsedAt: Date.now() }) : conns;
        });
      }
      return list;
    });
  }, []);

  // —— 连接 ——
  const tabsOfConn = (connId: string) => tabs.filter((tab) => tab.kind === "session" && tab.connId === connId);

  const statusOf = useCallback((connId: string): ConnStatus => {
    const list = tabs.filter((tab) => tab.kind === "session" && tab.connId === connId);
    if (list.some((tab) => sessions[tab.id])) return "live";
    return list.length > 0 ? "down" : "idle";
  }, [tabs, sessions]);

  // —— 数据库连接 ——
  const dbStatusOf = useCallback((dbId: string): ConnStatus => {
    const list = tabs.filter((tab) => tab.kind === "db" && tab.dbId === dbId);
    if (list.some((tab) => sessions[tab.id])) return "live";
    return list.length > 0 ? "down" : "idle";
  }, [tabs, sessions]);

  /** 开这条库的标签：已经开着就切过去；没开就开一个，记过密码的话会自己连 */
  const openDb = (db: DbConn, mode: "console" | "config" = "console") => {
    const existing = tabs.find((tab) => tab.kind === "db" && tab.dbId === db.id);
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "db", dbId: db.id, initialMode: mode, autoConnect: mode === "console" });
  };
  const newDb = () => {
    const existing = tabs.find((tab) => tab.kind === "dbconn");
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "dbconn", dbId: null });
  };
  const saveDbConn = (db: DbConn) => setDbs(saveDb(db));
  /** 新建页存下来：这个标签就地变成那条库的标签 */
  const createDbFromTab = (tabId: string, db: DbConn, connect: boolean) => {
    setDbs(saveDb(db));
    markDirty(tabId, false);
    setTabs((list) =>
      list.map((tab) =>
        tab.id === tabId ? { id: tab.id, kind: "db", dbId: db.id, initialMode: connect ? "console" : "config", autoConnect: connect } : tab,
      ),
    );
  };
  const handleDeleteDb = (db: DbConn) => {
    setDialog({
      title: `删除数据库连接「${db.name}」`,
      message: "只删本机这条记录，库里的数据不动。钥匙串里记的密码也一起忘掉。",
      confirmText: "删",
      danger: true,
      onConfirm: () => {
        dropSecret(db.id);
        invoke("creds_forget", { connId: db.id }).catch(() => {});
        setDbs(deleteDb(db.id));
        closeTabsOf((tab) => tab.kind === "db" && tab.dbId === db.id);
      },
    });
  };

  // —— 侧栏收缩 ——
  // 收成一条图标栏后，点哪个图标就把那个抽屉当浮层弹在旁边；打开 / 切换标签、点外面、Esc 都收起。
  /** 收缩状态下弹出来的是哪个抽屉；null = 没弹 */
  const [peek, setPeek] = useState<Drawer | null>(null);
  const collapsed = settings.sideCollapsed;
  const toggleSide = () => {
    setPeek(null);
    changeSettings({ sideCollapsed: !settings.sideCollapsed });
  };
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPeek(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek]);
  // 浮层里点了连接 / 备忘 / 指令，标签一动就收起来，别挡着刚打开的东西
  useEffect(() => { setPeek(null); }, [activeTab, wakes, tabs.length]);

  const DRAWERS: { id: Drawer; label: string; title: string; icon: React.ReactNode }[] = [
    { id: "conns", label: "连接", title: "服务器和数据库", icon: <IconServer size={14} /> },
    { id: "snippets", label: "指令", title: "常用指令", icon: <IconCommand size={14} /> },
    { id: "notes", label: "备忘", title: "备忘录", icon: <IconNote size={14} /> },
  ];

  /** 每个抽屉顶上的主操作 */
  const drawerAction = (which: Drawer) =>
    which === "conns" ? (
      <button className="new-conn" type="button" onClick={openNewConn} title="加一台服务器">
        <IconPlus size={15} />新建连接
      </button>
    ) : which === "snippets" ? (
      <button
        className="new-conn"
        type="button"
        title="自己写一条"
        onClick={() => window.dispatchEvent(new CustomEvent("az-term:new-snippet"))}
      >
        <IconPlus size={15} />存条指令
      </button>
    ) : (
      <button className="new-conn" type="button" onClick={newNote} title="记一条">
        <IconPlus size={15} />新备忘
      </button>
    );

  /** 抽屉正文：展开时摆在侧栏里，收缩时摆进浮层，同一份 */
  const drawerBody = (which: Drawer) =>
    which === "conns" ? (
      <div className="drawer">
        <button
          className="kind-head act"
          type="button"
          onClick={() => openLocal()}
          title={`在本机开一个终端 · ${SHORTCUTS.newLocal}`}
        >
          <IconTerminal size={13} /> 本机终端
          <span className="kind-count">{tabs.filter((tab) => tab.kind === "local").length || "开"}</span>
        </button>

        <button
          className="kind-head"
          type="button"
          onClick={() => changeSettings({ foldServers: !settings.foldServers })}
          title={settings.foldServers ? "展开" : "折起来"}
        >
          {settings.foldServers ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
          <IconServer size={13} /> 服务器
          <span className="kind-count">{connections.length}</span>
        </button>

        {!settings.foldServers && (
          connections.length === 0 ? (
            <p className="sidebar-empty">还没有连接。第一台服务器，从这里开始。</p>
          ) : (
            <ConnectionList
              connections={connections}
              statusOf={statusOf}
              inspectingId={inspectingId}
              onInspect={openConnConfig}
              onOpen={openConn}
              onOpenAnother={openAnother}
              onOpenFiles={openConnFiles}
              onEdit={openConnEdit}
              onDelete={handleDeleteConn}
              onTogglePin={togglePin}
            />
          )
        )}

        <div className="kind-row">
          <button
            className="kind-head"
            type="button"
            onClick={() => changeSettings({ foldDb: !settings.foldDb })}
            title={settings.foldDb ? "展开" : "折起来"}
          >
            {settings.foldDb ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
            <IconDatabase size={13} /> 数据库
            <span className="kind-count">{dbs.length}</span>
          </button>
          <button className="kind-add" type="button" title="新建数据库连接" aria-label="新建数据库连接" onClick={newDb}>
            <IconPlus size={13} />
          </button>
        </div>
        {!settings.foldDb && (
          dbs.length === 0 ? (
            <p className="sidebar-empty">MySQL · PostgreSQL · Redis。点右边的加号加一条。</p>
          ) : (
            <DbList dbs={dbs} statusOf={dbStatusOf} onOpen={(db) => openDb(db)} onEdit={(db) => openDb(db, "config")} onDelete={handleDeleteDb} />
          )
        )}
      </div>
    ) : which === "snippets" ? (
      <SnippetPanel
        snippets={snippets}
        canSend={!!activeSession || !!activeLocal}
        onSave={(snippet) => setSnippets(saveSnippet(snippet))}
        onImport={importSnippets}
        onDelete={handleDeleteSnippet}
        onSend={sendCommand}
      />
    ) : (
      <NotePanel
        notes={notes}
        openNoteIds={openNoteIds}
        onOpen={openNote}
        onDelete={handleDeleteNote}
      />
    );

  /** 终端右键菜单里应用级的那几条：跟快捷键一一对应，菜单上写着键位，不用背 */
  const appMenuFor = (tabId: string): MenuEntry[] => [
    { label: "命令面板", hint: SHORTCUTS.palette, onClick: () => setPalette(true) },
    { label: "新建连接", hint: SHORTCUTS.newConn, onClick: openNewConn },
    { label: "新建本地终端", hint: SHORTCUTS.newLocal, onClick: () => openLocal() },
    { label: "关掉这个标签", hint: SHORTCUTS.closeTab, onClick: () => closeTab(tabId) },
    { label: "设置", hint: SHORTCUTS.settings, onClick: openSettings },
  ];

  const wake = (tabId: string, mode: SessionMode, connect: boolean) => {
    focusTab(tabId);
    setWakes((map) => ({ ...map, [tabId]: { seq: (map[tabId]?.seq ?? 0) + 1, mode, connect } }));
  };

  /** 单击：开这台服务器的标签、停在连接卡上，不碰网络 */
  const openConnConfig = (conn: Connection) => {
    const existing = tabsOfConn(conn.id);
    if (existing.length > 0) { focusTab(existing[existing.length - 1].id); return; }
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "term", autoConnect: false });
  };

  /** 配置：进这台的配置页，同样不碰网络 */
  const openConnEdit = (conn: Connection) => {
    const existing = tabsOfConn(conn.id);
    if (existing.length > 0) { wake(existing[existing.length - 1].id, "config", false); return; }
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "config", autoConnect: false });
  };

  /** 双击：这台已经开着就切过去顺手连上，别闷声再开一个 */
  const openConn = (conn: Connection) => {
    const existing = tabsOfConn(conn.id);
    if (existing.length > 0) { wake(existing[existing.length - 1].id, "term", true); return; }
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "term", autoConnect: true });
  };

  /**
   * 再开一个：同一台机器允许开多个标签，各自是一条独立的 SSH 会话。
   * 一个跑 top、一个干活，是天天要用的（三家竞品都支持）。
   */
  const openAnother = (conn: Connection) =>
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "term", autoConnect: true });

  /** 直接开文件面板：连上就落在 SFTP 那页，不用先经过终端 */
  const openConnFiles = (conn: Connection) => {
    const existing = tabsOfConn(conn.id);
    if (existing.length > 0) { wake(existing[existing.length - 1].id, "files", true); return; }
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "files", autoConnect: true });
  };

  /** 新建连接：单开一个标签，存下来就变成这台服务器的标签 */
  /** 本机开一个终端标签；可以开很多个 */
  const openLocal = (cwd?: string) => openTab({ id: newId(), kind: "local", cwd });

  const openNewConn = () => {
    const existing = tabs.find((tab) => tab.kind === "conn");
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "conn", connId: null });
  };

  const saveConn = (conn: Connection) => setConnections(saveConnection(conn));

  /** 新建页存下来：这个标签就地变成那台服务器的会话标签 */
  const createConnFromTab = (tabId: string, conn: Connection, connect = false) => {
    setConnections(saveConnection(conn));
    markDirty(tabId, false);
    setTabs((list) =>
      list.map((tab) =>
        tab.id === tabId
          ? {
              id: tab.id,
              kind: "session",
              connId: conn.id,
              // 「创建并连接」落在终端页；只创建的停在配置页，不碰网络
              initialMode: connect ? "term" : "config",
              autoConnect: connect,
            }
          : tab,
      ),
    );
  };

  const togglePin = (conn: Connection) => setConnections(saveConnection({ ...conn, pinned: !conn.pinned }));

  const handleDeleteConn = (conn: Connection) => {
    // 有连接拿它当跳板机的话，得先说清楚 —— 删完那几条就成直连了
    const riders = connections.filter((one) => one.jumpId === conn.id);
    // 这条连接的会话标签、挂在它底下的编辑器标签会一起关掉，没保存的得先说
    const doomed = doomedBy(tabsRef.current.filter((tab) => tab.kind === "session" && tab.connId === conn.id).map((tab) => tab.id));
    const unsaved = doomed.filter((id) => dirtyRef.current[id]).length;
    const lines = ["只删本机这条记录，服务器上什么都不动。"];
    if (riders.length) {
      lines.push(`注意：${riders.map((one) => one.name).join("、")} 拿它当跳板机，删了会改成直连 —— 要还想走跳板，回那几条里重新指一台。`);
    }
    if (unsaved > 0) lines.push(`还有 ${unsaved} 个相关标签没保存（编辑器或配置页），删了改动就没了。`);
    setDialog({
      title: `删除连接「${conn.name}」`,
      message: lines.join("\n\n"),
      confirmText: "删",
      danger: true,
      onConfirm: () => {
        dropSecret(conn.id);
        // 收藏目录和「上次待的目录」跟着这条连接走，一起清掉
        forgetScope(conn.id);
        let list = deleteConnection(conn.id);
        // 悬空的跳板机引用最危险：本该过堡垒机的连接会闷声直连，这儿明确抹掉
        for (const one of riders) list = saveConnection({ ...one, jumpId: undefined });
        setConnections(list);
        closeTabsOf((tab) => tab.kind === "session" && tab.connId === conn.id);
      },
    });
  };

  const openSettings = () => {
    const existing = tabs.find((tab) => tab.kind === "settings");
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "settings" });
  };

  /** 开始页：只留一个，已经开着就切过去 */
  const openHome = () => {
    const existing = tabsRef.current.find((tab) => tab.kind === "home");
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "home" });
  };

  // —— 指令库 ——
  // 当前标签是编辑器的话，认它所属的那条会话 —— 边改配置边想敲条命令是常事，
  // 没道理因为焦点在编辑器上就把整个指令库变灰。
  const activeSession = useMemo(() => {
    if (!activeTab) return null;
    const tab = tabs.find((one) => one.id === activeTab);
    if (!tab) return null;
    // 只认 SSH 会话：数据库标签也往 sessions 里登记（关窗提示要数它），但它的 id 不能拿去 ssh_write
    if (tab.kind === "session") return sessions[tab.id] ?? null;
    if (tab.kind === "file" || tab.kind === "log") return sessions[tab.sourceTabId] ?? null;
    return null;
  }, [activeTab, sessions, tabs]);

  /** 当前标签是本地终端且 shell 活着的话，它的 pty id */
  const activeLocal = useMemo(() => {
    if (!activeTab) return null;
    const tab = tabs.find((one) => one.id === activeTab);
    return tab?.kind === "local" ? localPtys[activeTab] ?? null : null;
  }, [activeTab, tabs, localPtys]);

  /** 指令库 / 命令面板往当前终端里塞命令：SSH 会话和本地终端都认 */
  const sendCommand = (command: string, run: boolean) => {
    if (activeSession) {
      invoke("ssh_write", { sessionId: activeSession, data: run ? `${command}\n` : command }).catch(() => {});
      window.dispatchEvent(new CustomEvent("az-term:focus", { detail: activeSession }));
      return;
    }
    if (activeLocal) {
      invoke("pty_write", { sessionId: activeLocal, data: run ? `${command}\r` : command }).catch(() => {});
      window.dispatchEvent(new CustomEvent("az-term:focus", { detail: activeLocal }));
    }
  };

  const importSnippets = (items: Snippet[]) => {
    let list = snippets;
    for (const one of items) list = saveSnippet(one);
    setSnippets(list);
  };

  const handleDeleteSnippet = (snippet: Snippet) => {
    setDialog({
      title: `删除「${snippet.title}」`,
      confirmText: "删",
      danger: true,
      onConfirm: () => setSnippets(deleteSnippet(snippet.id)),
    });
  };

  // —— 备忘录 ——
  const openNote = (note: Note) => {
    const existing = tabs.find((tab) => tab.kind === "note" && tab.noteId === note.id);
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "note", noteId: note.id });
  };

  const newNote = () => {
    const note: Note = { id: newId(), title: "", body: "", updatedAt: Date.now() };
    setNotes(saveNote(note));
    openTab({ id: newId(), kind: "note", noteId: note.id });
  };

  const handleDeleteNote = (note: Note) => {
    setDialog({
      title: `删除备忘「${note.title || "无题"}」`,
      confirmText: "删",
      danger: true,
      onConfirm: () => {
        setNotes(deleteNote(note.id));
        closeTabsOf((tab) => tab.kind === "note" && tab.noteId === note.id);
      },
    });
  };

  /** 文件面板点「编辑」→ 开编辑器标签；同一个文件只开一个 */
  const openEditor = (sourceTabId: string, side: "local" | "remote", path: string) => {
    const existing = tabs.find(
      (tab) => tab.kind === "file" && tab.path === path && tab.side === side && tab.sourceTabId === sourceTabId,
    );
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "file", side, path, name: path.split(/[\\/]/).pop() || path, sourceTabId });
  };

  /** 文件面板点「日志查看器」→ 开一个只读的大文件视图；同一个文件只开一个 */
  const openLog = (sourceTabId: string, path: string) => {
    const existing = tabs.find((tab) => tab.kind === "log" && tab.path === path && tab.sourceTabId === sourceTabId);
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "log", path, name: path.split("/").pop() || path, sourceTabId });
  };

  // —— 标签条 ——
  const tabItems: TabItem[] = useMemo(() => {
    // 同一台机器开了好几个标签时，名字后面挂个序号，不然全长一样分不清
    const seen = new Map<string, number>();
    const total = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.kind === "session") total.set(tab.connId, (total.get(tab.connId) ?? 0) + 1);
      if (tab.kind === "local") total.set("local", (total.get("local") ?? 0) + 1);
    }

    return tabs.map((tab) => {
        if (tab.kind === "session") {
          const conn = connections.find((one) => one.id === tab.connId);
          const nth = (seen.get(tab.connId) ?? 0) + 1;
          seen.set(tab.connId, nth);
          const name = conn?.name ?? "连接已删";
          return {
            id: tab.id,
            kind: "session" as const,
            label: (total.get(tab.connId) ?? 1) > 1 ? `${name} #${nth}` : name,
            color: conn?.color,
            status: sessions[tab.id] ? ("live" as const) : ("down" as const),
            dirty: !!dirtyTabs[tab.id],
          };
        }
        if (tab.kind === "local") {
          const nth = (seen.get("local") ?? 0) + 1;
          seen.set("local", nth);
          return { id: tab.id, kind: "local" as const, label: (total.get("local") ?? 1) > 1 ? `本地终端 #${nth}` : "本地终端" };
        }
        if (tab.kind === "db") {
          const db = dbs.find((one) => one.id === tab.dbId);
          return {
            id: tab.id,
            kind: "db" as const,
            label: db?.name ?? "连接已删",
            color: db?.color,
            status: sessions[tab.id] ? ("live" as const) : ("down" as const),
            dirty: !!dirtyTabs[tab.id],
          };
        }
        if (tab.kind === "dbconn") return { id: tab.id, kind: "dbconn" as const, label: "新建数据库", dirty: !!dirtyTabs[tab.id] };
        if (tab.kind === "conn") return { id: tab.id, kind: "conn" as const, label: "新建连接", dirty: !!dirtyTabs[tab.id] };
        if (tab.kind === "settings") return { id: tab.id, kind: "settings" as const, label: "设置" };
        if (tab.kind === "home") return { id: tab.id, kind: "home" as const, label: "开始" };
        if (tab.kind === "file") return { id: tab.id, kind: "file" as const, label: tab.name, dirty: !!dirtyTabs[tab.id] };
        if (tab.kind === "log") return { id: tab.id, kind: "log" as const, label: tab.name };
        const note = notes.find((one) => one.id === tab.noteId);
        return { id: tab.id, kind: "note" as const, label: note?.title || "无题" };
    });
  }, [tabs, connections, notes, dirtyTabs, sessions, dbs]);

  /** 开始页的那堆入口，空工作区和开始页标签共用 */
  const homeView = (
    <HomeView
      version={version}
      connections={connections}
      dbs={dbs}
      onNewConn={openNewConn}
      onOpenConn={openConn}
      onLocal={() => openLocal()}
      onNewDb={newDb}
      onOpenDb={(db) => openDb(db)}
      onNote={newNote}
      onPalette={() => setPalette(true)}
      onSettings={openSettings}
    />
  );
  // —— 命令面板的菜谱 ——
  // 每一项都指向一个已经存在的动作，面板本身不新增能力，只是把散在
  // 抽屉 / 页签 / 右键菜单里的入口收拢到一个搜索框里。
  const commands: Command[] = useMemo(() => {
    const list: Command[] = [];

    // 已经开着的标签：切过去比重新开一个便宜
    for (const item of tabItems) {
      if (item.id === activeTab) continue;
      list.push({
        id: `tab:${item.id}`,
        group: "打开着的标签",
        label: item.label,
        hint: item.kind === "session" ? (item.status === "live" ? "连着" : "没连") : undefined,
        run: () => focusTab(item.id),
      });
    }

    // 当前会话标签内部的几页
    const here = tabs.find((one) => one.id === activeTab);
    if (here?.kind === "session") {
      const pages: { mode: SessionMode; label: string }[] = [
        { mode: "term", label: "终端" },
        { mode: "files", label: "文件（SFTP）" },
        { mode: "stats", label: "状态：CPU / 内存 / 进程 / 端口" },
        { mode: "tunnel", label: "隧道：端口转发" },
        { mode: "config", label: "这条连接的配置" },
      ];
      for (const page of pages) {
        list.push({
          id: `page:${page.mode}`,
          group: "这个标签里",
          label: page.label,
          hint: PAGE_SHORTCUTS[page.mode],
          keywords: page.mode,
          run: () => wake(here.id, page.mode, false),
        });
      }
    }

    for (const db of dbs) {
      list.push({
        id: `db:${db.id}`,
        group: "数据库",
        label: db.name,
        hint: `${db.host}:${db.port}`,
        keywords: `${db.kind} ${db.host} ${db.group}`,
        run: () => openDb(db),
      });
    }

    for (const conn of connections) {
      list.push({
        id: `conn:${conn.id}`,
        group: "连接",
        label: conn.name,
        hint: `${conn.username}@${conn.host}`,
        keywords: `${conn.host} ${conn.username} ${conn.group}`,
        run: () => openConn(conn),
      });
    }

    // 片段插到当前终端里 —— 没有活着的会话（SSH 或本地）就别列，点了也没地方去
    if (activeSession || activeLocal) {
      for (const snip of snippets) {
        list.push({
          id: `snip:${snip.id}`,
          group: "指令片段",
          label: snip.title,
          hint: snip.command,
          keywords: `${snip.command} ${snip.tag}`,
          run: () => sendCommand(snip.command, false),
        });
      }
    }

    for (const note of notes) {
      list.push({
        id: `note:${note.id}`,
        group: "备忘",
        label: note.title || "无题",
        keywords: note.body.slice(0, 200),
        run: () => openNote(note),
      });
    }

    list.push(
      { id: "act:new", group: "动作", label: "新建连接", hint: SHORTCUTS.newConn, run: openNewConn },
      { id: "act:local", group: "动作", label: "新建本地终端", hint: SHORTCUTS.newLocal, run: () => openLocal() },
      { id: "act:newdb", group: "动作", label: "新建数据库连接", run: newDb },
      { id: "act:home", group: "动作", label: "开始页", hint: SHORTCUTS.newTab, run: openHome },
      { id: "act:note", group: "动作", label: "新建备忘", run: newNote },
      { id: "act:settings", group: "动作", label: "设置", hint: SHORTCUTS.settings, run: openSettings },
      { id: "act:side", group: "动作", label: settings.sideCollapsed ? "展开侧栏" : "收起侧栏", hint: SHORTCUTS.sidebar, run: toggleSide },
      {
        id: "act:theme",
        group: "动作",
        label: mode === "dark" ? "换成浅色" : "换成深色",
        keywords: "theme 主题 深色 浅色",
        run: () => changeMode(mode === "dark" ? "light" : "dark"),
      },
    );
    if (activeTab) {
      list.push({ id: "act:close", group: "动作", label: "关掉当前标签", hint: SHORTCUTS.closeTab, run: () => closeTab(activeTab) });
    }
    return list;
  }, [tabItems, tabs, activeTab, connections, snippets, notes, activeSession, mode, activeLocal, dbs]);

  const inspectingId = useMemo(() => {
    const tab = tabs.find((one) => one.id === activeTab);
    return tab?.kind === "session" ? tab.connId : null;
  }, [tabs, activeTab]);

  const openNoteIds = tabs.filter((tab) => tab.kind === "note").map((tab) => (tab as { noteId: string }).noteId);

  /** 此刻真连着的会话数：设置页要拿它提醒「重启会断」 */
  const liveCount = Object.values(sessions).filter(Boolean).length;

  return (
    <div className={`shell ${collapsed ? "collapsed" : ""}`}>
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        {collapsed ? (
          <>
            {/* 图标栏：新建、三个抽屉、设置、展开 */}
            <div className="sidebar-top">
              <button className="new-conn rail-btn" type="button" onClick={openNewConn} aria-label="新建连接" title={`新建连接 · ${SHORTCUTS.newConn}`}>
                <IconPlus size={16} />
              </button>
            </div>
            <div className="drawer-switch" role="tablist">
              {DRAWERS.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  role="tab"
                  aria-selected={peek === one.id}
                  aria-label={one.label}
                  title={one.title}
                  className={peek === one.id ? "on" : ""}
                  onClick={() => setPeek((now) => (now === one.id ? null : one.id))}
                >
                  {one.icon}
                </button>
              ))}
            </div>
            <div className="sidebar-section" />
            <footer className="sidebar-foot">
              <span className="engine-dot" data-ok={engineStatus.includes("ok")} title={engineStatus} />
              {fresh && (
                <button className="foot-btn foot-new-mini" type="button" onClick={openSettings} title={`${fresh.version} 可以更新了`}>
                  <span className="foot-new-dot" />
                </button>
              )}
              <button className="foot-btn" type="button" onClick={openSettings} aria-label="设置" title={`设置 · ${SHORTCUTS.settings}`}>
                <IconSettings />
              </button>
              <button className="foot-btn" type="button" onClick={toggleSide} aria-label="展开侧栏" title={`展开侧栏 · ${SHORTCUTS.sidebar}`}>
                <IconChevronRight />
              </button>
            </footer>
          </>
        ) : (
          <>
            {/* 主操作钉在最上面，跟着当前抽屉变 */}
            <div className="sidebar-top">{drawerAction(drawer)}</div>

            <div className="drawer-switch" role="tablist">
              {DRAWERS.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  role="tab"
                  aria-selected={drawer === one.id}
                  title={one.title}
                  className={drawer === one.id ? "on" : ""}
                  onClick={() => setDrawer(one.id)}
                >
                  {one.icon}{one.label}
                </button>
              ))}
            </div>

            <div className="sidebar-section">{drawerBody(drawer)}</div>

        <footer className="sidebar-foot">
          {/* 有新版就在这儿挂一条，不弹窗打断 —— 点了才去设置里更新 */}
          {fresh ? (
            <button
              className="foot-new"
              type="button"
              onClick={openSettings}
              title={`${fresh.version} 可以更新了${fresh.notes ? `\n\n${fresh.notes}` : ""}`}
            >
              <span className="foot-new-dot" />
              有新版 {fresh.version}
            </button>
          ) : (
            <>
              <span className="engine-dot" data-ok={engineStatus.includes("ok")} />
              <span title={engineStatus}>{engineStatus.includes("ok") ? "引擎在线" : engineStatus}</span>
            </>
          )}
          <span className="foot-spacer" />
          <button className="foot-btn" type="button" onClick={openSettings} aria-label="设置" title={`设置 · ${SHORTCUTS.settings}`}>
            <IconSettings />
          </button>
          <button className="foot-btn" type="button" onClick={toggleSide} aria-label="收起侧栏" title={`收起侧栏 · ${SHORTCUTS.sidebar}`}>
            <IconArrowLeft />
          </button>
        </footer>
          </>
        )}
      </aside>

      {/* 收缩态的浮层：内容和展开时那一栏是同一份 */}
      {collapsed && peek && (
        <>
          <div className="side-pop-backdrop" onMouseDown={() => setPeek(null)} />
          <div className="side-pop" role="dialog" aria-label={DRAWERS.find((one) => one.id === peek)?.title}>
            <div className="side-pop-head">
              <b>{DRAWERS.find((one) => one.id === peek)?.title}</b>
              {drawerAction(peek)}
              <button className="icon-btn sm" type="button" onClick={() => setPeek(null)} aria-label="收起"><IconX size={14} /></button>
            </div>
            <div className="side-pop-body">{drawerBody(peek)}</div>
          </div>
        </>
      )}

      <main className="workspace">
        <TabBar
          items={tabItems}
          activeId={activeTab}
          onSelect={focusTab}
          onClose={closeTab}
          onCloseMany={closeTabs}
          splitId={splitTab}
          splitDir={splitDir}
          onSplit={putInSplit}
          onEndSplit={endSplit}
          onFlipDir={() => setSplitDir((one) => (one === "row" ? "col" : "row"))}
          onBlank={openHome}
        />

        <div className={`tab-stack ${splitTab ? `split ${splitDir}` : ""}`}>
          {tabs.map((tab) => {
            const focused = tab.id === activeTab;
            const inSplit = tab.id === splitTab;
            // 分屏时两块都在屏幕上，但「焦点」只有一个：
            // 拖拽上传和 Del / F2 这类快捷键得认焦点，两块都接就不知道该落到谁头上了
            const on = focused || inSplit;
            // 位置只看 mainFirst，焦点只看 focused：点另一半拿焦点时两块不换位
            const first = focused ? mainFirst : !mainFirst;
            const pane = (content: React.ReactNode) => (
              <div
                className={`tab-pane ${on && splitTab ? (focused ? "half focus" : "half") : ""}`}
                key={tab.id}
                style={{
                  display: on ? "flex" : "none",
                  ...(on && splitTab
                    ? { order: first ? 1 : 3, flex: `0 0 ${(first ? splitRatio : 1 - splitRatio) * 100}%` }
                    : {}),
                }}
                // 点哪半哪半得焦点，跟窗口管理器一个手感
                onMouseDownCapture={() => { if (inSplit) focusTab(tab.id); }}
              >
                {content}
              </div>
            );

            if (tab.kind === "session") {
              const conn = connections.find((one) => one.id === tab.connId);
              if (!conn) return null;
              return pane(
                <SessionView
                  conn={conn}
                  active={focused}
                  visible={on}
                  idleMinutes={settings.idleMinutes}
                  termScheme={settings.termScheme}
                  termVariant={termVariant}
                  termFontSize={settings.termFontSize}
                  termDivider={settings.termDivider}
                  hostPolicy={settings.hostPolicy}
                  xferLanes={settings.xferLanes}
                  autoReconnect={settings.autoReconnect}
                  initialMode={tab.initialMode}
                  autoConnect={tab.autoConnect}
                  wake={wakes[tab.id]}
                  onMode={(next) => setTabModes((map) => (map[tab.id] === next ? map : { ...map, [tab.id]: next }))}
                  jump={conn.jumpId ? connections.find((one) => one.id === conn.jumpId) ?? null : null}
                  onSession={(sessionId) => handleSession(tab.id, sessionId)}
                  onEditFile={(side, path) => openEditor(tab.id, side, path)}
                  onOpenLog={(path) => openLog(tab.id, path)}
                  inSync={!!syncTabs[tab.id]}
                  syncCount={syncLive.length}
                  onToggleSync={() => toggleSync(tab.id)}
                  onBroadcast={(data) => broadcast(tab.id, data)}
                  onSaveConn={saveConn}
                  onDeleteConn={handleDeleteConn}
                  onConfigDirty={(dirty) => markDirty(tab.id, dirty)}
                  appMenu={appMenuFor(tab.id)}
                />,
              );
            }

            if (tab.kind === "local") {
              return pane(
                <LocalView
                  tabId={tab.id}
                  initialCwd={tab.cwd}
                  shell={settings.localShell}
                  active={focused}
                  termScheme={settings.termScheme}
                  termVariant={termVariant}
                  termFontSize={settings.termFontSize}
                  termDivider={settings.termDivider}
                  onCwd={(cwd) => setLocalCwd((map) => (map[tab.id] === cwd ? map : { ...map, [tab.id]: cwd }))}
                  onLive={(ptyId) => setLocalPtys((map) => (map[tab.id] === ptyId ? map : { ...map, [tab.id]: ptyId }))}
                  appMenu={appMenuFor(tab.id)}
                />,
              );
            }

            if (tab.kind === "db") {
              const db = dbs.find((one) => one.id === tab.dbId);
              if (!db) return null;
              return pane(
                <DbView
                  db={db}
                  active={focused}
                  initialMode={tab.initialMode}
                  autoConnect={tab.autoConnect}
                  onSession={(sessionId) => handleSession(tab.id, sessionId)}
                  onSaveDb={saveDbConn}
                  onDeleteDb={handleDeleteDb}
                  onConfigDirty={(dirty) => markDirty(tab.id, dirty)}
                  appMenu={appMenuFor(tab.id)}
                />,
              );
            }

            if (tab.kind === "dbconn") {
              return pane(
                <DbPage
                  db={null}
                  onSave={(next, connect) => createDbFromTab(tab.id, next, connect)}
                  onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                  onClose={() => closeTab(tab.id)}
                />,
              );
            }

            if (tab.kind === "conn") {
              return pane(
                <ConnectionPage
                  conn={null}
                  status="idle"
                  onSave={(next, connect) => createConnFromTab(tab.id, next, connect)}
                  onDelete={handleDeleteConn}
                  onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                  onClose={() => closeTab(tab.id)}
                />,
              );
            }

            if (tab.kind === "home") return pane(homeView);

            if (tab.kind === "settings") {
              return pane(
                <Settings
                  mode={mode}
                  onModeChange={changeMode}
                  idleMinutes={settings.idleMinutes}
                  onIdleChange={(idleMinutes) => changeSettings({ idleMinutes })}
                  termScheme={settings.termScheme}
                  termFontSize={settings.termFontSize}
                  termVariant={settings.termVariant}
                  termDivider={settings.termDivider}
                  previewVariant={termVariant}
                  onTermChange={changeSettings}
                  hostPolicy={settings.hostPolicy}
                  onHostPolicyChange={(hostPolicy) => changeSettings({ hostPolicy })}
                  xferLanes={settings.xferLanes}
                  onLanesChange={(xferLanes) => changeSettings({ xferLanes })}
                  autoReconnect={settings.autoReconnect}
                  onReconnectChange={(autoReconnect) => changeSettings({ autoReconnect })}
                  restoreTabs={settings.restoreTabs}
                  onRestoreChange={(restoreTabs) => changeSettings({ restoreTabs })}
                  updateNotice={settings.updateNotice}
                  onUpdateNoticeChange={(updateNotice) => changeSettings({ updateNotice })}
                  localShell={settings.localShell}
                  onLocalShellChange={(localShell) => changeSettings({ localShell })}
                  hotkey={settings.hotkey}
                  hotkeyErr={hotkeyErr}
                  onHotkeyChange={(hotkey) => changeSettings({ hotkey })}
                  syncUrl={settings.syncUrl}
                  syncUser={settings.syncUser}
                  syncedAt={settings.syncedAt}
                  onSyncChange={(next) => changeSettings(next)}
                  fresh={fresh}
                  liveSessions={liveCount}
                  onDataChanged={reloadAll}
                  onClose={() => closeTab(tab.id)}
                  version={version}
                />,
              );
            }

            if (tab.kind === "file") {
              // 远程文件跟着那条连接的编码走：GBK 的机器上开出来的配置文件就该按 GBK 读
              const owner = tabs.find((one) => one.id === tab.sourceTabId);
              const ownerConn =
                owner?.kind === "session" ? connections.find((one) => one.id === owner.connId) : undefined;
              return pane(
                <FileEditor
                  side={tab.side}
                  path={tab.path}
                  sessionId={tab.side === "remote" ? sessions[tab.sourceTabId] ?? null : null}
                  defaultEncoding={tab.side === "remote" ? ownerConn?.encoding : undefined}
                  onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                  onClose={() => closeTab(tab.id)}
                />,
              );
            }

            if (tab.kind === "log") {
              // 日志跟着那条连接的编码走：GBK 的机器上打出来的日志就该按 GBK 解
              const owner = tabs.find((one) => one.id === tab.sourceTabId);
              const ownerConn =
                owner?.kind === "session" ? connections.find((one) => one.id === owner.connId) : undefined;
              return pane(
                <LogView
                  path={tab.path}
                  sessionId={sessions[tab.sourceTabId] ?? null}
                  defaultEncoding={ownerConn?.encoding}
                  onClose={() => closeTab(tab.id)}
                />,
              );
            }

            const note = notes.find((one) => one.id === tab.noteId);
            if (!note) return null;
            return pane(
              <NoteView key={note.id} note={note} onChange={(next) => setNotes(saveNote(next))} onDelete={handleDeleteNote} />,
            );
          })}

          {splitTab && (
            <div
              className="split-grip"
              style={{ order: 2 }}
              role="separator"
              aria-label="拖动调整两半的宽度"
              onMouseDown={dragSplit}
              onDoubleClick={() => setSplitRatio(0.5)}
              title="拖着调宽窄，双击回到一半一半"
            />
          )}

          {tabs.length === 0 && homeView}
        </div>
      </main>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {dialog && <Dialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

export default App;
