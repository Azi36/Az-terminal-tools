import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { IconCheck, IconKey, IconLock, IconServer, IconStar, IconTrash, IconX } from "../components/icons";
import { fmtWhen } from "../format";
import { stashSecret } from "../secrets";
import { loadBookmarks, loadConnections, newId } from "../store";
import {
  COLORS,
  DEFAULT_ENCODING,
  DEFAULT_GROUP,
  DEFAULT_USER,
  ENCODINGS,
  PROTOCOLS,
  type AuthType,
  type Connection,
  type Protocol,
} from "../types";

export type ConnStatus = "live" | "down" | "idle";

interface ConnectionPageProps {
  /** null = 新建 */
  conn: Connection | null;
  status: ConnStatus;
  /** 嵌在会话标签里时不画自己的标题栏 —— 上面已经有会话栏了 */
  embedded?: boolean;
  /** connect=true：存完直接去连（新建页的「创建并连接」） */
  onSave: (conn: Connection, connect?: boolean) => void;
  /** 嵌在会话里时，这一页填的密码直接递给那条会话用，不走内存暂存 */
  onSecret?: (secret: string, remember: boolean) => void;
  onDelete: (conn: Connection) => void;
  onDirtyChange: (dirty: boolean) => void;
  onClose?: () => void;
}

/** 只比对真正属于「配置」的字段，别把 lastUsedAt 这种运行时数据算进改动里 */
function sameConfig(a: Connection, b: Connection): boolean {
  return (
    a.name === b.name &&
    a.protocol === b.protocol &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.authType === b.authType &&
    (a.keyPath ?? "") === (b.keyPath ?? "") &&
    a.group === b.group &&
    a.color === b.color &&
    (a.encoding || DEFAULT_ENCODING) === (b.encoding || DEFAULT_ENCODING) &&
    (a.jumpId ?? "") === (b.jumpId ?? "") &&
    !!a.pinned === !!b.pinned
  );
}

/**
 * 连接配置：会话标签里的第三个页签（终端 / 文件 / 配置），
 * 新建连接时也用这一套，独立成一个标签页。
 */
