import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconDatabase, IconLock, IconStar, IconTrash, IconX } from "../components/icons";
import { newId } from "../store";
import { stashSecret } from "../secrets";
import { COLORS, DB_KINDS, DEFAULT_GROUP, type DbConn, type DbKind } from "../types";

interface DbPageProps {
  /** null = 新建 */
  db: DbConn | null;
  /** 嵌在数据库标签里（有自己的工具条），还是独立的新建页 */
  embedded?: boolean;
  onSave: (db: DbConn, connect: boolean) => void;
  /** 已有连接页上填了密码：交给上层去连（不落盘） */
  onSecret?: (secret: string, remember: boolean) => void;
  onDelete?: (db: DbConn) => void;
  onDirtyChange: (dirty: boolean) => void;
  onClose?: () => void;
}

const same = (a: DbConn, b: DbConn) =>
  a.kind === b.kind && a.name === b.name && a.host === b.host && a.port === b.port && a.username === b.username &&
  (a.database ?? "") === (b.database ?? "") && a.color === b.color && a.group === b.group;

/**
 * 数据库连接的配置页：新建时独立成一个标签，已有的嵌在数据库标签的「配置」页里。
 * 密码不进这条记录，跟 SSH 一个规矩：新建的先搁内存等标签来取，已有的直接递给上面那条连接。
 */
