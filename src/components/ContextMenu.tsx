import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** null 就是一条分隔线 */
export type MenuEntry = MenuItem | null;

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

interface ContextMenuProps {
  menu: MenuState;
  onClose: () => void;
}

/**
 * 自绘右键菜单。原生 webview 那个「重新加载 / 查看源代码」菜单全局屏蔽了，
 * 该有的复制粘贴由这里补上。
 */
export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // 靠边时翻个面，别被窗口切掉
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: Math.min(menu.y, window.innerHeight - height - 8),
    });
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="menu-backdrop ctx-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="ctx-menu" ref={boxRef} style={{ left: pos.x, top: pos.y }}>
        {menu.items.map((item, i) =>
          item === null ? (
            <hr key={`sep-${i}`} />
          ) : (
            <button
              key={`${i}-${item.label}`}
              type="button"
              className={item.danger ? "danger" : ""}
              disabled={item.disabled}
              onClick={() => { item.onClick(); onClose(); }}
            >
              <span className="ctx-icon">{item.icon}</span>
              {item.label}
              {item.hint && <small>{item.hint}</small>}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** 给组件用的小工具：右键事件 → 菜单位置 */
export function menuAt(e: React.MouseEvent, items: MenuEntry[]): MenuState {
  e.preventDefault();
  e.stopPropagation();
  return { x: e.clientX, y: e.clientY, items };
}
