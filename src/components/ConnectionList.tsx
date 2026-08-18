import { useMemo, useState } from "react";
import { IconEdit, IconStar, IconTrash } from "./icons";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";
import { copyText } from "../clipboard";
import { DEFAULT_GROUP, type Connection } from "../types";

export type ConnStatus = "live" | "down" | "idle";

interface ConnectionListProps {
  connections: Connection[];
  /** 每条连接现在的状态：绿=连着 红=开着标签但断了 默认=没开 */
  statusOf: (connId: string) => ConnStatus;
  /** 正在看配置页的那条 */
  inspectingId?: string | null;
  /** 单击：开这台的标签，停在连接卡上，不动网络 */
  onInspect: (conn: Connection) => void;
  /** 双击：直接连（落在终端） */
  onOpen: (conn: Connection) => void;
  /** 再开一条独立会话（同一台机器多个终端） */
  onOpenAnother: (conn: Connection) => void;
  /** 连上直接进文件面板 */
  onOpenFiles: (conn: Connection) => void;
  onEdit: (conn: Connection) => void;
  onDelete: (conn: Connection) => void;
  onTogglePin: (conn: Connection) => void;
}

export function ConnectionList({
  connections,
  statusOf,
  inspectingId,
  onInspect,
  onOpen,
  onOpenAnother,
  onOpenFiles,
  onEdit,
  onDelete,
  onTogglePin,
}: ConnectionListProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  // 置顶的在最前，然后按最近连过排，没连过的按建的时间
  const groups = useMemo(() => {
    const rank = (one: Connection) => one.lastUsedAt ?? one.createdAt;
    const sorted = [...connections].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return rank(b) - rank(a);
    });
    const map = new Map<string, Connection[]>();
    for (const conn of sorted) {
      const list = map.get(conn.group) ?? [];
      list.push(conn);
      map.set(conn.group, list);
    }
    // 分组之间也按各自最靠前的那条排
    const score = (list: Connection[]) => (list.some((one) => one.pinned) ? Infinity : rank(list[0]));
    return [...map.entries()].sort((a, b) => score(b[1]) - score(a[1]));
  }, [connections]);

  const openMenu = (conn: Connection, e: React.MouseEvent) => {
    onInspect(conn);
    setMenu(menuAt(e, [
      { label: "连接", hint: "双击也行", onClick: () => onOpen(conn) },
      { label: "再开一个终端", hint: "同一台，另一条会话", onClick: () => onOpenAnother(conn) },
      { label: "打开文件面板", hint: "SFTP", onClick: () => onOpenFiles(conn) },
      { label: conn.pinned ? "取消置顶" : "置顶", onClick: () => onTogglePin(conn) },
      null,
      { label: "复制 ssh 命令", onClick: () => void copyText(`ssh ${conn.username}@${conn.host} -p ${conn.port}`) },
      { label: "复制地址", onClick: () => void copyText(`${conn.username}@${conn.host}`) },
      null,
      { label: "配置", onClick: () => onEdit(conn) },
      { label: "删除", danger: true, onClick: () => onDelete(conn) },
    ]));
  };

  // 只有一个「默认」分组时不必写标题，省得白占一行
  const showTitles = groups.length > 1 || groups[0]?.[0] !== DEFAULT_GROUP;

  return (
    <div className="conn-list">
      {groups.map(([group, list]) => (
        <div className="conn-group" key={group}>
          {showTitles && <div className="conn-group-title"><span>{group}</span></div>}
          {list.map((conn) => {
            const status = statusOf(conn.id);
            return (
              <div
                key={conn.id}
                className={`conn-item ${inspectingId === conn.id ? "active" : ""}`}
                onClick={() => onInspect(conn)}
                onDoubleClick={() => onOpen(conn)}
                onContextMenu={(e) => openMenu(conn, e)}
                role="button"
                tabIndex={0}
                title={`${conn.username}@${conn.host}:${conn.port}\n单击打开标签，双击直接连`}
                onKeyDown={(e) => e.key === "Enter" && onOpen(conn)}
              >
                <span
                  className={`status-dot ${status}`}
                  style={status === "idle" ? { background: conn.color } : undefined}
                  title={status === "live" ? "连着" : status === "down" ? "标签开着但断了" : "没连"}
                />
                <span className="conn-main">
                  <b>
                    <span className="conn-name">{conn.name}</span>
                    {conn.pinned && <IconStar size={10} />}
                    {conn.protocol !== "ssh" && <i className="conn-proto">{conn.protocol.toUpperCase()}</i>}
                  </b>
                  <small>{conn.username}@{conn.host}{conn.port === 22 ? "" : `:${conn.port}`}</small>
                </span>
                <span className="conn-actions">
                  <button type="button" title={conn.pinned ? "取消置顶" : "置顶"}
                    onClick={(e) => { e.stopPropagation(); onTogglePin(conn); }} aria-label="置顶">
                    <IconStar size={13} />
                  </button>
                  <button type="button" title="配置" onClick={(e) => { e.stopPropagation(); onEdit(conn); }} aria-label="配置">
                    <IconEdit size={14} />
                  </button>
                  <button type="button" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(conn); }} aria-label="删除">
                    <IconTrash size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
