import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ContextMenu, menuAt, type MenuEntry, type MenuState } from "./ContextMenu";
import { matchShortcut } from "../shortcuts";
import { Dialog } from "./Dialog";
import { IconSearch, IconX } from "./icons";
import { copyText, pasteText } from "../clipboard";
import { themeOf } from "../termThemes";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  sessionId: string;
  /** 配色方案 id */
  scheme: string;
  /** 用深版还是浅版（上层已按「跟随界面」算好） */
  variant: "dark" | "light";
  fontSize: number;
  /** 每敲一条命令，在输出前插一条细分割线 */
  divider: boolean;
  /** 有输入或有输出就报一声，空闲计时器靠它判断这条会话还活着 */
  onActivity?: () => void;
  /**
   * 用户在这个终端里敲的 / 粘的东西，原样再给上层一份 —— 同步输入靠它转发到别的会话。
   * 只走用户输入，服务器的回显不走这条路（不然两台机器会互相灌）。
   */
  onInput?: (data: string) => void;
  /** 上层（会话 / 应用）想挂进右键菜单的条目，接在终端自己那几条后面 */
  extraMenu?: MenuEntry[];
  /** 后端是 SSH 会话还是本地 PTY：命令名和事件名不同，参数名一样 */
  transport?: "ssh" | "pty";
  /** shell 通过 OSC 7 / OSC 9;9 上报当前目录时叫一声（本地终端用） */
  onOsc?: (code: 7 | 9, data: string) => void;
}

/**
 * 终端视图：xterm.js 画布 ⇄ Rust SSH 会话。
 * - 用户输入 → invoke("ssh_write")
 * - 服务器输出 → 监听 event "ssh://data/{sessionId}" → term.write
 * - Ctrl+Shift+F 在回滚里找字，Ctrl+Shift+C/V 复制粘贴，Ctrl+Shift+A/K 全选 / 清屏
 *
 * 快捷键一律带 Shift：不带 Shift 的 Ctrl 组合在终端里都有正经用途
 * （Ctrl+C 中断、Ctrl+F 在 vim 里翻页），抢了就是给用户添堵。
 * 应用级的那些（换标签、命令面板……）见 shortcuts.ts，这儿只负责放行。
 */
/**
 * 按「真正能看见的那块」收一遍行列数。
 *
 * FitAddon 是拿 `.xterm` 父元素的 computed height 算的，而 padding 它只到 `.xterm` 自己身上找。
 * 我们的留白加在外层 `.term-host` 上，它找不到，于是把那 16px 也当成了可用高度 ——
 * 150% 缩放下行高 15.33px，正好多算出一行，最后一行被下边缘裁掉半截。
 *
 * 所以 fit 之后再核一次：`.xterm-viewport` 才是可视区（它的 clientWidth 已经扣掉了滚动条），
 * 行高从真实渲染出来的那一行上量，比任何推算都准。
 */
function refit(term: XTerm, fit: FitAddon, host: HTMLElement) {
  if (!host.clientWidth || !host.clientHeight) return;
  fit.fit();
  const view = host.querySelector<HTMLElement>(".xterm-viewport");
  const row = host.querySelector<HTMLElement>(".xterm-rows > div");
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!view || !row || !screen) return;
  const cellH = row.getBoundingClientRect().height;
  const cellW = screen.getBoundingClientRect().width / Math.max(1, term.cols);
  if (cellH <= 0 || cellW <= 0) return;
  // 加 0.5px 的容差：DPR 1.5 下这些数都是 1/3 像素，差一点点不该少一整行
  const rows = Math.max(1, Math.floor((view.getBoundingClientRect().height + 0.5) / cellH));
  const cols = Math.max(2, Math.floor((view.clientWidth + 0.5) / cellW));
  if (rows !== term.rows || cols !== term.cols) term.resize(cols, rows);
}

