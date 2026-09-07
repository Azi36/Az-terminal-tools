import { useState } from "react";
import { IconFileEdit, IconFileText, IconServer, IconSettings, IconX, IconNote, IconTerminal } from "./icons";
import { ContextMenu, menuAt, type MenuState } from "./ContextMenu";
import { SHORTCUTS } from "../shortcuts";

export interface TabItem {
  id: string;
  label: string;
  kind: "session" | "note" | "file" | "log" | "conn" | "settings" | "local";
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
  /** 分屏另一半摆的是哪个标签；null = 没分屏 */
  splitId: string | null;
  splitDir: "row" | "col";
  onSplit: (id: string) => void;
  onEndSplit: () => void;
  onFlipDir: () => void;
}

export function TabBar({ items, activeId, onSelect, onClose, onCloseMany, splitId, splitDir, onSplit, onEndSplit, onFlipDir }: TabBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  if (items.length === 0) return null;

  const openMenu = (id: string, e: React.MouseEvent) =>
    setMenu(menuAt(e, [
      id === splitId
        ? { label: "取消分屏", onClick: onEndSplit }
        : {
            label: splitDir === "row" ? "在右边分屏打开" : "在下边分屏打开",
            // 分屏是「另一半摆什么」，自己跟自己分不出两块来
            disabled: id === activeId || items.length < 2,
            onClick: () => onSplit(id),
          },
      { label: "关闭", hint: id === activeId ? SHORTCUTS.closeTab : "中键也行", onClick: () => onClose(id) },
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
          ) : tab.kind === "local" ? (
            <IconTerminal size={13} />
          ) : tab.kind === "log" ? (
            <IconFileText size={13} />
          ) : tab.kind === "conn" ? (
            <IconServer size={13} />
          ) : tab.kind === "settings" ? (
            <IconSettings size={13} />
          ) : (
            <IconNote size={13} />
          )}
          <span className="tab-label">{tab.label}</span>
          {tab.id === splitId && <span className="tab-split" title="正摆在分屏的另一半">◧</span>}
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
      {splitId && (
        <div className="tab-bar-acts">
          <button type="button" onClick={onFlipDir} title={splitDir === "row" ? "改成上下分" : "改成左右分"}>
            {splitDir === "row" ? "◧" : "⬒"}
          </button>
          <button type="button" onClick={onEndSplit} title="取消分屏">
            <IconX size={12} />
          </button>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
