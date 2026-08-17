import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Logo } from "./components/Logo";
import {
  IconChevronDown,
  IconChevronRight,
  IconCommand,
  IconDatabase,
  IconNote,
  IconPlus,
  IconServer,
  IconSettings,
} from "./components/icons";
import { ConnectionList, type ConnStatus } from "./components/ConnectionList";
import { SnippetPanel } from "./components/SnippetPanel";
import { NotePanel } from "./components/NotePanel";
import { TabBar, type TabItem } from "./components/TabBar";
import { Dialog, type DialogSpec } from "./components/Dialog";
import { Settings } from "./views/Settings";
import { ConnectionPage } from "./views/ConnectionPage";
import { SessionView } from "./views/SessionView";
import { NoteView } from "./views/NoteView";
import { FileEditor } from "./views/FileEditor";
import { applyMode, initMode, resolveMode, setMode as persistMode, watchSystem, type ThemeMode } from "./theme";
import {
  deleteConnection,
  deleteNote,
  deleteSnippet,
  loadConnections,
  loadNotes,
  loadOpenTabs,
  loadSettings,
  loadSnippets,
  newId,
  saveOpenTabs,
  saveConnection,
  saveNote,
  saveSettings,
  saveSnippet,
  type AppSettings,
  type SavedTab,
} from "./store";
import { checkRelease, type Release } from "./update";
import type { Connection, Note, SessionMode, Snippet, Tab } from "./types";

type Drawer = "conns" | "snippets" | "notes";

/**
 * Az-term 外壳：
 * 左边三个抽屉（连接 / 指令 / 备忘），右边多标签工作区。
 * 一台服务器一个标签，终端 / 文件 / 配置都在标签里面切，不拿浮层盖窗口。
 * 会话标签全程挂载不卸载，切走的终端还活着，回来接着敲。
 */
