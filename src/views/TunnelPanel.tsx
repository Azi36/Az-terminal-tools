import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IconEdit, IconPlay, IconPlus, IconTrash, IconX } from "../components/icons";
import { newId } from "../store";
import { TUNNEL_KINDS, type Tunnel, type TunnelKind } from "../types";

interface TunnelPanelProps {
  /** 连着的会话 id；没连上就是 null，隧道只能看不能开 */
  sessionId: string | null;
  tunnels: Tunnel[];
  onChange: (tunnels: Tunnel[]) => void;
  onActivity?: () => void;
}

interface Live {
  /** 开着没有 */
  on: boolean;
  /** 此刻挂着几条连接 */
  active: number;
  error?: string;
}

const blank = (): Tunnel => ({
  id: newId(),
  kind: "local",
  listenHost: "127.0.0.1",
  listenPort: 8080,
  destHost: "127.0.0.1",
  destPort: 80,
});

/** 一条隧道念出来是什么意思，用大白话写在旁边 */
function explain(one: Tunnel): string {
  if (one.kind === "socks") {
    return `浏览器代理填 socks5://${one.listenHost}:${one.listenPort}，之后的流量从这台服务器出去`;
  }
  if (one.kind === "remote") {
    return `在服务器上访问 ${one.listenHost}:${one.listenPort}，等于访问你本机的 ${one.destHost}:${one.destPort}`;
  }
  return `在本机访问 ${one.listenHost}:${one.listenPort}，等于服务器访问 ${one.destHost}:${one.destPort}`;
}

/**
 * 端口转发面板。
 * 配置存在这条连接上，开关跟着当前会话走 —— 断开就全停，重连要自己再开
 * （标了「自动」的除外）。
 */
