import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconArrowLeft, IconChevronRight, IconRefresh, IconSearch, IconX } from "../components/icons";
import { fmtSize } from "../format";
import { DEFAULT_ENCODING, ENCODINGS } from "../types";

interface Chunk {
  offset: number;
  next: number;
  size: number;
  text: string;
  lossy: boolean;
  /** 有一行长得超过一屏，只好从中间切开 */
  cut: boolean;
}

interface Hit { offset: number; line: number; text: string }
interface Hits { rows: Hit[]; capped: boolean }

interface LogViewProps {
  path: string;
  /** 这条会话还活着才读得动；断了就只剩已经取回来的那一屏 */
  sessionId: string | null;
  /** 这台机器的默认编码 */
  defaultEncoding?: string;
  onClose: () => void;
}

const errText = (e: unknown): string =>
  e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);

/** 跟随模式多久看一眼文件长没长 */
const FOLLOW_MS = 2000;

/**
 * 大日志查看器：只读，按字节区间取，文件多大都跟读一屏一样快。
 *
 * 搜索交给服务器上的 `grep` —— 几个 GB 的文件在那边扫一遍是几秒钟，
 * 扒回本地再搜是几分钟，而且那几分钟里网卡一直是满的。
 */
export function LogView({ path, sessionId, defaultEncoding, onClose }: LogViewProps) {
  const [chunk, setChunk] = useState<Chunk | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [encoding, setEncoding] = useState(defaultEncoding || DEFAULT_ENCODING);
  const [wrap, setWrap] = useState(false);
  /** 跟随：定时看文件长没长，长了就把新的接上 */
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const [regex, setRegex] = useState(false);
  const [fold, setFold] = useState(true);
  const [hits, setHits] = useState<Hits | null>(null);
  const [searching, setSearching] = useState(false);
  /** 从搜索结果跳过去的那一行，滚过去之后高亮一下 */
  const [markLine, setMarkLine] = useState<number | null>(null);
  /** 跳过去的那行的原文：取回那一屏之后靠它找到是第几行，再滚到它 */
  const [markText, setMarkText] = useState<string | null>(null);
  const markRef = useRef<HTMLSpanElement>(null);

  const box = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /**
   * 现在停在哪儿。`null` = 末尾那一屏（打开日志十有八九是想看最新的几行）。
   *
   * 位置单独存一份，是为了让「换编码」和「重新取」都能落回原地。
   * 直接在事件里调一个 read()，换编码时就只能重新取末尾 ——
   * 翻到中间正看着的时候被弹回文件尾，是这类视图里最烦人的一件事。
   */
  const [pos, setPos] = useState<number | null>(null);
  /** 撞一下让同一个位置重新取一次（「刷新」按钮用） */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let dead = false;
    setBusy(true);
    invoke<Chunk>("log_read", { sessionId, path, offset: pos, len: null, encoding })
      .then((one) => {
        if (dead || !live.current) return;
        setChunk(one);
        setErr(null);
        // 看末尾的时候把滚动条也拉到底，不然取回来的是最新内容、眼睛看到的却是这一屏的开头
        requestAnimationFrame(() => {
          if (!box.current) return;
          box.current.scrollTop = pos === null ? box.current.scrollHeight : 0;
        });
      })
      .catch((e) => { if (!dead && live.current) setErr(errText(e)); })
      .finally(() => { if (!dead && live.current) setBusy(false); });
    return () => { dead = true; };
  }, [sessionId, path, encoding, pos, nonce]);

  // 跟随：只在已经停在文件末尾的时候才接新内容。
  // 翻到中间在看的时候把人拽走是最讨厌的行为之一。
  // atEnd 给按钮用（翻到最后一屏也算到底）；跟随只认 pos 为 null 那种「末尾那一屏」：
  // 点「上一屏」后 pos 已经变了、chunk 还是尾块，按 chunk 判断会让跟随再跑一轮把人拽回去
  const atEnd = pos === null || (!!chunk && chunk.next >= chunk.size);
  const following = pos === null;
  const posRef = useRef(pos);
  posRef.current = pos;
  useEffect(() => {
    if (!follow || !sessionId || !following) return;
    let dead = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const one = await invoke<Chunk>("log_read", { sessionId, path, offset: null, len: null, encoding });
        if (dead || !live.current) return;
        // 请求飞在路上时用户翻页了：这一轮的结果作废
        if (posRef.current !== null) return;
        // 长出新内容了才动，没长就什么都不做 —— 免得滚动位置每两秒被重置一次
        setChunk((old) => {
          if (old && one.size === old.size) return old;
          requestAnimationFrame(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; });
          return one;
        });
      } catch { /* 跟随失败不打扰，下一轮再来 */ }
      if (!dead) timer = window.setTimeout(tick, FOLLOW_MS);
    };
    timer = window.setTimeout(tick, FOLLOW_MS);
    return () => { dead = true; if (timer) window.clearTimeout(timer); };
  }, [follow, sessionId, path, encoding, following]);

  const search = async () => {
    if (!sessionId || !q.trim()) { setHits(null); return; }
    setSearching(true);
    try {
      const found = await invoke<Hits>("log_grep", {
        sessionId, path, pattern: q.trim(), regex, ignoreCase: fold,
      });
      if (live.current) { setHits(found); setErr(null); }
    } catch (e) {
      if (live.current) { setErr(errText(e)); setHits(null); }
    } finally {
      if (live.current) setSearching(false);
    }
  };

  /** 跳到某条命中：从它所在行的前一点点开始取，让它落在屏幕上方一点，前后文都看得到 */
  const jump = (hit: Hit) => {
    setFollow(false);
    setMarkLine(hit.line);
    setMarkText(hit.text);
    setPos(Math.max(0, hit.offset - 8 * 1024));
  };

  // 这一屏取回来了：找到跳过去的那一行，滚到屏幕中间。
  // 靠原文比对而不是算字节偏移 —— GBK 文件里字节数和字符数对不上，原文一定对得上
  const lines = chunk?.text.split("\n") ?? [];
  const markAt = markText === null ? -1 : lines.indexOf(markText);
  useEffect(() => {
    if (markAt < 0) return;
    // 排在读取 effect 的那次 rAF 之后：它先把 scrollTop 归零，我们再滚到目标行
    const id = requestAnimationFrame(() => requestAnimationFrame(() => markRef.current?.scrollIntoView({ block: "center" })));
    return () => cancelAnimationFrame(id);
  }, [chunk, markAt]);

  // 正文里不摆绝对行号：这一屏只知道自己从第几个字节开始，
  // 要换算成行号得从文件头数一遍换行符，在几个 GB 上是不能接受的。
  // 需要行号的场合（跟 sed -n 'Np' 对着看）搜索结果那一列给得出来。
  const pct = chunk && chunk.size > 0 ? Math.round((chunk.next / chunk.size) * 100) : 0;

  return (
    <div className="page log-page">
      <div className="log-bar">
        {/* 目录和文件名分开摆：窄了先省目录，文件名永远看得见。
            （整条路径靠 direction:rtl 做前截断的话，开头那个 / 会被甩到末尾） */}
        <b className="log-path" title={path}>
          <span className="log-dir">{path.slice(0, path.lastIndexOf("/") + 1)}</span>
          {path.slice(path.lastIndexOf("/") + 1)}
        </b>
        {chunk && (
          <span className="log-meta">
            {fmtSize(chunk.size)}
            <small>　{pct}%</small>
          </span>
        )}
        <span className="foot-spacer" />

        {chunk?.lossy && (
          <span className="log-flag warn" title="解码时遇到坏字节，多半是编码选错了">编码可能不对</span>
        )}

        <select
          className="enc-pick"
          value={encoding}
          aria-label="字符编码"
          title="日志按哪种编码解"
          onChange={(e) => setEncoding(e.target.value)}
        >
          {ENCODINGS.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}
        </select>

        <label className="check-row" title="长行折行显示，不用左右拖">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          折行
        </label>

        <label className="check-row" title={atEnd ? "文件长出新内容就自动接上" : "翻到中间时不跟随，免得把你拽走"}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随
        </label>

        <button className="session-close" type="button" onClick={onClose} title="关掉">
          <IconX size={14} /> 关闭
        </button>
      </div>

      <div className="log-tools">
        <div className="log-search">
          <IconSearch size={14} />
          <input
            value={q}
            placeholder="在服务器上搜这个文件"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !searching && void search()}
          />
          {q && (
            <button className="icon-btn sm" type="button" aria-label="清空" onClick={() => { setQ(""); setHits(null); }}>
              <IconX size={13} />
            </button>
          )}
        </div>
        <label className="check-row"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />正则</label>
        <label className="check-row"><input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} />忽略大小写</label>
        <button className="btn-ghost sm" type="button" disabled={searching || !sessionId} onClick={() => void search()}>
          {searching ? "搜着呢……" : "搜索"}
        </button>

        <span className="foot-spacer" />

        <div className="log-nav">
          <button className="btn-ghost sm" type="button" disabled={busy || !chunk || chunk.offset === 0} onClick={() => setPos(0)}>开头</button>
          <button
            className="btn-ghost sm"
            type="button"
            disabled={busy || !chunk || chunk.offset === 0}
            onClick={() => chunk && setPos(Math.max(0, chunk.offset - 256 * 1024))}
            title="上一屏"
          >
            <IconArrowLeft size={13} />
          </button>
          <button
            className="btn-ghost sm"
            type="button"
            disabled={busy || !chunk || atEnd}
            onClick={() => chunk && setPos(chunk.next)}
            title="下一屏"
          >
            <IconChevronRight size={13} />
          </button>
          <button className="btn-ghost sm" type="button" disabled={busy || !chunk || atEnd} onClick={() => setPos(null)}>末尾</button>
          <button className="btn-ghost sm" type="button" disabled={busy || !sessionId} onClick={() => setNonce((n) => n + 1)} title="重新取这一屏">
            <IconRefresh size={13} />
          </button>
        </div>
      </div>

      {err && <p className="st-err">{err}</p>}
      {!sessionId && <p className="page-hint">这条连接断了，只能看已经取回来的这一屏。</p>}
      {chunk?.cut && (
        <p className="st-note">这一屏里有一行长得超过一屏，只好从中间切开显示。</p>
      )}

      <div className="log-body">
        <div className={`log-text ${wrap ? "wrap" : ""}`} ref={box}>
          {busy && !chunk ? (
            <p className="page-hint">取着呢……</p>
          ) : (
            <pre>
              {markAt < 0
                ? chunk?.text ?? ""
                : lines.map((line, i) => (
                    <span key={i} className={i === markAt ? "log-mark" : undefined} ref={i === markAt ? markRef : undefined}>
                      {line}
                      {i < lines.length - 1 ? "\n" : ""}
                    </span>
                  ))}
            </pre>
          )}
        </div>

        {hits && (
          <aside className="log-hits">
            <header>
              <b>{hits.rows.length} 条命中</b>
              {hits.capped && <em className="warn" title="到上限就停了，后面还有没找完的">只列了前 {hits.rows.length} 条</em>}
              <button className="icon-btn sm" type="button" aria-label="收起" onClick={() => setHits(null)}><IconX size={13} /></button>
            </header>
            <div className="log-hit-list">
              {hits.rows.map((hit) => (
                <button
                  className={`log-hit ${markLine === hit.line ? "on" : ""}`}
                  type="button"
                  key={`${hit.offset}-${hit.line}`}
                  title={`第 ${hit.line} 行 · 字节 ${hit.offset}`}
                  onClick={() => jump(hit)}
                >
                  <span className="log-hit-line">{hit.line}</span>
                  <span className="log-hit-text">{hit.text}</span>
                </button>
              ))}
              {hits.rows.length === 0 && <p className="page-hint">没找到。</p>}
            </div>
          </aside>
        )}
      </div>

    </div>
  );
}
