import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "../components/Terminal";
import type { MenuEntry } from "../components/ContextMenu";
import { IconPulse, IconTerminal } from "../components/icons";
import { GitPanel, type GitInfo, type ShellFamily } from "../components/GitPanel";
import { copyText } from "../clipboard";

interface PtyInfo { shell: string; cwd: string; tracksCwd: boolean }

type Phase =
  | { kind: "starting" }
  | { kind: "open" }
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string };

interface LocalViewProps {
  tabId: string;
  /** 起在哪个目录；空就是用户主目录 */
  initialCwd?: string;
  /** 设置里指定的 shell；空 = 自动 */
  shell: string;
  active: boolean;
  termScheme: string;
  termVariant: "dark" | "light";
  termFontSize: number;
  termDivider: boolean;
  /** 目录变了告诉上层（下次开应用恢复标签时从这儿起） */
  onCwd: (cwd: string) => void;
  /** shell 活着就报它的 id，退了报 null —— 指令库要往当前终端里塞命令 */
  onLive: (ptyId: string | null) => void;
  appMenu?: MenuEntry[];
}

const errText = (e: unknown): string =>
  e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);

/** 终端顶上那排通用命令。ls / cd .. / clear 在 PowerShell 和 bash 里都能用 */
const QUICK: { label: string; cmd: string }[] = [
  { label: "ls", cmd: "ls" },
  { label: "cd ..", cmd: "cd .." },
  { label: "清屏", cmd: "clear" },
];

/** OSC 7 是 file://host/path；OSC 9 是 9;<path>（Windows Terminal 的写法） */
function cwdFromOsc(code: 7 | 9, data: string): string | null {
  if (code === 9) {
    const m = /^9;(.+)$/.exec(data);
    return m ? m[1] : null;
  }
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return null;
  let path = m[1];
  try { path = decodeURIComponent(path); } catch { /* 原样用 */ }
  // /C:/Users/x 这种 Windows 写法把开头的斜杠去掉
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, "\\");
  return path;
}

/**
 * 本地终端标签：本机起一个 shell，旁边挂一块 git 面板。
 * shell 每次出提示符前上报目录，面板据此知道现在在哪个仓库里。
 */
