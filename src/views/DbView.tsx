import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MenuEntry } from "../components/ContextMenu";
import { IconChevronDown, IconChevronRight, IconDatabase, IconLock, IconPlay, IconRefresh, IconSettings, IconX } from "../components/icons";
import { DbPage } from "./DbPage";
import { takeSecret } from "../secrets";
import { DB_KINDS, type DbConn } from "../types";

interface DbOpened { sessionId: string; server: string; database: string | null }
interface DbResult { columns: string[]; rows: (string | null)[][]; affected: number | null; truncated: boolean; elapsedMs: number }
interface TableNode { name: string; kind: "table" | "view" }
interface SchemaNode { name: string; current: boolean; tables: TableNode[] }
interface DbSchema { schemas: SchemaNode[] }
interface RedisKey { key: string; kind: string; ttl: number }
interface RedisScan { cursor: number; keys: RedisKey[] }
interface RedisPeek { kind: string; ttl: number; len: number; value: unknown; truncated: boolean }
interface DbError { message: string; detail?: string | null }

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "open"; sessionId: string; server: string; database: string | null }
  | { kind: "error"; err: DbError };
type Mode = "console" | "config";

interface DbViewProps {
  db: DbConn;
  active: boolean;
  initialMode?: Mode;
  autoConnect?: boolean;
  /** 连上 / 断开告诉上层（侧栏的小圆点） */
  onSession: (sessionId: string | null) => void;
  onSaveDb: (db: DbConn) => void;
  onDeleteDb: (db: DbConn) => void;
  onConfigDirty: (dirty: boolean) => void;
  appMenu?: MenuEntry[];
}

const errOf = (e: unknown): DbError =>
  e && typeof e === "object" && "message" in e ? (e as DbError) : { message: "出错了", detail: String(e) };

const LIMITS = [100, 500, 2000, 5000];

/** SQL 标识符按各家规矩引起来 */
const quoteIdent = (kind: DbConn["kind"], name: string) =>
  kind === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;

/** Redis 命令行拆参数：认单双引号，引号里的空格不切 */
function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const fmtTtl = (ttl: number) => (ttl === -1 ? "不过期" : ttl === -2 ? "不存在" : ttl >= 3600 ? `${Math.round(ttl / 3600)}h` : ttl >= 60 ? `${Math.round(ttl / 60)}m` : `${ttl}s`);

/**
 * 数据库标签：连接卡 → 控制台。
 * SQL 那两家是「库表树 + 编辑器 + 结果表」，Redis 是「key 浏览 + 命令行 + 内容预览」。
 */
