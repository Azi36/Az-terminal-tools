import { useMemo, useState } from "react";
import { IconEdit, IconTrash } from "./icons";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";
import type { ConnStatus } from "./ConnectionList";
import { copyText } from "../clipboard";
import { DB_KINDS, DEFAULT_GROUP, type DbConn } from "../types";

interface DbListProps {
  dbs: DbConn[];
  statusOf: (dbId: string) => ConnStatus;
  /** 单击：开这条的标签（记过密码就直接连） */
  onOpen: (db: DbConn) => void;
  onEdit: (db: DbConn) => void;
  onDelete: (db: DbConn) => void;
}

/** 侧栏里的数据库列表：样式跟服务器那一栏一套，右键也是同一套菜单 */
export function DbList({ dbs, statusOf, onOpen, onEdit, onDelete }: DbListProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const groups = useMemo(() => {
    const rank = (one: DbConn) => one.lastUsedAt ?? one.createdAt;
    const sorted = [...dbs].sort((a, b) => rank(b) - rank(a));
    const map = new Map<string, DbConn[]>();
    for (const db of sorted) {
      const list = map.get(db.group) ?? [];
      list.push(db);
      map.set(db.group, list);
    }
    return [...map.entries()];
  }, [dbs]);
  const showTitles = groups.length > 1 || groups[0]?.[0] !== DEFAULT_GROUP;

  const openMenu = (db: DbConn, e: React.MouseEvent) =>
    setMenu(menuAt(e, [
      { label: "连接", hint: "单击也行", onClick: () => onOpen(db) },
      { label: "配置", onClick: () => onEdit(db) },
      null,
      { label: "复制地址", onClick: () => void copyText(`${db.host}:${db.port}`) },
      null,
      { label: "删除", danger: true, onClick: () => onDelete(db) },
    ]));

  return (
    <div className="conn-list">
      {groups.map(([group, list]) => (
        <div className="conn-group" key={group}>
          {showTitles && <div className="conn-group-title"><span>{group}</span></div>}
          {list.map((db) => {
            const status = statusOf(db.id);
            const meta = DB_KINDS.find((one) => one.value === db.kind);
            return (
              <div
                key={db.id}
                className="conn-item"
                role="button"
                tabIndex={0}
                title={`${meta?.label ?? db.kind} · ${db.host}:${db.port}${db.database ? `/${db.database}` : ""}\n单击打开，右键更多`}
                onClick={() => onOpen(db)}
                onContextMenu={(e) => openMenu(db, e)}
                onKeyDown={(e) => e.key === "Enter" && onOpen(db)}
              >
                <span
                  className={`status-dot ${status}`}
                  style={status === "idle" ? { background: db.color } : undefined}
                  title={status === "live" ? "连着" : status === "down" ? "标签开着但没连" : "没连"}
                />
                <span className="conn-main">
                  <b>
                    <span className="conn-name">{db.name}</span>
                    <i className="conn-proto">{meta?.label ?? db.kind}</i>
                  </b>
                  <small>{db.host}:{db.port}{db.database ? `/${db.database}` : ""}</small>
                </span>
                <span className="conn-actions">
                  <button type="button" title="配置" onClick={(e) => { e.stopPropagation(); onEdit(db); }} aria-label="配置">
                    <IconEdit size={14} />
                  </button>
                  <button type="button" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(db); }} aria-label="删除">
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