function App() {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [engineStatus, setEngineStatus] = useState<string>("检测中……");
  const [drawer, setDrawer] = useState<Drawer>("conns");

  const [connections, setConnections] = useState<Connection[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  /** tabId -> 活着的 SSH 会话 id（没连上就是 null） */
  const [sessions, setSessions] = useState<Record<string, string | null>>({});
  /** 标签有没有没保存的改动（编辑器、连接配置） */
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});

  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
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
  });
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
  useEffect(() => {
    if (!settings.updateNotice) { setFresh(null); return; }
    const timer = setTimeout(() => { void checkRelease(version).then(setFresh); }, 4000);
    return () => clearTimeout(timer);
  }, [settings.updateNotice, version]);

  // 标签变了就记一笔，下次开应用照着摆回来
  const restoring = useRef(true);
  useEffect(() => {
    // 首屏那次是「恢复」本身，别拿空列表把记录冲了
    if (restoring.current) { restoring.current = false; return; }
    saveOpenTabs(
      tabs.flatMap<SavedTab>((tab) => {
        if (tab.kind === "session") return [{ kind: "session", connId: tab.connId }];
        if (tab.kind === "note") return [{ kind: "note", noteId: tab.noteId }];
        if (tab.kind === "settings") return [{ kind: "settings" }];
        return [];
      }),
    );
  }, [tabs]);

  // 屏蔽 webview 自带的右键菜单（重新加载 / 查看源代码），一律用我们自己的
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  // —— 标签快捷键 ——
  // 全部带 Ctrl，且都是终端里没有的组合（Tab / 数字 / W / T），不跟 shell 抢键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const list = tabsRef.current;

      // Ctrl+Tab / Ctrl+Shift+Tab：在标签之间轮着走
      if (e.key === "Tab" && list.length > 1) {
        e.preventDefault();
        const at = list.findIndex((tab) => tab.id === activeTab);
        const step = e.shiftKey ? -1 : 1;
        const next = (at + step + list.length) % list.length;
        setActiveTab(list[next].id);
        return;
      }
      // Ctrl+W：关当前标签（没保存的照样会问一句）
      if (e.key.toLowerCase() === "w" && !e.shiftKey && activeTab) {
        e.preventDefault();
        closeTab(activeTab);
        return;
      }
      // Ctrl+T：新建连接
      if (e.key.toLowerCase() === "t" && !e.shiftKey) {
        e.preventDefault();
        openNewConn();
        return;
      }
      // Ctrl+1..9：跳到第几个标签，9 是最后一个（跟浏览器一个规矩）
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const nth = Number(e.key);
        const target = nth === 9 ? list[list.length - 1] : list[nth - 1];
        if (target) {
          e.preventDefault();
          setActiveTab(target.id);
        }
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

  const changeSettings = (patch: Partial<AppSettings>) => setSettings(saveSettings({ ...settings, ...patch }));

  // —— 标签页 ——
  const openTab = (tab: Tab) => {
    setTabs((list) => [...list, tab]);
    setActiveTab(tab.id);
  };

  const focusTab = (tabId: string) => setActiveTab(tabId);

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

  /** 这个标签关掉会连带关掉哪些（会话标签带走它下面的编辑器） */
  const doomedBy = (ids: string[]) => {
    const all = new Set(ids);
    for (const tab of tabsRef.current) {
      if (tab.kind === "file" && ids.includes(tab.sourceTabId)) all.add(tab.id);
    }
    return [...all];
  };

  const dropTab = useCallback((id: string) => {
    // 会话标签关掉 = 断开这条 SSH，别把连接漏在引擎里
    const sessionId = sessionsRef.current[id];
    if (sessionId) invoke("ssh_close", { sessionId }).catch(() => {});

    const list = tabsRef.current;
    const index = list.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    // 会话没了，挂在它下面的编辑器标签也留不住
    const gone = new Set(doomedBy([id]));
    const rest = list.filter((tab) => !gone.has(tab.id));

    tabsRef.current = rest;
    const nextSessions = { ...sessionsRef.current };
    const nextDirty = { ...dirtyRef.current };
    for (const dead of gone) {
      delete nextSessions[dead];
      delete nextDirty[dead];
    }
    sessionsRef.current = nextSessions;
    dirtyRef.current = nextDirty;

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
    // 连上了就记一笔，侧栏按最近使用排序
    if (!sessionId) return;
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

  /** 单击：开这台服务器的标签、停在配置页，不碰网络 */
  const openConnConfig = (conn: Connection) => {
    const existing = tabsOfConn(conn.id);
    if (existing.length > 0) { focusTab(existing[existing.length - 1].id); return; }
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "config", autoConnect: false });
  };

  /** 双击：这台已经开着就切过去，别闷声再开一个 */
  const openConn = (conn: Connection) => {
    const existing = tabsOfConn(conn.id);
    if (existing.length > 0) { focusTab(existing[existing.length - 1].id); return; }
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
    if (existing.length > 0) { focusTab(existing[existing.length - 1].id); return; }
    openTab({ id: newId(), kind: "session", connId: conn.id, initialMode: "files", autoConnect: true });
  };

  /** 新建连接：单开一个标签，存下来就变成这台服务器的标签 */
  const openNewConn = () => {
    const existing = tabs.find((tab) => tab.kind === "conn");
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "conn", connId: null });
  };

  const saveConn = (conn: Connection) => setConnections(saveConnection(conn));

  const createConnFromTab = (tabId: string, conn: Connection) => {
    setConnections(saveConnection(conn));
    markDirty(tabId, false);
    setTabs((list) =>
      list.map((tab) =>
        tab.id === tabId
          ? { id: tab.id, kind: "session", connId: conn.id, initialMode: "config", autoConnect: false }
          : tab,
      ),
    );
  };

  const togglePin = (conn: Connection) => setConnections(saveConnection({ ...conn, pinned: !conn.pinned }));

  const handleDeleteConn = (conn: Connection) => {
    setDialog({
      title: `删除连接「${conn.name}」`,
      message: "只删本机这条记录，服务器上什么都不动。",
      confirmText: "删",
      danger: true,
      onConfirm: () => {
        setConnections(deleteConnection(conn.id));
        closeTabsOf((tab) => tab.kind === "session" && tab.connId === conn.id);
      },
    });
  };

  const openSettings = () => {
    const existing = tabs.find((tab) => tab.kind === "settings");
    if (existing) { focusTab(existing.id); return; }
    openTab({ id: newId(), kind: "settings" });
  };

  // —— 指令库 ——
  // 当前标签是编辑器的话，认它所属的那条会话 —— 边改配置边想敲条命令是常事，
  // 没道理因为焦点在编辑器上就把整个指令库变灰。
  const activeSession = useMemo(() => {
    if (!activeTab) return null;
    const direct = sessions[activeTab];
    if (direct) return direct;
    const tab = tabs.find((one) => one.id === activeTab);
    if (tab?.kind === "file") return sessions[tab.sourceTabId] ?? null;
    return null;
  }, [activeTab, sessions, tabs]);

  const sendCommand = (command: string, run: boolean) => {
    if (!activeSession) return;
    invoke("ssh_write", { sessionId: activeSession, data: run ? `${command}\n` : command }).catch(() => {});
    window.dispatchEvent(new CustomEvent("az-term:focus", { detail: activeSession }));
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

  // —— 标签条 ——
  const tabItems: TabItem[] = useMemo(() => {
    // 同一台机器开了好几个标签时，名字后面挂个序号，不然全长一样分不清
    const seen = new Map<string, number>();
    const total = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.kind === "session") total.set(tab.connId, (total.get(tab.connId) ?? 0) + 1);
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
        if (tab.kind === "conn") return { id: tab.id, kind: "conn" as const, label: "新建连接", dirty: !!dirtyTabs[tab.id] };
        if (tab.kind === "settings") return { id: tab.id, kind: "settings" as const, label: "设置" };
        if (tab.kind === "file") return { id: tab.id, kind: "file" as const, label: tab.name, dirty: !!dirtyTabs[tab.id] };
        const note = notes.find((one) => one.id === tab.noteId);
        return { id: tab.id, kind: "note" as const, label: note?.title || "无题" };
    });
  }, [tabs, connections, notes, dirtyTabs, sessions]);

  const inspectingId = useMemo(() => {
    const tab = tabs.find((one) => one.id === activeTab);
    return tab?.kind === "session" ? tab.connId : null;
  }, [tabs, activeTab]);

  const openNoteIds = tabs.filter((tab) => tab.kind === "note").map((tab) => (tab as { noteId: string }).noteId);

  return (
    <div className="shell">
      <aside className="sidebar">
        {/* 主操作钉在最上面，跟着当前抽屉变 */}
        <div className="sidebar-top">
          {drawer === "conns" && (
            <button className="new-conn" type="button" onClick={openNewConn} title="加一台服务器">
              <IconPlus size={15} />新建连接
            </button>
          )}
          {drawer === "snippets" && (
            <button
              className="new-conn"
              type="button"
              title="自己写一条"
              onClick={() => window.dispatchEvent(new CustomEvent("az-term:new-snippet"))}
            >
              <IconPlus size={15} />存条指令
            </button>
          )}
          {drawer === "notes" && (
            <button className="new-conn" type="button" onClick={newNote} title="记一条">
              <IconPlus size={15} />新备忘
            </button>
          )}
        </div>

        <div className="drawer-switch" role="tablist">
          <button type="button" role="tab" aria-selected={drawer === "conns"} title="服务器和数据库"
            className={drawer === "conns" ? "on" : ""} onClick={() => setDrawer("conns")}>
            <IconServer size={14} />连接
          </button>
          <button type="button" role="tab" aria-selected={drawer === "snippets"} title="常用指令"
            className={drawer === "snippets" ? "on" : ""} onClick={() => setDrawer("snippets")}>
            <IconCommand size={14} />指令
          </button>
          <button type="button" role="tab" aria-selected={drawer === "notes"} title="备忘录"
            className={drawer === "notes" ? "on" : ""} onClick={() => setDrawer("notes")}>
            <IconNote size={14} />备忘
          </button>
        </div>

        <div className="sidebar-section">
          {drawer === "conns" && (
            <div className="drawer">
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
                    onEdit={openConnConfig}
                    onDelete={handleDeleteConn}
                    onTogglePin={togglePin}
                  />
                )
              )}

              {/* 数据库、Redis、API 以后落在这一栏，先把位置留出来 */}
              <button
                className="kind-head soon"
                type="button"
                onClick={() => changeSettings({ foldDb: !settings.foldDb })}
                title={settings.foldDb ? "展开" : "折起来"}
              >
                {settings.foldDb ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                <IconDatabase size={13} /> 数据库
                <span className="kind-count">排队中</span>
              </button>
              {!settings.foldDb && <p className="sidebar-empty">MySQL · Redis · API 调试，还没轮到。</p>}
            </div>
          )}

          {drawer === "snippets" && (
            <SnippetPanel
              snippets={snippets}
              canSend={!!activeSession}
              onSave={(snippet) => setSnippets(saveSnippet(snippet))}
              onImport={importSnippets}
              onDelete={handleDeleteSnippet}
              onSend={sendCommand}
            />
          )}

          {drawer === "notes" && (
            <NotePanel
              notes={notes}
              openNoteIds={openNoteIds}
              onOpen={openNote}
              onDelete={handleDeleteNote}
            />
          )}
        </div>

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
          <button className="foot-btn" type="button" onClick={openSettings} aria-label="设置" title="设置">
            <IconSettings />
          </button>
        </footer>
      </aside>

      <main className="workspace">
        <TabBar items={tabItems} activeId={activeTab} onSelect={focusTab} onClose={closeTab} onCloseMany={closeTabs} />

        <div className="tab-stack">
          {tabs.map((tab) => {
            const on = tab.id === activeTab;
            const pane = (content: React.ReactNode) => (
              <div className="tab-pane" key={tab.id} style={{ display: on ? "flex" : "none" }}>{content}</div>
            );

            if (tab.kind === "session") {
              const conn = connections.find((one) => one.id === tab.connId);
              if (!conn) return null;
              return pane(
                <SessionView
                  conn={conn}
                  active={on}
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
                  jump={conn.jumpId ? connections.find((one) => one.id === conn.jumpId) ?? null : null}
                  onSession={(sessionId) => handleSession(tab.id, sessionId)}
                  onEditFile={(side, path) => openEditor(tab.id, side, path)}
                  onSaveConn={saveConn}
                  onDeleteConn={handleDeleteConn}
                  onConfigDirty={(dirty) => markDirty(tab.id, dirty)}
                />,
              );
            }

            if (tab.kind === "conn") {
              return pane(
                <ConnectionPage
                  conn={null}
                  status="idle"
                  onSave={(next) => createConnFromTab(tab.id, next)}
                  onDelete={handleDeleteConn}
                  onDirtyChange={(dirty) => markDirty(tab.id, dirty)}
                  onClose={() => closeTab(tab.id)}
                />,
              );
            }

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
                  fresh={fresh}
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

            const note = notes.find((one) => one.id === tab.noteId);
            if (!note) return null;
            return pane(
              <NoteView key={note.id} note={note} onChange={(next) => setNotes(saveNote(next))} onDelete={handleDeleteNote} />,
            );
          })}

          {tabs.length === 0 && (
            <div className="welcome">
              <span className="welcome-mark"><Logo size={56} /></span>
              <h1>Azi<span>-Terminal</span></h1>
              <p>SSH · SFTP · 指令库 · 备忘录，免费无账号不过期。</p>
              <p className="dim">v{version} —— 左边单击看配置，双击直接连。</p>
            </div>
          )}
        </div>
      </main>

      {dialog && <Dialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

export default App;