export function LocalView({
  tabId, initialCwd, shell, termScheme, termVariant, termFontSize, termDivider, onCwd, onLive, appMenu,
}: LocalViewProps) {
  /**
   * 这一次起的 shell 的 id。每次挂载都生成新的，而不是按标签固定：
   * 开发模式下 React 会挂载→卸载→再挂载，两次 pty_open 用同一个 id 会互相踩
   * （后一次开的 shell 被前一次的清理杀掉，前端看到的就是「刚开就退出」）。
   */
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [info, setInfo] = useState<PtyInfo | null>(null);
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [typedCwd, setTypedCwd] = useState<string | null>(null);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitErr, setGitErr] = useState<string | null>(null);
  const [gitOpen, setGitOpen] = useState(true);
  /** 重启 shell 的计数：变一下就重新走一遍挂载 */
  const [run, setRun] = useState(0);
  const live = useRef(true);
  const tellCwd = useRef(onCwd);
  tellCwd.current = onCwd;
  const tellLive = useRef(onLive);
  tellLive.current = onLive;

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // 起 shell；卸载或重启时杀掉
  useEffect(() => {
    let dead = false;
    let un: UnlistenFn | undefined;
    const id = `pty-${tabId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setPhase({ kind: "starting" });
    setPtyId(null);
    listen<number | null>(`pty://exit/${id}`, (event) => {
      if (dead) return;
      setPhase({ kind: "exited", code: event.payload });
      tellLive.current(null);
    }).then((fn) => {
      if (dead) fn();
      else un = fn;
    });
    invoke<PtyInfo>("pty_open", { sessionId: id, shell: shell || null, cwd: initialCwd || null, cols: 120, rows: 30 })
      .then((got) => {
        if (dead) { invoke("pty_close", { sessionId: id }).catch(() => {}); return; }
        setInfo(got);
        setCwd(got.cwd);
        setPtyId(id);
        setPhase({ kind: "open" });
        tellLive.current(id);
      })
      .catch((e) => { if (!dead) setPhase({ kind: "error", message: errText(e) }); });
    return () => {
      dead = true;
      un?.();
      invoke("pty_close", { sessionId: id }).catch(() => {});
      tellLive.current(null);
    };
    // shell 换了要重启才生效，所以故意不依赖它；initialCwd 只在第一次起的时候用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, run]);

  // 目录变了 → 上报 + 刷 git。
  // 每次问都带个序号，回来时不是最新那一次就丢掉：cd 得快的时候（或者刚起 shell 时
  // 初始目录和 shell 报回来的目录一前一后），先发的那次后回来会把新目录的结果盖掉，
  // 面板就停在上一个仓库上不动了。
  const gitSeq = useRef(0);
  const refreshGit = useCallback((dir: string) => {
    const mine = (gitSeq.current += 1);
    const fresh = () => live.current && gitSeq.current === mine;
    if (!dir) { setGit(null); setGitErr(null); return; }
    invoke<GitInfo | null>("git_info", { cwd: dir })
      .then((got) => { if (fresh()) { setGit(got); setGitErr(null); } })
      .catch((e) => { if (fresh()) { setGit(null); setGitErr(errText(e)); } });
  }, []);
  useEffect(() => {
    if (!cwd) return;
    tellCwd.current(cwd);
    refreshGit(cwd);
  }, [cwd, refreshGit]);

  // 终端里敲了回车：一秒多以后再刷一次面板（命令可能改了仓库状态）。
  // 目录从 ref 里取：回车时的 cwd 到计时器触发时可能已经被 cd 换掉了（闭包里的是旧值，
  // 拿旧目录去刷会把刚识别出来的仓库又冲成「不是仓库」）
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const bump = useRef<number | null>(null);
  const onInput = (data: string) => {
    if (!data.includes("\r")) return;
    if (bump.current !== null) window.clearTimeout(bump.current);
    bump.current = window.setTimeout(() => { bump.current = null; refreshGit(cwdRef.current); }, 1200);
  };
  useEffect(() => () => { if (bump.current !== null) window.clearTimeout(bump.current); }, []);

  const send = (cmd: string) => {
    if (phase.kind !== "open" || !ptyId) return;
    invoke("pty_write", { sessionId: ptyId, data: `${cmd}\r` }).catch(() => {});
    window.dispatchEvent(new CustomEvent("az-term:focus", { detail: ptyId }));
    onInput("\r");
  };

  const onOsc = (code: 7 | 9, data: string) => {
    const dir = cwdFromOsc(code, data);
    if (dir) setCwd(dir);
  };

  const shellName = info?.shell.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "") ?? "shell";
  /** git 面板往终端里送命令时按这个加引号：PowerShell 和 POSIX 的转义规则不一样 */
  const shellFamily: ShellFamily =
    /^(pwsh|powershell)$/i.test(shellName) ? "pwsh" : /^cmd$/i.test(shellName) ? "cmd" : "posix";

  const termMenu: MenuEntry[] = [
    { label: gitOpen ? "收起 git 面板" : "展开 git 面板", onClick: () => setGitOpen((on) => !on) },
    { label: "重启 shell", onClick: () => setRun((n) => n + 1) },
    ...(appMenu && appMenu.length > 0 ? [null, ...appMenu] : []),
  ];

  return (
    <div className="page local-page">
      <div className="session-bar local-bar">
        <span className={`status-dot ${phase.kind === "open" ? "live" : "down"}`} />
        <IconTerminal size={14} />
        <b>{shellName}</b>
        {/* 目录：点一下复制；shell 不上报目录的话（zsh）能手填，git 面板按填的算 */}
        {typedCwd === null ? (
          <button
            className="local-cwd"
            type="button"
            title={info && !info.tracksCwd ? "这个 shell 不上报目录，点一下手填" : "点一下复制路径"}
            onClick={() => (info && !info.tracksCwd ? setTypedCwd(cwd) : void copyText(cwd))}
          >
            {cwd || "…"}
          </button>
        ) : (
          <input
            className="local-cwd-input"
            value={typedCwd}
            autoFocus
            spellCheck={false}
            onChange={(e) => setTypedCwd(e.target.value)}
            onBlur={() => setTypedCwd(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { setCwd(typedCwd.trim()); setTypedCwd(null); }
              if (e.key === "Escape") setTypedCwd(null);
            }}
          />
        )}
        <span className="foot-spacer" />
        <div className="local-quick">
          {QUICK.map((one) => (
            <button key={one.cmd} className="btn-ghost sm" type="button" disabled={phase.kind !== "open"} onClick={() => send(one.cmd)}>
              {one.label}
            </button>
          ))}
        </div>
        <button
          className={`btn-ghost sm ${gitOpen ? "on" : ""}`}
          type="button"
          title={gitOpen ? "收起 git 面板" : "展开 git 面板"}
          onClick={() => setGitOpen((on) => !on)}
        >
          <IconPulse size={13} />git
        </button>
      </div>

      <div className="local-body">
        <div className="local-term">
          {phase.kind === "open" && ptyId && (
            <Terminal
              sessionId={ptyId}
              transport="pty"
              scheme={termScheme}
              variant={termVariant}
              fontSize={termFontSize}
              divider={termDivider}
              onInput={onInput}
              onOsc={onOsc}
              extraMenu={termMenu}
            />
          )}
          {phase.kind === "starting" && <p className="page-hint local-hint">正在起 shell……</p>}
          {phase.kind === "exited" && (
            <div className="local-exit">
              <b>shell 退出了{phase.code !== null && phase.code !== 0 ? `（退出码 ${phase.code > 255 ? `0x${phase.code.toString(16).toUpperCase()}` : phase.code}）` : ""}</b>
              <button className="btn-primary sm" type="button" onClick={() => setRun((n) => n + 1)}>再开一个</button>
            </div>
          )}
          {phase.kind === "error" && (
            <div className="local-exit">
              <b>{phase.message}</b>
              <small>设置里可以指定 shell 的路径；留空就是自动挑 pwsh / PowerShell / $SHELL。</small>
              <button className="btn-primary sm" type="button" onClick={() => setRun((n) => n + 1)}>再试</button>
            </div>
          )}
        </div>

        {gitOpen && (
          <GitPanel
            git={git}
            error={gitErr}
            ready={phase.kind === "open"}
            tracksCwd={info?.tracksCwd ?? true}
            shellFamily={shellFamily}
            onRun={send}
            onRefresh={() => refreshGit(cwd)}
            onClose={() => setGitOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