export function Terminal({
  sessionId, scheme, variant, fontSize, divider, onActivity, onInput, extraMenu, transport = "ssh", onOsc,
}: TerminalProps) {
  const writeCmd = transport === "pty" ? "pty_write" : "ssh_write";
  const resizeCmd = transport === "pty" ? "pty_resize" : "ssh_resize";
  const dataEvent = transport === "pty" ? "pty://data/" : "ssh://data/";
  const oscRef = useRef(onOsc);
  oscRef.current = onOsc;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const dividerOn = useRef(divider);
  dividerOn.current = divider;
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 点了终端里的链接，等确认要不要在浏览器里打开 */
  const [linkAsk, setLinkAsk] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");

  // —— 命令补全建议 ——
  // 这一段只在**确定自己没跟丢**的时候才给建议：
  // 行编辑器在 shell 那边，我们只看得见按键；用户一按方向键、Ctrl+U、Tab、
  // 或者粘贴一段东西，我们就不知道那一行现在是什么了。那种时候宁可不提示，
  // 也不能提示一条错的 —— 采纳了会把命令拼坏。
  /** 这条会话里执行过的命令。**只在内存里**，不落盘：命令行里带密码是常事 */
  const history = useRef<string[]>([]);
  /** 我们认为当前行已经敲了什么 */
  const typed = useRef("");
  /** 还跟得上吗；false = 跟丢了，等下一个回车重新开始 */
  const tracking = useRef(true);
  const [hint, setHint] = useState<string | null>(null);
  /** 供按键处理用的最新值（那个 handler 只挂一次） */
  const hintRef = useRef<string | null>(null);
  hintRef.current = hint;

  /** 从历史里找一条以当前输入打头的 */
  const refreshHint = () => {
    const now = typed.current;
    if (!tracking.current || now.trim().length < 3) { setHint(null); return; }
    // 从新到旧找：最近敲过的那条最可能是想要的
    const found = history.current.find((one) => one.startsWith(now) && one.length > now.length);
    setHint(found ?? null);
  };

  /** 记一次输入，顺便更新建议 */
  /**
   * 敲的东西有没有在屏幕上回显。密码提示符（sudo、ssh、mysql -p、passwd）下敲的字符
   * 服务器不回显，这种行绝不能进历史 —— 不然之后敲出同样的前缀，密码就明文画在建议条里。
   * 只看开头几个字符：网络慢时最后几个字符的回显可能还没到，看整串会漏记正常命令。
   */
  const echoed = (done: string): boolean => {
    const buf = termRef.current?.buffer.active;
    if (!buf) return false;
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
    return line.includes(done.slice(0, Math.min(done.length, 6)));
  };

  const noteInput = (data: string) => {
    if (data === "\r" || data === "\n") {
      const done = typed.current.trim();
      if (done.length > 2 && echoed(done)) {
        // 同一条命令只留最近那次，别把历史撑满
        history.current = [done, ...history.current.filter((one) => one !== done)].slice(0, 200);
      }
      typed.current = "";
      tracking.current = true;
      setHint(null);
      return;
    }
    if (!tracking.current) return;
    // 退格
    if (data === "\x7f" || data === "\b") {
      typed.current = typed.current.slice(0, -1);
      refreshHint();
      return;
    }
    // 普通可见字符（一次一个）。多字符一般是粘贴或者转义序列，跟不了
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      typed.current += data;
      refreshHint();
      return;
    }
    // 方向键、Ctrl+U、Tab、粘贴……行内容不再由我们说了算，收手
    tracking.current = false;
    typed.current = "";
    setHint(null);
  };

  /** 采纳建议：把剩下那截当成用户自己敲的发过去 */
  const takeHint = () => {
    const one = hintRef.current;
    if (!one) return;
    const rest = one.slice(typed.current.length);
    if (!rest) return;
    typed.current = one;
    setHint(null);
    activity.current?.();
    invoke(writeCmd, { sessionId, data: rest }).catch(() => {});
    echo.current?.(rest);
  };
  const takeHintRef = useRef(takeHint);
  takeHintRef.current = takeHint;
  const activity = useRef(onActivity);
  activity.current = onActivity;
  // 放 ref 里：下面那个 onData 监听只挂一次，直接闭包捕获的话拿到的永远是第一次的函数
  const echo = useRef(onInput);
  echo.current = onInput;

  const paste = async () => {
    const text = await pasteText();
    if (!text) return;
    activity.current?.();
    // 经 xterm 走而不是直接 ssh_write：远端开了 bracketed paste（vim / zsh 默认）时
    // 它会包上 \e[200~ … \e[201~，多行粘贴才不会被逐行执行、在 vim 里缩进错乱。
    // 发送、同步输入的转发、补全的「跟丢了」都由下面的 onData 统一处理，这儿不用重复
    termRef.current?.paste(text);
  };

  /**
   * 画一条本地分割线：只写进本地画布，不发给服务器。
   * 全屏程序（vim / top 这类走备用屏的）里不插，免得把人家画面搅了。
   */
  const drawDivider = (term: XTerm | null) => {
    if (!term || term.buffer.active.type !== "normal") return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const width = Math.max(8, term.cols - stamp.length - 4);
    // 暗淡灰 + 细横线，末尾带个时间
    term.write(`\r\n\x1b[2m${"─".repeat(width)} ${stamp} \x1b[0m\r\n`);
  };

  const openMenu = (e: React.MouseEvent) => {
    const term = termRef.current;
    const picked = term?.getSelection() ?? "";
    setMenu(menuAt(e, [
      { label: "复制", hint: "Ctrl+Shift+C", disabled: !picked, onClick: () => void copyText(picked) },
      { label: "粘贴", hint: "Ctrl+Shift+V", onClick: () => { void paste(); term?.focus(); } },
      null,
      { label: "查找", hint: "Ctrl+Shift+F", onClick: () => setFinding(true) },
      { label: "全选", hint: "Ctrl+Shift+A", onClick: () => term?.selectAll() },
      { label: "清屏（只清本地回滚）", hint: "Ctrl+Shift+K", onClick: () => { term?.clear(); term?.focus(); } },
      { label: "插一条分割线", onClick: () => { drawDivider(term); term?.focus(); } },
      ...(extraMenu && extraMenu.length > 0 ? [null, ...extraMenu] : []),
    ]));
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace',
      fontSize,
      cursorBlink: true,
      theme: themeOf(scheme, variant),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // 终端里的链接是服务器输出的、不可信的内容。默认处理是 window.open，
    // 在 webview 里可能把整个应用导航走（等于白屏）。所以自己接管：
    // 交给系统浏览器，而且先问一句 —— 服务器输出里的地址不该点一下就打开。
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (!/^https?:\/\//i.test(uri)) return;
        setLinkAsk(uri);
      }),
    );
    term.open(host);
    // 目录上报：OSC 7（file://host/path，bash）和 OSC 9;9;path（PowerShell / Windows Terminal 的约定）。
    // 没人要的话原样放过，让 xterm 照常忽略
    term.parser.registerOscHandler(7, (data) => {
      if (!oscRef.current) return false;
      oscRef.current(7, data);
      return true;
    });
    term.parser.registerOscHandler(9, (data) => {
      if (!oscRef.current || !data.startsWith("9;")) return false;
      oscRef.current(9, data);
      return true;
    });
    refit(term, fit, host);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // 终端里 Ctrl+C 是中断、Ctrl+F 是 vim 翻页 / less 前进 / bash 右移光标，
    // 这些都得原样交给服务器。我们自己的功能一律加 Shift，不抢终端的键。
    term.attachCustomKeyEventHandler((e) => {
      // 有建议时，行尾按 → 采纳它（跟 fish / zsh-autosuggestions 一个手感）。
      // 只在有建议的时候截，而行尾的 → 在 shell 里本来就是空操作，所以不亏。
      if (e.type === "keydown" && e.key === "ArrowRight" && !e.ctrlKey && !e.altKey && !e.shiftKey && hintRef.current) {
        takeHintRef.current();
        return false;
      }
      if (e.type !== "keydown") return true;
      // 应用级快捷键（App.tsx 在 window 上监听，表在 shortcuts.ts）：不能交给 xterm ——
      // 它会把 Ctrl+Shift+W 当成 ^W、Alt+1 当成 ESC 1 发给服务器，还 stopPropagation，
      // window 就收不到了。返回 false 只是让 xterm 不处理，事件照常冒泡。
      if (matchShortcut(e)) return false;
      if (!e.ctrlKey || !e.shiftKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c") {
        const picked = term.getSelection();
        // 没选中东西时别把这个键吞了，让它照常当中断用
        if (!picked) return true;
        void copyText(picked);
        return false;
      }
      if (key === "v") {
        // 拦掉浏览器自己的 paste 事件：Chromium 把 Ctrl+Shift+V 当「纯文本粘贴」，
        // xterm 又监听着 paste 事件，不拦的话我们贴一遍、它再贴一遍
        e.preventDefault();
        void paste();
        return false;
      }
      if (key === "f") {
        setFinding(true);
        return false;
      }
      if (key === "a") {
        term.selectAll();
        return false;
      }
      if (key === "k") {
        term.clear();
        return false;
      }
      return true;
    });

    // 用户输入送往服务器；回车时顺手在本地画条分割线，把这条命令的输出圈出来
    const onData = term.onData((data) => {
      activity.current?.();
      invoke(writeCmd, { sessionId, data }).catch(() => {});
      echo.current?.(data);
      noteInput(data);
      if (dividerOn.current && data.includes("\r")) drawDivider(term);
    });

    // 服务器输出写入终端。
    // 字节 → 文本在 Rust 侧按会话编码解好了（解码器跨包保持状态，
    // 一个汉字被拆在两个包里也不会吐问号），这边拿到的直接是文本。
    let unlisten: UnlistenFn | undefined;
    let dead = false;
    listen<string>(`${dataEvent}${sessionId}`, (event) => {
      activity.current?.();
      term.write(event.payload);
    }).then((fn) => {
      // 监听挂好之前终端就卸了（StrictMode 必现）：不能让它留着往已经 dispose 的 term 里写
      if (dead) fn();
      else unlisten = fn;
    });

    // 窗口尺寸变化 → 同步 PTY（切到别的页时宽高为 0，别去 fit，会把终端算崩）
    const syncSize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      refit(term, fit, host);
      invoke(resizeCmd, { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);

    // 指令库插入内容后把光标还给终端
    const refocus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === sessionId) term.focus();
    };
    window.addEventListener("az-term:focus", refocus);

    invoke(resizeCmd, { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    term.focus();

    return () => {
      dead = true;
      onData.dispose();
      unlisten?.();
      observer.disconnect();
      window.removeEventListener("az-term:focus", refocus);
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      term.dispose();
    };
    // 配色和字号改了不重建终端，下面单独热更
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 配色 / 字号热更新；画布外的留白也跟着配色，别一半深一半浅
  useEffect(() => {
    const term = termRef.current;
    const theme = themeOf(scheme, variant);
    const host = hostRef.current;
    if (host) host.style.background = theme.background ?? "";
    if (!term) return;
    term.options.theme = theme;
    term.options.fontSize = fontSize;
    const fit = fitRef.current;
    if (host && fit && host.clientWidth && host.clientHeight) {
      refit(term, fit, host);
      invoke(resizeCmd, { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    }
  }, [scheme, variant, fontSize, sessionId, resizeCmd]);

  const find = (dir: 1 | -1) => {
    if (!query) return;
    const search = searchRef.current;
    if (dir === 1) search?.findNext(query);
    else search?.findPrevious(query);
  };

  const closeFind = () => {
    setFinding(false);
    searchRef.current?.clearDecorations?.();
    termRef.current?.focus();
  };

  return (
    <div className="term-wrap">
      {finding && (
        <div className="term-find">
          <IconSearch size={14} />
          <input
            autoFocus
            value={query}
            placeholder="在回滚里找字"
            onChange={(e) => { setQuery(e.target.value); searchRef.current?.findNext(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") find(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") closeFind();
            }}
          />
          <button type="button" title="上一个（Shift+Enter）" onClick={() => find(-1)}>↑</button>
          <button type="button" title="下一个（Enter）" onClick={() => find(1)}>↓</button>
          <button type="button" title="关掉（Esc）" onClick={closeFind}><IconX size={13} /></button>
        </div>
      )}
      <div className="term-host" ref={hostRef} onContextMenu={openMenu} />
      {hint && (
        <div className="term-hint" onMouseDown={(e) => { e.preventDefault(); takeHint(); }} title="点一下，或者按 → 采纳">
          <span className="term-hint-key">→</span>
          <code>
            <b>{hint.slice(0, typed.current.length)}</b>{hint.slice(typed.current.length)}
          </code>
          <small>这条会话里敲过</small>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {linkAsk && (
        <Dialog
          title="在浏览器里打开这个链接？"
          message={`${linkAsk}\n\n这是服务器输出里的地址，看清楚了再开。`}
          confirmText="打开"
          onConfirm={() => void openUrl(linkAsk)}
          onClose={() => { setLinkAsk(null); termRef.current?.focus(); }}
        />
      )}
    </div>
  );
}