export function DbView({ db, active, initialMode, autoConnect, onSession, onSaveDb, onDeleteDb, onConfigDirty, appMenu }: DbViewProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [mode, setMode] = useState<Mode>(initialMode ?? "console");
  const [seed] = useState(() => takeSecret(db.id));
  const [password, setPassword] = useState(seed?.secret ?? "");
  const [remember, setRemember] = useState(seed?.remember ?? true);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const tell = useRef(onSession);
  tell.current = onSession;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const meta = DB_KINDS.find((one) => one.value === db.kind) ?? DB_KINDS[0];
  const open = phase.kind === "open" ? phase : null;

  const connect = useCallback(async (silent = false) => {
    const live = phaseRef.current.kind;
    if (live === "connecting" || live === "open") return;
    const sessionId = `db-${db.id}-${Date.now().toString(36)}`;
    setPhase({ kind: "connecting" });
    try {
      const got = await invoke<DbOpened>("db_connect", {
        spec: {
          sessionId,
          connId: db.id,
          kind: db.kind,
          host: db.host,
          port: db.port,
          username: db.username,
          password: password || null,
          database: db.database ?? null,
          remember: !silent && remember && password !== "",
        },
      });
      if (!mounted.current) { invoke("db_close", { sessionId }).catch(() => {}); return; }
      if (!silent && remember && password) setSaved(true);
      setPassword("");
      setPhase({ kind: "open", sessionId: got.sessionId, server: got.server, database: got.database });
      tell.current(got.sessionId);
    } catch (e) {
      if (mounted.current) setPhase({ kind: "error", err: errOf(e) });
    }
  }, [db, password, remember]);
  const connectNow = useRef(connect);
  connectNow.current = connect;

  // 开标签先问钥匙串：记过密码就直接连
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    invoke<boolean>("creds_has", { connId: db.id })
      .then((has) => {
        if (!mounted.current) return;
        setSaved(has);
        if (!autoConnect) return;
        if (seed?.secret) { void connectNow.current(false); return; }
        if (has || db.kind === "redis") void connectNow.current(true);
      })
      .catch(() => {});
  }, [db.id, db.kind, autoConnect, seed]);

  const disconnect = useCallback(() => {
    const live = phaseRef.current;
    if (live.kind === "open") invoke("db_close", { sessionId: live.sessionId }).catch(() => {});
    tell.current(null);
    setPhase({ kind: "idle" });
  }, []);
  // 关标签把连接收掉
  useEffect(() => () => {
    const live = phaseRef.current;
    if (live.kind === "open") invoke("db_close", { sessionId: live.sessionId }).catch(() => {});
    tell.current(null);
  }, []);

  const forget = async () => {
    await invoke("creds_forget", { connId: db.id }).catch(() => {});
    setSaved(false);
  };

  const termMenu: MenuEntry[] = [
    { label: "控制台", onClick: () => setMode("console") },
    { label: "这条连接的配置", onClick: () => setMode("config") },
    null,
    { label: "断开连接", danger: true, disabled: !open, onClick: disconnect },
    ...(appMenu && appMenu.length > 0 ? [null, ...appMenu] : []),
  ];
  void termMenu;

  return (
    <div className="session db-view">
      <div className="session-bar">
        <span className={`status-dot ${open ? "live" : "down"}`} title={open ? "连着" : "没连上"} />
        <b>{db.name}</b>
        <span className="session-meta">
          {meta.label} · {db.username ? `${db.username}@` : ""}{db.host}:{db.port}{db.database ? `/${db.database}` : ""}
          {open && <> · {open.server}</>}
        </span>
        <div className="seg mini">
          <button type="button" className={mode === "console" ? "on" : ""} onClick={() => setMode("console")}>
            <IconDatabase size={13} />控制台
          </button>
          <button type="button" className={mode === "config" ? "on" : ""} onClick={() => setMode("config")}>
            <IconSettings size={13} />配置
          </button>
        </div>
        <span className="foot-spacer" />
        {open ? (
          <button className="session-close" type="button" onClick={disconnect} title="断开这条连接"><IconX size={13} />断开</button>
        ) : (
          <button
            className="btn-primary sm"
            type="button"
            disabled={phase.kind === "connecting"}
            onClick={() => { if (mode === "config") setMode("console"); void connect(); }}
          >
            {phase.kind === "connecting" ? "连接中……" : "连接"}
          </button>
        )}
      </div>

      <div className="session-body">
        <div className="session-pane" style={{ display: mode === "config" ? "flex" : "none" }}>
          <DbPage
            db={db}
            embedded
            onSave={(next) => onSaveDb(next)}
            onSecret={(secret, keep) => { setPassword(secret); setRemember(keep); setMode("console"); }}
            onDelete={onDeleteDb}
            onDirtyChange={onConfigDirty}
          />
        </div>

        <div className="session-pane" style={{ display: mode === "console" ? "flex" : "none" }}>
          {open ? (
            db.kind === "redis" ? (
              <RedisConsole sessionId={open.sessionId} active={active} />
            ) : (
              <SqlConsole sessionId={open.sessionId} kind={db.kind} active={active} />
            )
          ) : (
            <div className="connect-wrap">
              <div className="connect-card">
                <div className="connect-head">
                  <h2>{db.name}</h2>
                  <span>{meta.label} · {db.username ? `${db.username}@` : ""}{db.host}:{db.port}{db.database ? `/${db.database}` : ""}</span>
                </div>
                {saved && !password ? (
                  <div className="saved-row">
                    <IconLock size={14} />
                    <span>密码记在系统钥匙串里，直接连就行</span>
                    <button type="button" onClick={forget} title="从系统钥匙串里删掉">忘掉</button>
                  </div>
                ) : (
                  <label className="field">
                    <span>{db.kind === "redis" ? "密码（没设就留空）" : "密码"}</span>
                    <div className="pw-input">
                      <IconLock size={15} />
                      <input
                        type="password"
                        value={password}
                        autoFocus={active}
                        placeholder={db.kind === "redis" ? "requirepass / ACL 的密码" : "输一次，勾上记住就不用再输"}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void connect()}
                      />
                    </div>
                  </label>
                )}
                {(!saved || password) && (
                  <label className="check-row" title="存进系统钥匙串（Windows 凭据管理器 / macOS 钥匙串）">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    <span>连上之后记住密码，下次直接连</span>
                  </label>
                )}
                {phase.kind === "error" && (
                  <div className="connect-error">
                    <b>{phase.err.message}</b>
                    {phase.err.detail && <small>{phase.err.detail}</small>}
                  </div>
                )}
                <button className="btn-primary" type="button" disabled={phase.kind === "connecting"} onClick={() => void connect()}>
                  {phase.kind === "connecting" ? "连接中……" : "连接"}
                </button>
                <p className="dim connect-note">
                  <IconLock size={12} />
                  密码只在连接时用，勾了记住就交给系统钥匙串保管，配置文件和备份里没有明文。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- SQL ----------

function SqlConsole({ sessionId, kind, active }: { sessionId: string; kind: DbConn["kind"]; active: boolean }) {
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [schemaErr, setSchemaErr] = useState<string | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [sql, setSql] = useState("");
  const [limit, setLimit] = useState(500);
  const [result, setResult] = useState<DbResult | null>(null);
  const [err, setErr] = useState<DbError | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const loadSchema = useCallback(() => {
    invoke<DbSchema>("db_schema", { sessionId })
      .then((got) => {
        if (!live.current) return;
        setSchema(got);
        setSchemaErr(null);
        // 当前库默认展开，别的折着
        setOpenSchemas((old) => {
          const next = { ...old };
          for (const one of got.schemas) if (!(one.name in next)) next[one.name] = one.current || got.schemas.length === 1;
          return next;
        });
      })
      .catch((e) => { if (live.current) setSchemaErr(errOf(e).message); });
  }, [sessionId]);
  useEffect(() => { loadSchema(); }, [loadSchema]);

  const run = useCallback(async (text?: string) => {
    const query = (text ?? sql).trim();
    if (!query || running) return;
    setRunning(true);
    setErr(null);
    try {
      const got = await invoke<DbResult>("db_query", { sessionId, sql: query, limit });
      if (!live.current) return;
      setResult(got);
      setHistory((old) => [query, ...old.filter((one) => one !== query)].slice(0, 30));
      // DDL / USE 之后树可能变了
      if (/^\s*(create|drop|alter|use|rename)\b/i.test(query)) loadSchema();
    } catch (e) {
      if (live.current) { setErr(errOf(e)); setResult(null); }
    } finally {
      if (live.current) setRunning(false);
    }
  }, [sql, running, sessionId, limit, loadSchema]);

  const peekTable = (schemaName: string, table: string) => {
    const q = `SELECT * FROM ${quoteIdent(kind, schemaName)}.${quoteIdent(kind, table)} LIMIT 100`;
    setSql(q);
    void run(q);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void run(); }
  };

  useEffect(() => { if (active) editor.current?.focus(); }, [active]);

  const shownSchemas = useMemo(() => {
    if (!schema) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return schema.schemas;
    return schema.schemas
      .map((one) => ({ ...one, tables: one.tables.filter((t) => t.name.toLowerCase().includes(needle)) }))
      .filter((one) => one.tables.length > 0 || one.name.toLowerCase().includes(needle));
  }, [schema, filter]);

  return (
    <div className="db-body">
      <aside className="db-tree">
        <div className="db-tree-head">
          <input value={filter} placeholder="找表" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
          <button className="icon-btn sm" type="button" title="重新读库表" onClick={loadSchema}><IconRefresh size={13} /></button>
        </div>
        {schemaErr && <p className="st-err">{schemaErr}</p>}
        {!schema && !schemaErr && <p className="page-hint">读库表……</p>}
        {schema && shownSchemas.length === 0 && <p className="page-hint">{filter ? "没有匹配的表。" : "一个库都没有。"}</p>}
        <ul className="db-schemas">
          {shownSchemas.map((one) => {
            const opened = !!openSchemas[one.name] || filter.trim() !== "";
            return (
              <li key={one.name}>
                <button type="button" className={`db-schema ${one.current ? "current" : ""}`} onClick={() => setOpenSchemas((old) => ({ ...old, [one.name]: !opened }))}>
                  {opened ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                  <IconDatabase size={12} />
                  <span>{one.name}</span>
                  <small>{one.tables.length}</small>
                </button>
                {opened && (
                  <ul>
                    {one.tables.map((t) => (
                      <li key={t.name}>
                        <button type="button" className={`db-table ${t.kind}`} title={`SELECT * FROM ${one.name}.${t.name} LIMIT 100`} onClick={() => peekTable(one.name, t.name)}>
                          <i>{t.kind === "view" ? "V" : "T"}</i>{t.name}
                        </button>
                      </li>
                    ))}
                    {one.tables.length === 0 && <li className="page-hint">空的</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="db-main">
        <div className="db-editor">
          <textarea
            ref={editor}
            value={sql}
            spellCheck={false}
            placeholder={`在这儿写 SQL，Ctrl+Enter 执行。左边点一张表就是 SELECT * … LIMIT 100`}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="db-toolbar">
            <button className="btn-primary sm" type="button" disabled={running || !sql.trim()} onClick={() => void run()}>
              <IconPlay size={13} />{running ? "执行中……" : "执行"}
            </button>
            <label className="db-limit">
              最多
              <select className="enc-pick" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                {LIMITS.map((one) => <option key={one} value={one}>{one}</option>)}
              </select>
              行
            </label>
            {history.length > 0 && (
              <select className="enc-pick db-history" value="" onChange={(e) => { if (e.target.value) setSql(e.target.value); }}>
                <option value="">最近跑过的……</option>
                {history.map((one) => <option key={one} value={one}>{one.length > 80 ? `${one.slice(0, 80)}…` : one}</option>)}
              </select>
            )}
            <span className="foot-spacer" />
            <span className="db-hint">Ctrl+Enter 执行 · 写操作会真的改数据，先想清楚</span>
          </div>
        </div>

        <div className="db-result">
          {err && (
            <div className="connect-error db-err">
              <b>{err.message}</b>
              {err.detail && <small>{err.detail}</small>}
            </div>
          )}
          {result && result.columns.length === 0 && (
            <p className="db-msg">
              执行完了{result.affected !== null ? `，影响 ${result.affected} 行` : ""} · {result.elapsedMs} ms
            </p>
          )}
          {result && result.columns.length > 0 && (
            <>
              <p className="db-msg">
                {result.rows.length} 行{result.truncated ? `（到 ${limit} 行上限就停了，后面还有）` : ""} · {result.columns.length} 列 · {result.elapsedMs} ms
              </p>
              <div className="db-grid-wrap">
                <table className="st-table db-grid">
                  <thead>
                    <tr>
                      <th className="db-rownum">#</th>
                      {result.columns.map((c, i) => <th key={`${i}-${c}`}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, r) => (
                      <tr key={r}>
                        <td className="db-rownum">{r + 1}</td>
                        {row.map((cell, c) => (
                          <td key={c} title={cell ?? "NULL"}>
                            {cell === null ? <i className="db-null">NULL</i> : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!result && !err && <p className="page-hint db-empty">结果在这儿显示。</p>}
        </div>
      </div>
    </div>
  );
}

// ---------- Redis ----------

function RedisConsole({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RedisKey[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [peek, setPeek] = useState<RedisPeek | null>(null);
  const [peekErr, setPeekErr] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [log, setLog] = useState<{ cmd: string; out: unknown; err?: string; ms: number }[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histAt, setHistAt] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const scan = useCallback(async (fresh: boolean) => {
    if (scanning) return;
    setScanning(true);
    setScanErr(null);
    try {
      const got = await invoke<RedisScan>("redis_scan", { sessionId, pattern, cursor: fresh ? 0 : cursor ?? 0, count: 200 });
      if (!live.current) return;
      setKeys((old) => (fresh ? got.keys : [...old, ...got.keys]));
      setCursor(got.cursor === 0 ? null : got.cursor);
    } catch (e) {
      if (live.current) setScanErr(errOf(e).message);
    } finally {
      if (live.current) setScanning(false);
    }
  }, [scanning, sessionId, pattern, cursor]);
  useEffect(() => { void scan(true); /* 首次 */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const look = useCallback(async (key: string) => {
    setPicked(key);
    setPeekErr(null);
    try {
      const got = await invoke<RedisPeek>("redis_peek", { sessionId, key });
      if (live.current) setPeek(got);
    } catch (e) {
      if (live.current) { setPeek(null); setPeekErr(errOf(e).message); }
    }
  }, [sessionId]);

  const runLine = useCallback(async (text?: string) => {
    const cmd = (text ?? line).trim();
    if (!cmd || running) return;
    const args = splitArgs(cmd);
    if (args.length === 0) return;
    setRunning(true);
    const started = Date.now();
    try {
      const out = await invoke<unknown>("redis_command", { sessionId, args });
      if (!live.current) return;
      setLog((old) => [{ cmd, out, ms: Date.now() - started }, ...old].slice(0, 50));
      // 改了 key 的话让左边和预览跟上
      if (picked && args.slice(1).includes(picked)) void look(picked);
    } catch (e) {
      if (live.current) setLog((old) => [{ cmd, out: null, err: errOf(e).message, ms: Date.now() - started }, ...old].slice(0, 50));
    } finally {
      if (live.current) {
        setRunning(false);
        setHistory((old) => [cmd, ...old.filter((one) => one !== cmd)].slice(0, 50));
        setHistAt(-1);
        setLine("");
      }
    }
  }, [line, running, sessionId, picked, look]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void runLine(); return; }
    if (e.key === "ArrowUp" && history.length > 0) {
      e.preventDefault();
      const next = Math.min(histAt + 1, history.length - 1);
      setHistAt(next);
      setLine(history[next]);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(histAt - 1, -1);
      setHistAt(next);
      setLine(next < 0 ? "" : history[next]);
    }
  };

  useEffect(() => { if (active) input.current?.focus(); }, [active]);

  return (
    <div className="db-body">
      <aside className="db-tree redis-keys">
        <div className="db-tree-head">
          <input
            value={pattern}
            spellCheck={false}
            placeholder="key 的模式，比如 user:*"
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void scan(true); }}
          />
          <button className="icon-btn sm" type="button" title="扫一遍" disabled={scanning} onClick={() => void scan(true)}><IconRefresh size={13} /></button>
        </div>
        {scanErr && <p className="st-err">{scanErr}</p>}
        <ul className="redis-list">
          {keys.map((one) => (
            <li key={one.key}>
              <button type="button" className={`redis-key ${picked === one.key ? "on" : ""}`} title={one.key} onClick={() => void look(one.key)}>
                <i className={`kind-badge ${one.kind}`}>{one.kind}</i>
                <span>{one.key}</span>
                <small>{fmtTtl(one.ttl)}</small>
              </button>
            </li>
          ))}
        </ul>
        {keys.length === 0 && !scanning && !scanErr && <p className="page-hint">没扫到 key。</p>}
        {cursor !== null && (
          <button className="btn-ghost sm db-more" type="button" disabled={scanning} onClick={() => void scan(false)}>
            {scanning ? "扫着呢……" : "继续扫"}
          </button>
        )}
      </aside>

      <div className="db-main">
        {picked && (
          <div className="redis-peek">
            <header>
              <b>{picked}</b>
              {peek && <span className="kind-badge">{peek.kind}</span>}
              {peek && <small>{fmtTtl(peek.ttl)} · {peek.kind === "string" ? `${peek.len} 字节` : `${peek.len} 项`}{peek.truncated ? "（只显示前面一部分）" : ""}</small>}
              <span className="foot-spacer" />
              <button className="icon-btn sm" type="button" title="刷新" onClick={() => void look(picked)}><IconRefresh size={13} /></button>
              <button className="icon-btn sm" type="button" title="关掉预览" onClick={() => { setPicked(null); setPeek(null); }}><IconX size={13} /></button>
            </header>
            {peekErr && <p className="st-err">{peekErr}</p>}
            {peek && <RedisValue kind={peek.kind} value={peek.value} />}
          </div>
        )}

        <div className="redis-cli">
          <div className="redis-input">
            <span className="redis-prompt">&gt;</span>
            <input
              ref={input}
              value={line}
              spellCheck={false}
              placeholder="敲 Redis 命令，比如 GET user:1 · ↑↓ 翻历史"
              onChange={(e) => { setLine(e.target.value); setHistAt(-1); }}
              onKeyDown={onKey}
            />
            <button className="btn-primary sm" type="button" disabled={running || !line.trim()} onClick={() => void runLine()}>
              <IconPlay size={13} />执行
            </button>
          </div>
          <div className="redis-log">
            {log.length === 0 && <p className="page-hint">输出在这儿显示。左边点一个 key 能看内容。</p>}
            {log.map((one, i) => (
              <div className={`redis-entry ${one.err ? "bad" : ""}`} key={`${i}-${one.cmd}`}>
                <div className="redis-entry-cmd"><code>&gt; {one.cmd}</code><small>{one.ms} ms</small></div>
                {one.err ? <pre className="redis-out bad">{one.err}</pre> : <pre className="redis-out">{JSON.stringify(one.out, null, 2)}</pre>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 按类型把 key 的内容摆出来：hash / zset 两列表，list / set 一列，string 原文 */
function RedisValue({ kind, value }: { kind: string; value: unknown }) {
  if (kind === "string") return <pre className="redis-out">{String(value ?? "")}</pre>;
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  if (kind === "hash" || kind === "zset") {
    const pairs: [unknown, unknown][] = [];
    for (let i = 0; i + 1 < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
    return (
      <div className="db-grid-wrap">
        <table className="st-table db-grid">
          <thead><tr><th>{kind === "hash" ? "字段" : "成员"}</th><th>{kind === "hash" ? "值" : "分数"}</th></tr></thead>
          <tbody>{pairs.map(([k, v], i) => <tr key={i}><td>{String(k)}</td><td>{String(v)}</td></tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (kind === "list" || kind === "set") {
    return (
      <div className="db-grid-wrap">
        <table className="st-table db-grid">
          <thead><tr><th className="db-rownum">#</th><th>值</th></tr></thead>
          <tbody>{list.map((v, i) => <tr key={i}><td className="db-rownum">{i}</td><td>{String(v)}</td></tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <pre className="redis-out">{JSON.stringify(value, null, 2)}</pre>;
}
