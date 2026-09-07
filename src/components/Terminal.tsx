import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";
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
}

/**
 * 终端视图：xterm.js 画布 ⇄ Rust SSH 会话。
 * - 用户输入 → invoke("ssh_write")
 * - 服务器输出 → 监听 event "ssh://data/{sessionId}" → term.write
 * - Ctrl+Shift+F 在回滚里找字，Ctrl+Shift+C/V 复制粘贴
 *
 * 快捷键一律带 Shift：不带 Shift 的 Ctrl 组合在终端里都有正经用途
 * （Ctrl+C 中断、Ctrl+F 在 vim 里翻页），抢了就是给用户添堵。
 */
export function Terminal({ sessionId, scheme, variant, fontSize, divider, onActivity }: TerminalProps) {
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
  const activity = useRef(onActivity);
  activity.current = onActivity;

  const paste = async () => {
    const text = await pasteText();
    if (!text) return;
    activity.current?.();
    // 经 xterm 走而不是直接 ssh_write：远端开了 bracketed paste（vim / zsh 默认）时
    // 它会包上 \e[200~ … \e[201~，多行粘贴才不会被逐行执行、在 vim 里缩进错乱
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
      { label: "插一条分割线", onClick: () => { drawDivider(term); term?.focus(); } },
      { label: "全选", onClick: () => term?.selectAll() },
      { label: "清屏", hint: "只清本地回滚", onClick: () => term?.clear() },
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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // 终端里 Ctrl+C 是中断、Ctrl+F 是 vim 翻页 / less 前进 / bash 右移光标，
    // 这些都得原样交给服务器。我们自己的功能一律加 Shift，不抢终端的键。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      const key = e.key.toLowerCase();
      // 应用级快捷键（App.tsx 在 window 上监听）：Ctrl+Tab 换标签、Ctrl+T 新建、Ctrl+1..9 跳标签。
      // 不能交给 xterm —— 它会把这些当成 HT / ^T / 控制字符发给服务器，还 stopPropagation，
      // window 就收不到了。返回 false 只是让 xterm 不处理，事件照常冒泡。
      // Ctrl+W 故意不拦：bash 里那是删一个词，比关标签常用得多（跟 Windows Terminal 一个规矩）。
      if (!e.altKey && !e.metaKey && (e.key === "Tab" || (!e.shiftKey && (key === "t" || /^[1-9]$/.test(e.key))))) return false;
      if (!e.shiftKey) return true;
      if (key === "c") {
        const picked = term.getSelection();
        // 没选中东西时别把这个键吞了，让它照常当中断用
        if (!picked) return true;
        void copyText(picked);
        return false;
      }
      if (key === "v") {
        void paste();
        return false;
      }
      if (key === "f") {
        setFinding(true);
        return false;
      }
      return true;
    });

    // 用户输入送往服务器；回车时顺手在本地画条分割线，把这条命令的输出圈出来
    const onData = term.onData((data) => {
      activity.current?.();
      invoke("ssh_write", { sessionId, data }).catch(() => {});
      if (dividerOn.current && data.includes("\r")) drawDivider(term);
    });

    // 服务器输出写入终端。
    // 字节 → 文本在 Rust 侧按会话编码解好了（解码器跨包保持状态，
    // 一个汉字被拆在两个包里也不会吐问号），这边拿到的直接是文本。
    let unlisten: UnlistenFn | undefined;
    let dead = false;
    listen<string>(`ssh://data/${sessionId}`, (event) => {
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
      fit.fit();
      invoke("ssh_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);

    // 指令库插入内容后把光标还给终端
    const refocus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === sessionId) term.focus();
    };
    window.addEventListener("az-term:focus", refocus);

    invoke("ssh_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
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
    if (host?.clientWidth && host.clientHeight) {
      fitRef.current?.fit();
      invoke("ssh_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    }
  }, [scheme, variant, fontSize, sessionId]);

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
