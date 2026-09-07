import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconCheck, IconFileEdit, IconRefresh, IconSearch, IconX } from "../components/icons";
import { ChmodDialog } from "../components/ChmodDialog";
import { ContextMenu, menuAt, type MenuState } from "../components/ContextMenu";
import { Dialog } from "../components/Dialog";
import { copyText, pasteText } from "../clipboard";
import { fmtMode, fmtMtime, fmtSize, fmtWhen } from "../format";
import { ENCODINGS } from "../types";

interface TextFile {
  path: string;
  name: string;
  content: string;
  size: number;
  mode?: number | null;
  mtime: number;
  /** 这次按哪种编码读进来的 */
  encoding: string;
  /** 解码时撞上坏字节 —— 多半是编码挑错了 */
  lossy: boolean;
  /** 原来的换行风格，存回去照原样 */
  newline: "lf" | "crlf";
  /** 文件开头有 BOM，存回去要补上 */
  bom?: boolean;
}

interface FileEditorProps {
  side: "local" | "remote";
  path: string;
  /** 远程文件要靠它写回去；会话断了就是 null */
  sessionId: string | null;
  /** 头一次按哪种编码读：远程跟着那条连接的设置走 */
  defaultEncoding?: string;
  /** 内容改没改过，标签条上要显示小圆点，关标签前要拦一下 */
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}

const TAB = "  ";

/**
 * 内置编辑器：远程配置文件在自己窗口里改完直接存回去。
 * 不落临时文件、不叫系统编辑器、不用记得手动上传。
 */
