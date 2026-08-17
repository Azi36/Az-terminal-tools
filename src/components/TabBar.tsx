import { useState } from "react";
import { IconFileEdit, IconServer, IconSettings, IconX, IconNote, IconTerminal } from "./icons";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";

export interface TabItem {
  id: string;
  label: string;
  kind: "session" | "note" | "file" | "conn" | "settings";
  /** 会话标签没连上时用连接的标签色 */
  color?: string;
  /** 连着=绿 断了=红 */
  status?: "live" | "down";
  /** 有没保存的改动 */
  dirty?: boolean;
}

interface TabBarProps {
  items: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** 一次关一批：没保存的改动由上层一次问清楚 */
  onCloseMany: (ids: string[]) => void;
}

export function TabBar({ items, activeId, onSelect, onClose, onCloseMany }: TabBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  if (items.length === 0) return null;

  const openMenu = (id: string, e: React.MouseEvent) =>
    setMenu(menuAt(e, [
      { label: "关闭", hint: "中键也行", onClick: () => onClose(id) },
      {
        label: "关闭其他",
        disabled: items.length < 2,
        onClick: () => onCloseMany(items.filter((one) => one.id !== id).map((one) => one.id)),
      },
      {
        label: "关闭右侧",
        disabled: items.findIndex((one) => one.id === id) === items.length - 1,
        onClick: () => onCloseMany(items.slice(items.findIndex((one) => one.id === id) + 1).map((one) => one.id)),
      },
    ]));

  return (
    <div className="tab-bar">
      {items.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${activeId === tab.id ? "on" : ""}`}
          role="button"
          tabIndex={0}
          title={tab.label}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(e) => e.key === "Enter" && onSelect(tab.id)}
          onContextMenu={(e) => openMenu(tab.id, e)}
          // 中键关标签，和浏览器一个手感
          onAuxClick={(e) => e.button === 1 && onClose(tab.id)}
        >
          {tab.kind === "session" ? (
            <>
              <span
                className={`status-dot ${tab.status ?? "down"}`}
                style={tab.status ? undefined : { background: tab.color }}
              />
              <IconTerminal size={13} />
            </>
          ) : tab.kind === "file" ? (
            <IconFileEdit size={13} />
          ) : tab.kind === "conn" ? (
            <IconServer size={13} />
          ) : tab.kind === "settings" ? (
            <IconSettings size={13} />
          ) : (
            <IconNote size={13} />
          )}
          <span className="tab-label">{tab.label}</span>
          {tab.dirty && <span className="dot-dirty" title="还没存" />}
          <button
            className="tab-close"
            type="button"
            aria-label="关闭标签"
            onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