export function DbPage({ db, embedded, onSave, onSecret, onDelete, onDirtyChange, onClose }: DbPageProps) {
  const [kind, setKind] = useState<DbKind>(db?.kind ?? "mysql");
  const [name, setName] = useState(db?.name ?? "");
  const [host, setHost] = useState(db?.host ?? "127.0.0.1");
  const [port, setPort] = useState(db?.port ?? 3306);
  const [username, setUsername] = useState(db?.username ?? "root");
  const [database, setDatabase] = useState(db?.database ?? "");
  const [group, setGroup] = useState(db?.group ?? DEFAULT_GROUP);
  const [color, setColor] = useState(db?.color ?? COLORS[0]);
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const [saved, setSaved] = useState<boolean | null>(db ? null : false);
  const [checked, setChecked] = useState(false);
  const [handed, setHanded] = useState(false);

  useEffect(() => {
    if (!db) { setSaved(false); return; }
    invoke<boolean>("creds_has", { connId: db.id }).then(setSaved).catch(() => setSaved(false));
  }, [db]);

  const meta = DB_KINDS.find((one) => one.value === kind) ?? DB_KINDS[0];

  /** 换类型时把端口、用户名换成那家的默认值 —— 前提是用户没自己改过 */
  const changeKind = (next: DbKind) => {
    const before = DB_KINDS.find((one) => one.value === kind) ?? DB_KINDS[0];
    const after = DB_KINDS.find((one) => one.value === next) ?? DB_KINDS[0];
    if (port === before.port) setPort(after.port);
    if (username === before.user) setUsername(after.user);
    setKind(next);
  };

  const draft: DbConn = {
    id: db?.id ?? "",
    kind,
    name: name.trim() || `${meta.label} · ${host.trim()}`,
    host: host.trim(),
    port: Number(port) || meta.port,
    username: username.trim(),
    database: database.trim() || undefined,
    color,
    group: group.trim() || DEFAULT_GROUP,
    createdAt: db?.createdAt ?? Date.now(),
    lastUsedAt: db?.lastUsedAt,
  };

  const missHost = host.trim() === "";
  const badPort = !Number.isInteger(port) || port < 1 || port > 65535;
  const badDbIndex = kind === "redis" && database.trim() !== "" && !/^\d{1,2}$/.test(database.trim());
  const valid = !missHost && !badPort && !badDbIndex;
  const dirty = db ? !same(draft, db) || secret !== "" : valid;
  useEffect(() => { onDirtyChange(db ? dirty : false); }, [db, dirty, onDirtyChange]);

  const save = (connect = false) => {
    setChecked(true);
    if (!valid) return;
    if (!dirty && !connect) return;
    const next: DbConn = { ...draft, id: db?.id ?? newId() };
    if (db) {
      if (secret) { onSecret?.(secret, remember); setHanded(true); }
    } else {
      stashSecret(next.id, { secret, remember });
    }
    setSecret("");
    onSave(next, connect);
    setChecked(false);
  };

  const forget = async () => {
    if (!db) return;
    await invoke("creds_forget", { connId: db.id }).catch(() => {});
    setSaved(false);
  };

  return (
    <div className="page">
      {!embedded && (
        <div className="page-head">
          <span className="status-dot" style={{ background: color }} />
          <h2>新建数据库连接</h2>
          <span className="page-sub">填主机和账号就行，密码可以等连接时再输</span>
          <span className="foot-spacer" />
          <button className="btn-ghost sm" type="button" onClick={() => save(false)}>只创建</button>
          <button className="btn-primary sm" type="button" onClick={() => save(true)}>创建并连接</button>
          {onClose && (
            <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭"><IconX size={16} /></button>
          )}
        </div>
      )}
      {embedded && db && (
        <div className="page-actions">
          <span className="page-sub">改完记得保存，保存前不影响正在跑的连接。</span>
          <span className="foot-spacer" />
          {onDelete && (
            <button className="btn-ghost sm danger" type="button" onClick={() => onDelete(db)}><IconTrash size={13} />删除</button>
          )}
          <button className="btn-primary sm" type="button" disabled={!dirty} onClick={() => save(false)}>{dirty ? "保存" : "已保存"}</button>
        </div>
      )}

      <div className="page-body">
        {checked && !valid && (
          <p className="page-warn">
            <IconLock size={13} />
            {missHost ? "主机还空着" : badPort ? "端口得在 1 到 65535 之间" : "Redis 的库是 0 到 15 的编号"}
          </p>
        )}

        <div className="page-cols">
          <div className="page-col">
            <section className="page-card">
              <h3><IconDatabase size={14} />基本</h3>
              <div className="form-grid">
                <label className="field span2">
                  <span>类型</span>
                  <div className="seg">
                    {DB_KINDS.map((one) => (
                      <button key={one.value} type="button" className={kind === one.value ? "on" : ""} onClick={() => changeKind(one.value)}>
                        {one.label}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="field">
                  <span>名称</span>
                  <input value={name} placeholder={`留空就叫「${meta.label} · 主机」`} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span>分组</span>
                  <input value={group} placeholder={DEFAULT_GROUP} onChange={(e) => setGroup(e.target.value)} />
                </label>
                <label className={`field ${checked && missHost ? "bad" : ""}`}>
                  <span>主机</span>
                  <input value={host} placeholder="127.0.0.1 或 db.example.com" onChange={(e) => setHost(e.target.value)} />
                  {checked && missHost && <em className="field-err">这个必填</em>}
                </label>
                <label className={`field ${checked && badPort ? "bad" : ""}`}>
                  <span>端口</span>
                  <input type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>{kind === "redis" ? "用户名（ACL，一般留空）" : "用户名"}</span>
                  <input value={username} placeholder={meta.user || "留空"} onChange={(e) => setUsername(e.target.value)} />
                </label>
                <label className={`field ${checked && badDbIndex ? "bad" : ""}`}>
                  <span>{kind === "redis" ? "库编号" : kind === "postgres" ? "数据库（必填，PG 连的时候就要指定）" : "默认库（可留空）"}</span>
                  <input
                    value={database}
                    placeholder={kind === "redis" ? "0" : kind === "postgres" ? "留空按用户名" : "留空进去再 USE"}
                    onChange={(e) => setDatabase(e.target.value)}
                  />
                </label>
              </div>
              <em className="field-hint">
                库只对内网开放的话（云上的 MySQL / Redis 大多如此）：先到那台服务器的会话标签 → 隧道页开一条<b>本地转发</b>
                指到库的地址，这儿主机填 127.0.0.1、端口填转发的本地端口。自动开隧道下一步再做。
              </em>
            </section>

            <section className="page-card">
              <h3><IconStar size={14} />外观</h3>
              <div className="row-between">
                <div className="label"><b>标签色</b><small>侧栏和标签上的小圆点</small></div>
                <div className="color-row">
                  {COLORS.map((one) => (
                    <button key={one} type="button" className={`color-dot ${color === one ? "on" : ""}`} style={{ background: one }} onClick={() => setColor(one)} aria-label={one} />
                  ))}
                </div>
              </div>
            </section>
          </div>

          <div className="page-col">
            <section className="page-card">
              <h3><IconLock size={14} />密码</h3>
              {saved && !secret && !handed ? (
                <div className="row-between">
                  <div className="label"><b>已经记在系统钥匙串里</b><small>想换一条就在下面填新的</small></div>
                  <button className="btn-ghost sm" type="button" onClick={forget}>忘掉</button>
                </div>
              ) : null}
              <label className="field">
                <span>{kind === "redis" ? "密码（requirepass / ACL，没设就留空）" : "密码"}</span>
                <div className="pw-input">
                  <IconLock size={15} />
                  <input
                    type="password"
                    value={secret}
                    autoComplete="off"
                    placeholder={handed ? "已交给上面那条连接" : "现在填，或者留到连接时再输"}
                    onChange={(e) => { setSecret(e.target.value); setHanded(false); }}
                  />
                </div>
              </label>
              <label className="check-row" title="存进系统钥匙串（Windows 凭据管理器 / macOS 钥匙串）">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>连上之后记住它，下次直接连</span>
              </label>
              <em className="field-hint">密码不写进配置文件，也不进备份。认证成功了才存钥匙串，打错的不会被记住。</em>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