export function FileEditor({ side, path, sessionId, defaultEncoding, onDirtyChange, onClose }: FileEditorProps) {
  const [text, setText] = useState("");
  const [origin, setOrigin] = useState("");
  const [meta, setMeta] = useState<TextFile | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving">("loading");
  /** 真的把内容读进来过没有 —— 没读到就不许写回去，否则等于拿空白盖掉人家的文件 */
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<{ message: string; detail?: string | null } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [chmodOpen, setChmodOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 要用户确认一下的动作：这些都会把没保存的改动冲掉 */
  const [ask, setAsk] = useState<null | { kind: "reload" } | { kind: "encoding"; to: string } | { kind: "stale" }>(null);
  /** 查找栏：null=没开 */
  const [find, setFind] = useState<{ query: string; replace: string; withReplace: boolean } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const dirty = text !== origin;
  const notify = useRef(onDirtyChange);
  notify.current = onDirtyChange;
  useEffect(() => { notify.current(dirty); }, [dirty]);

  // 会话 id 会因为「掉线 → 重连」换一个新的。它只用来决定「现在能不能写回去」，
  // 绝不能牵动重新读取 —— 那会把用户正在改、还没存的内容悄悄换成服务器上的版本。
  const session = useRef(sessionId);
  session.current = sessionId;

  const fail = (e: unknown) => {
    setErr(
      e && typeof e === "object" && "message" in e
        ? (e as { message: string; detail?: string | null })
        : { message: "出错了", detail: String(e) },
    );
  };

  const load = useCallback(async (as?: string) => {
    setState("loading");
    setErr(null);
    try {
      const file =
        side === "local"
          ? await invoke<TextFile>("local_read_text", { path, encoding: as ?? null })
          : await invoke<TextFile>("sftp_read_text", { sessionId: session.current, path, encoding: as ?? null });
      setMeta(file);
      setText(file.content);
      setOrigin(file.content);
      setLoaded(true);
      setState("ready");
    } catch (e) {
      fail(e);
      setState("ready");
    }
  }, [side, path]);

  // 只在挂载时读一次；之后要重读得用户自己点，省得吞掉他没保存的改动。
  // 首次用哪种编码只看开这个标签的那一刻，之后连接改了编码也不会牵动这里
  const startEncoding = useRef(defaultEncoding);
  useEffect(() => { void load(startEncoding.current); }, [load]);

  /** 点「重新读取」：有改动先问一句 */
  const reload = () => {
    if (dirty) { setAsk({ kind: "reload" }); return; }
    void load(meta?.encoding);
  };

  /** 换一种编码重读。改过的内容会没，所以先问一句 */
  const rereadAs = (next: string) => {
    if (next === meta?.encoding) return;
    if (dirty) { setAsk({ kind: "encoding", to: next }); return; }
    void load(next);
  };

  // 正在存的时候再按 Ctrl+S 不能再发一次：两次并发写，第一次改了 mtime，
  // 第二次的 expectMtime 对不上就会误报「被别人改过」
  const saving = useRef(false);
  const save = useCallback(async (force = false) => {
    if (saving.current) return;
    if (!loaded) {
      setErr({ message: "这个文件没读进来过，不能保存 —— 存下去等于把原文清空" });
      return;
    }
    if (side === "remote" && !sessionId) {
      setErr({ message: "连接不在了，回那个会话标签重连再存" });
      return;
    }
    saving.current = true;
    setState("saving");
    setErr(null);
    try {
      // 读进来时是什么编码、什么换行、什么修改时间，原样交回去：
      // 前两个决定怎么写，第三个用来判断这中间有没有别人动过
      const args = {
        path,
        content: text,
        encoding: meta?.encoding ?? null,
        newline: meta?.newline ?? null,
        expectMtime: meta?.mtime ?? null,
        force,
        bom: meta?.bom ?? false,
      };
      const mtime =
        side === "local"
          ? await invoke<number>("local_write_text", args)
          : await invoke<number>("sftp_write_text", { sessionId, ...args });
      setOrigin(text);
      setSavedAt(Date.now());
      setMeta((old) => (old ? { ...old, mtime, size: new TextEncoder().encode(text).length } : old));
      // 文件面板正开着这个目录的话，让它把新时间和大小刷出来
      window.dispatchEvent(new CustomEvent("az-term:fs-changed", { detail: { side, path } }));
    } catch (e) {
      // 别人改过：不自作主张，把选择权交回给用户
      const detail = e && typeof e === "object" && "detail" in e ? String((e as { detail?: string }).detail ?? "") : "";
      if (detail.startsWith("stale:")) { setAsk({ kind: "stale" }); return; }
      fail(e);
    } finally {
      saving.current = false;
      setState("ready");
    }
  }, [side, sessionId, path, text, loaded, meta?.encoding, meta?.newline, meta?.mtime, meta?.bom]);

  const chmod = async (mode: number) => {
    if (!sessionId) return;
    try {
      const next = await invoke<number>("sftp_chmod", { sessionId, path, mode });
      setMeta((old) => (old ? { ...old, mode: next } : old));
      window.dispatchEvent(new CustomEvent("az-term:fs-changed", { detail: { side, path } }));
    } catch (e) { fail(e); }
  };

  const openMenu = (e: React.MouseEvent) => {
    const area = areaRef.current;
    const picked = area ? text.slice(area.selectionStart, area.selectionEnd) : "";
    const replaceSelection = (insert: string) => {
      if (!area) return;
      const { selectionStart: start, selectionEnd: end } = area;
      setText(`${text.slice(0, start)}${insert}${text.slice(end)}`);
      requestAnimationFrame(() => {
        area.focus();
        area.setSelectionRange(start + insert.length, start + insert.length);
      });
    };
    setMenu(menuAt(e, [
      { label: "剪切", disabled: !picked, onClick: () => { void copyText(picked); replaceSelection(""); } },
      { label: "复制", disabled: !picked, onClick: () => void copyText(picked) },
      { label: "粘贴", onClick: async () => replaceSelection(await pasteText()) },
      { label: "全选", onClick: () => area?.select() },
      null,
      { label: "查找", hint: "Ctrl+F", onClick: () => openFind(false) },
      { label: "替换", hint: "Ctrl+H", onClick: () => openFind(true) },
      null,
      { label: "保存", hint: "Ctrl+S", disabled: !dirty || !loaded, onClick: () => void save() },
      { label: "重新读取", onClick: reload },
      ...(side === "remote"
        ? [null, { label: "改权限", hint: fmtMode(meta?.mode) || "chmod", onClick: () => setChmodOpen(true) }]
        : []),
    ]));
  };

  // —— 查找 / 替换 / 跳行 ——
  const lineHeight = () => {
    const area = areaRef.current;
    return area ? parseFloat(getComputedStyle(area).lineHeight) || 20 : 20;
  };

  const revealIndex = (index: number) => {
    const area = areaRef.current;
    if (!area) return;
    const line = text.slice(0, index).split("\n").length;
    area.scrollTop = Math.max(0, (line - 5) * lineHeight());
  };

  const seek = (dir: 1 | -1) => {
    const area = areaRef.current;
    const query = find?.query ?? "";
    if (!area || !query) return;
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let at: number;
    if (dir === 1) {
      at = hay.indexOf(needle, area.selectionEnd);
      if (at < 0) at = hay.indexOf(needle);
    } else {
      at = hay.lastIndexOf(needle, Math.max(0, area.selectionStart - 1));
      if (at < 0) at = hay.lastIndexOf(needle);
    }
    if (at < 0) return;
    area.focus();
    area.setSelectionRange(at, at + needle.length);
    revealIndex(at);
  };

  const replaceOne = () => {
    const area = areaRef.current;
    const query = find?.query ?? "";
    if (!area || !query) return;
    const picked = text.slice(area.selectionStart, area.selectionEnd);
    if (picked.toLowerCase() !== query.toLowerCase()) { seek(1); return; }
    const at = area.selectionStart;
    const insert = find?.replace ?? "";
    setText(`${text.slice(0, at)}${insert}${text.slice(area.selectionEnd)}`);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(at + insert.length, at + insert.length);
    });
  };

  const replaceAll = () => {
    const query = find?.query ?? "";
    if (!query) return;
    const parts = text.split(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
    setText(parts.join(find?.replace ?? ""));
  };

  const gotoLine = (raw: string) => {
    const area = areaRef.current;
    const line = parseInt(raw, 10);
    if (!area || Number.isNaN(line)) return;
    const lines = text.split("\n");
    const target = Math.min(Math.max(line, 1), lines.length);
    const at = lines.slice(0, target - 1).join("\n").length + (target > 1 ? 1 : 0);
    area.focus();
    area.setSelectionRange(at, at);
    area.scrollTop = Math.max(0, (target - 5) * lineHeight());
  };

  const hits = useMemo(() => {
    const query = find?.query ?? "";
    if (!query) return 0;
    return text.toLowerCase().split(query.toLowerCase()).length - 1;
  }, [text, find?.query]);

  const openFind = (withReplace: boolean) => {
    const area = areaRef.current;
    const picked = area ? text.slice(area.selectionStart, area.selectionEnd) : "";
    setFind((old) => ({
      query: picked && !picked.includes("\n") ? picked : old?.query ?? "",
      replace: old?.replace ?? "",
      withReplace,
    }));
    requestAnimationFrame(() => findInputRef.current?.select());
  };

  // Ctrl+S 存盘 · Ctrl+F 查找 · Ctrl+H 替换 · Ctrl+G 跳行
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") { e.preventDefault(); save(); }
      if (key === "f") { e.preventDefault(); openFind(false); }
      if (key === "h") { e.preventDefault(); openFind(true); }
      if (key === "g") { e.preventDefault(); setFind((old) => old ?? { query: "", replace: "", withReplace: false }); }
    };
    const host = areaRef.current;
    host?.addEventListener("keydown", onKey);
    return () => host?.removeEventListener("keydown", onKey);
    // openFind 依赖 text，重挂无妨
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, text]);

  // Tab 键插两个空格，别让焦点跑了
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const area = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = area;
    const next = `${text.slice(0, start)}${TAB}${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => area.setSelectionRange(start + TAB.length, start + TAB.length));
  };

  const lines = useMemo(() => text.split("\n").length, [text]);

  // 行号跟着正文一起滚
  const syncScroll = () => {
    if (gutterRef.current && areaRef.current) gutterRef.current.scrollTop = areaRef.current.scrollTop;
  };

  return (
    <div className="editor">
      <div className="editor-bar">
        <IconFileEdit size={15} />
        <b>{meta?.name ?? path.split(/[\\/]/).pop()}</b>
        {dirty && <span className="dot-dirty" title="还没存" />}
        <span className="editor-path" title={path}>{path}</span>
        <span className="foot-spacer" />
        <span className="editor-meta">
          {side === "local" ? "本地" : "远程"} · {lines} 行
          {meta ? ` · ${meta.newline === "crlf" ? "CRLF" : "LF"}` : ""}
          {meta ? ` · ${fmtSize(meta.size)}` : ""}
          {meta?.mtime ? ` · ${fmtMtime(meta.mtime)}` : ""}
        </span>
        {/* 编码摆在这儿，乱码时当场换一种重读；存回去也用这一种 */}
        <select
          className="enc-pick"
          value={meta?.encoding ?? "utf-8"}
          disabled={!loaded}
          title="按哪种编码读写这个文件"
          aria-label="文件编码"
          onChange={(e) => rereadAs(e.target.value)}
        >
          {ENCODINGS.map((one) => (
            <option key={one.value} value={one.value}>{one.label}</option>
          ))}
        </select>
        {side === "remote" && (
          <button
            className="mode-chip"
            type="button"
            disabled={!sessionId}
            onClick={() => setChmodOpen(true)}
            title="改权限（chmod）"
          >
            {fmtMode(meta?.mode) || "权限"}
          </button>
        )}
        <button className="icon-btn sm" type="button" onClick={reload} title="重新读取（丢掉未保存的改动）" aria-label="重新读取">
          <IconRefresh size={15} />
        </button>
        <button
          className="btn-primary sm"
          type="button"
          disabled={!dirty || !loaded || state !== "ready"}
          onClick={() => void save()}
          title={loaded ? "Ctrl + S" : "文件没读进来，不能保存"}
        >
          {state === "saving" ? "存着……" : dirty ? "保存" : savedAt ? "已保存" : "无改动"}
        </button>
        <button className="icon-btn sm" type="button" onClick={onClose} title="关闭" aria-label="关闭">
          <IconX size={15} />
        </button>
      </div>

      {err && (
        <div className="editor-error">
          <b>{err.message}</b>
          {err.detail && <small>{err.detail}</small>}
          <button type="button" onClick={() => setErr(null)} aria-label="知道了" title="知道了"><IconX size={12} /></button>
        </div>
      )}

      {/* 解码时撞上坏字节：编码八成挑错了。这时候存回去会把原文毁掉，先拦一句 */}
      {meta?.lossy && (
        <div className="editor-warn">
          按 {meta.encoding} 解不干净，有乱码 · 换个编码重读（多半是 GBK），别直接存回去
        </div>
      )}

      {/* 连接断了：内容原样留着，等重连再存，别让人白改一通 */}
      {side === "remote" && !sessionId && loaded && (
        <div className="editor-warn">
          连接断了 · 内容还在，{dirty ? "回那个会话标签重连之后就能保存" : "重连后可以继续编辑"}
        </div>
      )}

      {savedAt && !dirty && !err && (
        <div className="editor-ok"><IconCheck size={13} />{fmtWhen(savedAt)}存回{side === "local" ? "本地" : "服务器"}了</div>
      )}

      {find && (
        <div className="editor-find">
          <IconSearch size={13} />
          <input
            ref={findInputRef}
            className="find-q"
            value={find.query}
            placeholder="查找"
            onChange={(e) => setFind({ ...find, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); seek(e.shiftKey ? -1 : 1); }
              if (e.key === "Escape") { setFind(null); areaRef.current?.focus(); }
            }}
          />
          <span className="find-count">{find.query ? `${hits} 处` : ""}</span>
          <button type="button" title="上一个（Shift+Enter）" onClick={() => seek(-1)}>↑</button>
          <button type="button" title="下一个（Enter）" onClick={() => seek(1)}>↓</button>

          {find.withReplace ? (
            <>
              <input
                className="find-q"
                value={find.replace}
                placeholder="替换成"
                onChange={(e) => setFind({ ...find, replace: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && replaceOne()}
              />
              <button type="button" onClick={replaceOne} title="替换当前这个">替换</button>
              <button type="button" onClick={replaceAll} title={`把 ${hits} 处全换掉`}>全换</button>
            </>
          ) : (
            <button type="button" onClick={() => setFind({ ...find, withReplace: true })} title="Ctrl+H">替换…</button>
          )}

          <input
            className="find-line"
            placeholder="行号"
            title="Ctrl+G · 输行号回车跳过去"
            onKeyDown={(e) => {
              if (e.key === "Enter") gotoLine((e.target as HTMLInputElement).value);
              if (e.key === "Escape") { setFind(null); areaRef.current?.focus(); }
            }}
          />
          <button type="button" title="关掉（Esc）" onClick={() => { setFind(null); areaRef.current?.focus(); }}>
            <IconX size={12} />
          </button>
        </div>
      )}

      <div className="editor-body">
        <div className="editor-gutter" ref={gutterRef}>
          {Array.from({ length: lines }, (_, i) => <span key={i}>{i + 1}</span>)}
        </div>
        <textarea
          ref={areaRef}
          className="editor-area"
          value={text}
          spellCheck={false}
          wrap="off"
          disabled={state === "loading"}
          placeholder={state === "loading" ? "读取中……" : ""}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onContextMenu={openMenu}
        />
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {ask?.kind === "stale" && (
        <Dialog
          title="这个文件被别人改过了"
          message={`从你打开它到现在，${side === "local" ? "本地" : "服务器上"}的这个文件又被改动过。现在存下去，人家那次改动就没了。`}
          confirmText="还是用我的版本覆盖"
          danger
          onConfirm={() => void save(true)}
          onClose={() => setAsk(null)}
        />
      )}
      {(ask?.kind === "reload" || ask?.kind === "encoding") && (
        <Dialog
          title={ask.kind === "encoding" ? "丢掉改动，换个编码重读？" : "丢掉改动，重新读取？"}
          message="你在这儿改的还没保存，重读会拿文件现在的内容盖掉它们。"
          confirmText={ask.kind === "encoding" ? "换编码重读" : "丢掉，重读"}
          danger
          onConfirm={() => void load(ask.kind === "encoding" ? ask.to : meta?.encoding)}
          onClose={() => setAsk(null)}
        />
      )}
      {chmodOpen && (
        <ChmodDialog
          name={meta?.name ?? path}
          mode={meta?.mode ?? 0o644}
          onApply={chmod}
          onClose={() => setChmodOpen(false)}
        />
      )}
    </div>
  );
}