export function ConnectionPage({ conn, status, embedded, onSave, onSecret, onDelete, onDirtyChange, onClose }: ConnectionPageProps) {
  const [name, setName] = useState(conn?.name ?? "");
  const [protocol, setProtocol] = useState<Protocol>(conn?.protocol ?? "ssh");
  const [host, setHost] = useState(conn?.host ?? "");
  const [port, setPort] = useState(conn?.port ?? 22);
  const [username, setUsername] = useState(conn?.username ?? "");
  const [authType, setAuthType] = useState<AuthType>(conn?.authType ?? "password");
  const [keyPath, setKeyPath] = useState(conn?.keyPath ?? "");
  const [group, setGroup] = useState(conn?.group ?? DEFAULT_GROUP);
  const [color, setColor] = useState(conn?.color ?? COLORS[0]);
  const [encoding, setEncoding] = useState(conn?.encoding || DEFAULT_ENCODING);
  const [jumpId, setJumpId] = useState(conn?.jumpId ?? "");
  const [pinned, setPinned] = useState(!!conn?.pinned);
  /** 顺手填的密码 / 密码短语；不填就留到连接时再问 */
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(true);
  /** 已经记过密码，想换一条才展开输入框 */
  const [replacing, setReplacing] = useState(false);
  /** 密码已经交给上面那条会话了 —— 输入框清空之后得有个交代 */
  const [handed, setHanded] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(conn ? null : false);
  /** 点过保存 / 创建之后才开始红字提示，别一进来就骂人 */
  const [checked, setChecked] = useState(false);
  const hostRef = useRef<HTMLInputElement>(null);

  const marks = useMemo(() => (conn ? loadBookmarks().filter((one) => one.scope === conn.id) : []), [conn]);

  // 能当跳板机的：除了自己，还得排掉「把自己当跳板」绕回来的那些
  const others = useMemo(
    () => loadConnections().filter((one) => one.id !== conn?.id && one.jumpId !== conn?.id && one.protocol !== "ftp"),
    [conn?.id],
  );

  useEffect(() => {
    if (!conn) { setSaved(false); return; }
    invoke<boolean>("creds_has", { connId: conn.id }).then(setSaved).catch(() => setSaved(false));
  }, [conn]);

  const draft: Connection = {
    id: conn?.id ?? "",
    name: name.trim() || host.trim(),
    protocol,
    host: host.trim(),
    port: Number(port) || 22,
    username: username.trim() || DEFAULT_USER,
    authType,
    keyPath: authType === "key" ? keyPath.trim() : undefined,
    group: group.trim() || DEFAULT_GROUP,
    color,
    encoding,
    jumpId: jumpId || undefined,
    tunnels: conn?.tunnels,
    pinned,
    createdAt: conn?.createdAt ?? Date.now(),
    lastUsedAt: conn?.lastUsedAt,
  };

  // 必填就一个主机 —— 用户名有默认值，密码可以等连接时再问。
  // 端口和私钥路径在这儿就拦：端口 70000 存进去，连接时报的是 invoke 参数错误，看不懂
  const missHost = host.trim() === "";
  const badPort = !Number.isInteger(port) || port < 1 || port > 65535;
  const missKey = authType === "key" && keyPath.trim() === "";
  const valid = !missHost && !badPort && !missKey;
  // 这一页填了密码也算「有没存的东西」，关标签前该拦一下
  const dirty = conn ? !sameConfig(draft, conn) || secret !== "" : valid;

  // 新建那页还没存进库，关掉不用拦；改已有连接才值得问一句
  useEffect(() => { onDirtyChange(conn ? dirty : false); }, [conn, dirty, onDirtyChange]);

  const changeProtocol = (next: Protocol) => {
    setProtocol(next);
    // 端口跟着协议默认值走（除非用户已经改成别的了）
    const prev = PROTOCOLS.find((p) => p.value === protocol)?.defaultPort;
    const nextPort = PROTOCOLS.find((p) => p.value === next)?.defaultPort ?? 22;
    if (port === prev) setPort(nextPort);
  };

  /** 缺东西就在页面里红字指出来并把光标送过去，不弹窗 */
  const save = (connect = false) => {
    setChecked(true);
    if (!valid) { if (missHost) hostRef.current?.focus(); return; }
    if (!dirty && !connect) return;
    // 留空的用户名在这儿落成 root，让人看得见存下去的到底是什么
    if (username.trim() !== draft.username) setUsername(draft.username);
    const next: Connection = { ...draft, id: conn?.id ?? newId() };
    // 密码不写进这条记录，也不直接写钥匙串（认证过了才存，见 secrets.ts）：
    // 新建的先搁内存里等会话来取，已有的直接递给上面那条会话。
    if (conn) {
      if (secret) { onSecret?.(secret, remember); setHanded(true); }
    } else {
      stashSecret(next.id, { secret, remember });
    }
    setSecret("");
    setReplacing(false);
    onSave(next, connect);
    setChecked(false);
  };

  /** 换认证方式：密码和密码短语不是一回事，别把上一种填的带过去 */
  const changeAuth = (next: AuthType) => {
    if (next === authType) return;
    setAuthType(next);
    setSecret("");
  };

  /** 私钥路径别让人手敲，开系统文件对话框挑 */
  const pickKey = async () => {
    const picked = await open({
      title: "选私钥文件",
      multiple: false,
      // 私钥多半没扩展名，过滤器给个「所有文件」兜底
      filters: [
        { name: "私钥", extensions: ["pem", "key", "ppk"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    }).catch(() => null);
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) setKeyPath(path);
  };

  /** 没记过密码、或者主动要换一条时，才在这儿摆输入框 */
  const showSecret = saved === false || replacing;
  const isKey = authType === "key";
  const label = isKey ? "密码短语" : "密码";

  const forget = async () => {
    if (!conn) return;
    await invoke("creds_forget", { connId: conn.id }).catch(() => {});
    setSaved(false);
  };

  return (
    <div className="page">
      {!embedded && (
        <header className="page-head">
          <span className={`status-dot lg ${status}`} style={status === "idle" ? { background: color } : undefined} />
          <h2>{conn ? name || conn.name : "新建连接"}</h2>
          <span className="page-sub">
            {conn ? `${draft.username}@${host}:${port}` : "填个主机就能创建，其余留空按默认来"}
          </span>
          <span className="foot-spacer" />
          {conn ? (
            <button className="btn-primary sm" type="button" disabled={!dirty} onClick={() => save()}>
              {dirty ? "保存" : "已保存"}
            </button>
          ) : (
            <>
              {/* 建完多半就是要连的，让它当主按钮；只想存一条的走旁边那个 */}
              <button className="btn-ghost sm" type="button" onClick={() => save()}>只创建</button>
              <button className="btn-primary sm" type="button" onClick={() => save(true)}>创建并连接</button>
            </>
          )}
          {onClose && (
            <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭标签">
              <IconX size={15} />
            </button>
          )}
        </header>
      )}

      <div className="page-body">
        {embedded && (
          <div className="page-actions">
            <span className="page-meta">改完记得保存，保存前不影响正在跑的会话。</span>
            <span className="foot-spacer" />
            <button className="btn-primary sm" type="button" disabled={!dirty} onClick={() => save()}>
              {dirty ? "保存" : "已保存"}
            </button>
          </div>
        )}

        {checked && !valid && (
          <p className="page-warn">
            <IconLock size={13} />
            {missHost ? "主机还空着 —— 填个 IP 或者域名" : badPort ? "端口得在 1 到 65535 之间" : "选了密钥登录，私钥文件还没指"}
          </p>
        )}

        <div className="page-cols">
        <div className="page-col">
        <section className="page-card">
          <h3><IconServer size={14} />基本{!conn && <em>只有主机必填</em>}</h3>
          <div className="form-grid">
            <label className="field">
              <span>名称</span>
              <input value={name} placeholder="留空就用主机地址" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>分组</span>
              <input value={group} placeholder={DEFAULT_GROUP} onChange={(e) => setGroup(e.target.value)} />
            </label>
            <label className="field span2">
              <span>协议</span>
              <div className="seg">
                {PROTOCOLS.map((one) => (
                  <button
                    key={one.value}
                    type="button"
                    className={protocol === one.value ? "on" : ""}
                    // 还没做的协议不让选，省得存了一条连不上的连接
                    disabled={one.soon && protocol !== one.value}
                    title={one.soon ? "还没接上引擎，先用 SFTP" : one.label}
                    onClick={() => changeProtocol(one.value)}
                  >
                    {one.label}{one.soon && <i className="soon-tag">待做</i>}
                  </button>
                ))}
              </div>
            </label>
            <label className={`field ${checked && missHost ? "bad" : ""}`}>
              <span>主机</span>
              <input
                ref={hostRef}
                value={host}
                placeholder="192.168.1.10 或 example.com"
                onChange={(e) => setHost(e.target.value)}
              />
              {checked && missHost && <em className="field-err">这个必填</em>}
            </label>
            <label className={`field ${checked && badPort ? "bad" : ""}`}>
              <span>端口</span>
              <input type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
              {checked && badPort && <em className="field-err">1 到 65535</em>}
            </label>
            <label className="field span2">
              <span>用户名</span>
              <input
                value={username}
                placeholder={DEFAULT_USER}
                onChange={(e) => setUsername(e.target.value)}
                // 离开输入框就把默认值落进去，省得人对着空框猜到底按什么连
                onBlur={() => setUsername((one) => one.trim() || DEFAULT_USER)}
              />
              <em className="field-hint">留空按 {DEFAULT_USER} 连。</em>
            </label>
            <label className="field span2">
              <span>字符编码</span>
              <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                {ENCODINGS.map((one) => (
                  <option key={one.value} value={one.value}>{one.label}</option>
                ))}
              </select>
              <em className="field-hint">
                终端和这台机器上的文件都按它解。看到一屏乱码就换成 GBK —— 连着也能在终端右上角当场换。
              </em>
            </label>
          </div>
        </section>

        <section className="page-card">
          <h3><IconStar size={14} />外观与排序</h3>
          <div className="card-rows">
            <div className="row-between">
              <div className="label">
                <b>标签色</b>
                <small>没连上时侧栏小圆点用这个色</small>
              </div>
              <div className="color-picker">
                {COLORS.map((one) => (
                  <button
                    key={one}
                    type="button"
                    className={color === one ? "on" : ""}
                    style={{ background: one }}
                    onClick={() => setColor(one)}
                    aria-label={`颜色 ${one}`}
                  />
                ))}
              </div>
            </div>
            <div className="row-between">
              <div className="label">
                <b>置顶</b>
                <small>钉在侧栏最前面，不跟着最近使用往下掉</small>
              </div>
              <button className={`pin-btn ${pinned ? "on" : ""}`} type="button" onClick={() => setPinned(!pinned)}>
                <IconStar size={14} />{pinned ? "已置顶" : "置顶"}
              </button>
            </div>
            {conn && (
              <p className="page-meta">
                建于 {fmtWhen(conn.createdAt)}
                {conn.lastUsedAt ? ` · 上次连接 ${fmtWhen(conn.lastUsedAt)}` : " · 还没连过"}
                {marks.length ? ` · ${marks.length} 个收藏目录` : ""}
              </p>
            )}
          </div>
        </section>
        </div>

        <div className="page-col">
        <section className="page-card">
          <h3><IconKey size={14} />认证</h3>
          <div className="form-grid">
            <label className="field span2">
              <span>方式</span>
              <div className="seg">
                <button type="button" className={!isKey ? "on" : ""} onClick={() => changeAuth("password")}>
                  <IconLock size={14} />密码
                </button>
                <button type="button" className={isKey ? "on" : ""} onClick={() => changeAuth("key")}>
                  <IconKey size={14} />密钥
                </button>
              </div>
            </label>
            {isKey && (
              <label className="field span2">
                <span>私钥文件</span>
                <div className="field-row">
                  <input
                    className="grow"
                    value={keyPath}
                    placeholder="C:\Users\你\.ssh\id_ed25519"
                    onChange={(e) => setKeyPath(e.target.value)}
                  />
                  <button className="btn-ghost sm" type="button" onClick={pickKey}>浏览…</button>
                </div>
                {checked && missKey && <em className="field-err">这个必填</em>}
                <em className="field-hint">选私钥（id_ed25519 / id_rsa），不是 .pub 那个公钥文件。</em>
              </label>
            )}

            {/* 想现在填就现在填，不填就留到连接时那张卡上 —— 两处是同一件事，别逼人选时机 */}
            {showSecret && (
              <div className="field span2 auth-secret">
                <label className="field">
                  <span>{isKey ? "密码短语" : "密码"}</span>
                  <input
                    type="password"
                    value={secret}
                    autoComplete="off"
                    placeholder={isKey ? "私钥没设密码短语就留空" : "现在填，或者留到连接时再输"}
                    onChange={(e) => { setSecret(e.target.value); setHanded(false); }}
                  />
                </label>
                <label className="check-row" title="存进系统钥匙串（Windows 凭据管理器 / macOS 钥匙串）">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span>连上之后记住它，下次直接连</span>
                </label>
                <em className="field-hint">
                  {handed
                    ? `${label}已经交给这条会话 —— 回终端页点「连接」就用它，连上了才存进钥匙串。`
                    : replacing
                      ? "新的这条要等连上了才替换掉钥匙串里那条，连不上不动它。"
                      : secret
                        ? "认证过了才写进系统钥匙串 —— 打错的密码不会被记一辈子，我们自己的文件里也没有明文。"
                        : "留空照样能存这条连接；第一次连的时候会在连接卡上问一次，那儿也有这个勾。"}
                </em>
                {replacing && (
                  <button type="button" className="link-quiet" onClick={() => { setSecret(""); setReplacing(false); }}>
                    算了，还用钥匙串里那条
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 钥匙串里已经有一条了，就不摆输入框，只报个状态 */}
          {!showSecret && (
            <div className={`info-creds ${saved ? "on" : ""}`}>
              {saved ? <IconCheck size={14} /> : <IconLock size={14} />}
              <span>{saved === null ? "查钥匙串……" : `已记住${label}，开标签直接连`}</span>
              {saved && (
                <>
                  <button type="button" className="link-quiet" onClick={() => setReplacing(true)}>换一条</button>
                  <button type="button" className="link-danger" onClick={forget}>忘掉</button>
                </>
              )}
            </div>
          )}

          <div className="form-grid">
            <label className="field span2">
              <span>跳板机</span>
              <select value={jumpId} onChange={(e) => setJumpId(e.target.value)}>
                <option value="">不用，直连</option>
                {others.map((one) => (
                  <option key={one.id} value={one.id}>{one.name} · {one.username}@{one.host}</option>
                ))}
              </select>
              <em className="field-hint">
                先连跳板机、再从它连到这台（相当于 ssh 的 ProxyJump）。
                跳板机的密码要先存进钥匙串 —— 在它自己的配置页里填一次，或者单独连一次那台机器并勾上「记住」。
              </em>
            </label>
          </div>

        </section>

        {conn ? (
          <section className="page-card danger-zone">
            <h3><IconTrash size={14} />危险区</h3>
            <div className="row-between">
              <div className="label">
                <b>删除这条连接</b>
                <small>只删本机这条记录，服务器上什么都不动</small>
              </div>
              <button className="btn-ghost danger" type="button" onClick={() => onDelete(conn)}>
                <IconTrash size={14} /> 删除
              </button>
            </div>
          </section>
        ) : (
          <p className="page-hint">填好主机就能创建，其他都能以后再改。</p>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}