export function TunnelPanel({ sessionId, tunnels, onChange, onActivity }: TunnelPanelProps) {
  const [live, setLive] = useState<Record<string, Live>>({});
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const beat = useRef(onActivity);
  beat.current = onActivity;

  // 引擎那边的状态变化：开了、停了、连接数变了
  useEffect(() => {
    if (!sessionId) { setLive({}); return; }
    let un: UnlistenFn | undefined;
    listen<{ sessionId: string; id: string; state: string; active: number; message?: string }>(
      "tunnel://state",
      (event) => {
        const p = event.payload;
        if (p.sessionId !== sessionId) return;
        setLive((old) => ({
          ...old,
          [p.id]: {
            on: p.state !== "closed" && p.state !== "error",
            active: p.active,
            error: p.state === "error" ? p.message ?? "出错了" : undefined,
          },
        }));
      },
    ).then((fn) => (un = fn));
    return () => un?.();
  }, [sessionId]);

  // 换了会话（比如重连）→ 问一遍引擎现在到底开着哪些，别让界面显示得比实际乐观
  useEffect(() => {
    if (!sessionId) return;
    invoke<{ id: string; active: number }[]>("tunnel_list", { sessionId })
      .then((list) => {
        const map: Record<string, Live> = {};
        for (const one of list) map[one.id] = { on: true, active: one.active };
        setLive(map);
      })
      .catch(() => {});
  }, [sessionId]);

  const start = useCallback(async (one: Tunnel) => {
    if (!sessionId) return;
    setErr(null);
    beat.current?.();
    try {
      await invoke("tunnel_open", {
        sessionId,
        spec: {
          id: one.id,
          kind: one.kind,
          listenHost: one.listenHost || "127.0.0.1",
          listenPort: one.listenPort,
          destHost: one.destHost,
          destPort: one.destPort,
        },
      });
      setLive((old) => ({ ...old, [one.id]: { on: true, active: 0 } }));
    } catch (e) {
      const text = e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);
      setErr(text);
      setLive((old) => ({ ...old, [one.id]: { on: false, active: 0, error: text } }));
    }
  }, [sessionId]);

  const stop = async (one: Tunnel) => {
    await invoke("tunnel_close", { id: one.id }).catch(() => {});
    setLive((old) => ({ ...old, [one.id]: { on: false, active: 0 } }));
  };

  // 标了「自动」的，一连上就起来
  const autoStarted = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || autoStarted.current === sessionId) return;
    autoStarted.current = sessionId;
    tunnels.filter((one) => one.auto).forEach((one) => void start(one));
  }, [sessionId, tunnels, start]);

  const save = (one: Tunnel) => {
    const rest = tunnels.filter((old) => old.id !== one.id);
    onChange([...rest, one]);
    setEditing(null);
  };

  const remove = (one: Tunnel) => {
    if (live[one.id]?.on) void stop(one);
    onChange(tunnels.filter((old) => old.id !== one.id));
  };

  return (
    <div className="page">
      <div className="page-body">
        <div className="page-stack">
          <section className="page-card">
            <h3>
              <IconPlay size={14} />端口转发
              <em className={sessionId ? "on" : "off"}>{sessionId ? "可用" : "先连上"}</em>
            </h3>

            <p className="page-meta">
              走的是终端那条已经认证过的连接，不用再登录一次。断开会话时全部自动收掉。
            </p>

            {err && <p className="data-note bad">{err}</p>}

            {tunnels.length === 0 ? (
              <p className="page-hint">还没配过。数据库只对服务器开放、内网后台进不去，就是它派用场的时候。</p>
            ) : (
              <div className="tun-list">
                {tunnels.map((one) => {
                  const state = live[one.id];
                  const running = !!state?.on;
                  const kind = TUNNEL_KINDS.find((k) => k.value === one.kind);
                  return (
                    <div className={`tun-row ${running ? "on" : ""}`} key={one.id}>
                      <span className={`status-dot ${running ? "live" : "idle"}`} />
                      <div className="tun-main">
                        <b>
                          {kind?.label}
                          <i className="tun-flag">{one.kind === "local" ? "-L" : one.kind === "socks" ? "-D" : "-R"}</i>
                          {one.auto && <i className="tun-auto">自动</i>}
                          {running && state.active > 0 && <i className="tun-count">{state.active} 条连接</i>}
                        </b>
                        <small>{explain(one)}</small>
                        {state?.error && <small className="tun-err">{state.error}</small>}
                      </div>
                      <div className="tun-acts">
                        <button
                          className={running ? "btn-ghost sm" : "btn-primary sm"}
                          type="button"
                          disabled={!sessionId}
                          onClick={() => (running ? void stop(one) : void start(one))}
                        >
                          {running ? "停" : "开"}
                        </button>
                        <button className="icon-btn sm" type="button" aria-label="改" title="改" onClick={() => setEditing(one)}>
                          <IconEdit size={14} />
                        </button>
                        <button className="icon-btn sm" type="button" aria-label="删" title="删掉这条" onClick={() => remove(one)}>
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="cfg-acts">
              <button className="btn-ghost sm" type="button" onClick={() => setEditing(blank())}>
                <IconPlus size={14} />加一条
              </button>
            </div>
          </section>
        </div>
      </div>

      {editing && (
        <TunnelForm
          initial={editing}
          isNew={!tunnels.some((one) => one.id === editing.id)}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface TunnelFormProps {
  initial: Tunnel;
  isNew: boolean;
  onSave: (one: Tunnel) => void;
  onClose: () => void;
}

function TunnelForm({ initial, isNew, onSave, onClose }: TunnelFormProps) {
  const [draft, setDraft] = useState<Tunnel>(initial);
  const put = (patch: Partial<Tunnel>) => setDraft((old) => ({ ...old, ...patch }));

  const port = (value: string) => Math.min(65535, Math.max(0, Number(value) || 0));
  const ready = draft.listenPort > 0 && (draft.kind === "socks" || (draft.destHost.trim() !== "" && draft.destPort > 0));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>{isNew ? "加一条转发" : "改这条转发"}</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>类型</span>
            <div className="seg wrap">
              {TUNNEL_KINDS.map((one) => (
                <button
                  key={one.value}
                  type="button"
                  className={draft.kind === one.value ? "on" : ""}
                  title={one.hint}
                  onClick={() => put({ kind: one.value as TunnelKind })}
                >
                  {one.label}
                </button>
              ))}
            </div>
            <em className="field-hint">{TUNNEL_KINDS.find((one) => one.value === draft.kind)?.hint}</em>
          </label>

          <div className="field-row">
            <label className="field grow">
              <span>{draft.kind === "remote" ? "服务器上监听地址" : "本机监听地址"}</span>
              <input
                value={draft.listenHost}
                placeholder={draft.kind === "remote" ? "127.0.0.1" : "127.0.0.1"}
                onChange={(e) => put({ listenHost: e.target.value })}
              />
            </label>
            <label className="field port">
              <span>端口</span>
              <input
                type="number"
                value={draft.listenPort || ""}
                onChange={(e) => put({ listenPort: port(e.target.value) })}
              />
            </label>
          </div>

          {draft.kind !== "socks" && (
            <div className="field-row">
              <label className="field grow">
                <span>{draft.kind === "remote" ? "落到本机的" : "服务器那边连到"}</span>
                <input
                  value={draft.destHost}
                  placeholder="127.0.0.1 或 db.internal"
                  onChange={(e) => put({ destHost: e.target.value })}
                />
              </label>
              <label className="field port">
                <span>端口</span>
                <input
                  type="number"
                  value={draft.destPort || ""}
                  onChange={(e) => put({ destPort: port(e.target.value) })}
                />
              </label>
            </div>
          )}

          <label className="check-row">
            <input type="checkbox" checked={!!draft.auto} onChange={(e) => put({ auto: e.target.checked })} />
            <span>连上这台服务器就自动开</span>
          </label>

          {draft.kind === "remote" && (
            <p className="page-meta">
              监听地址填 127.0.0.1 时只有服务器自己能连；要让别的机器也能连，得先在服务器的 sshd 上打开 GatewayPorts。
            </p>
          )}
          {draft.listenPort > 0 && draft.listenPort < 1024 && draft.kind !== "remote" && (
            <p className="page-meta">1024 以下的端口在 macOS / Linux 上要管理员权限才能监听。</p>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn-primary" type="button" disabled={!ready} onClick={() => onSave(draft)}>保存</button>
        </div>
      </div>
    </div>
  );
}
