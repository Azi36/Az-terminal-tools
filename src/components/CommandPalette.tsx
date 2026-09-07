import { useEffect, useMemo, useRef, useState } from "react";
import { IconSearch } from "./icons";

export interface Command {
  id: string;
  /** 分组标题，同组的排在一起 */
  group: string;
  label: string;
  /** 右边那行小字：主机名、快捷键、命令原文之类 */
  hint?: string;
  /** 参与匹配但不显示的字（主机名、用户名、拼音缩写…） */
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

/**
 * 一条一条打分。返回 -1 表示不匹配。
 *
 * 规矩很简单，但顺序是有讲究的：整段命中排在零散命中前面，开头命中排在中间命中前面。
 * 这样敲 "web" 的时候「web01」会排在「my-web-server」前面，符合直觉。
 */
function score(text: string, keywords: string, needle: string): number {
  if (!needle) return 0;
  const hay = text.toLowerCase();
  const extra = keywords.toLowerCase();

  const at = hay.indexOf(needle);
  if (at === 0) return 1000 - text.length;
  if (at > 0) return 700 - at * 2 - text.length;
  if (extra.includes(needle)) return 400 - text.length;

  // 零散命中：按顺序把每个字都找到就算数（敲 "vlg" 命中 "/var/log"）。
  // 分数压得比整段命中低一截，免得它把精确结果挤下去。
  let cursor = 0;
  let gaps = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, cursor);
    if (found < 0) return -1;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 200 - gaps - text.length;
}

/**
 * 命令面板：一个搜索框把所有入口收拢。
 *
 * 功能多起来之后（终端 / 文件 / 状态 / 端口 / 隧道 / 日志 / 片段 / 备忘），
 * 记得住每个东西在哪个抽屉哪个页签的人不多，但记得住它叫什么的人很多。
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands.slice(0, 60);
    return commands
      .map((one) => ({ one, s: score(one.label, one.keywords ?? "", needle) }))
      .filter((row) => row.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((row) => row.one);
  }, [commands, q]);

  // 换了搜索词就回到第一条，不然选中的会停在一个跟当前结果无关的位置
  useEffect(() => { setAt(0); }, [q]);
  // 面板开着时结果变短了（会话连上 / 断开会改命令表）：选中项别停在已经不存在的位置上
  useEffect(() => { setAt((a) => Math.min(a, Math.max(0, hits.length - 1))); }, [hits]);

  // 键盘选中的那条要跟着滚进视野，不然按住 ↓ 会选到看不见的地方
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".cp-row.on")?.scrollIntoView({ block: "nearest" });
  }, [at, hits]);

  const pick = (one: Command | undefined) => {
    if (!one) return;
    // 先关再跑：动作里有开标签、切页签的，面板留在上面挡着不合适
    onClose();
    one.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) {
      e.preventDefault();
      setAt((one) => (hits.length === 0 ? 0 : (one + 1) % hits.length));
      return;
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
      e.preventDefault();
      setAt((one) => (hits.length === 0 ? 0 : (one - 1 + hits.length) % hits.length));
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); pick(hits[at]); }
  };

  // 相邻两条同组的话，组标题只画一次
  let lastGroup = "";

  return (
    <div className="modal-backdrop cp-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cp" onKeyDown={onKey}>
        <div className="cp-input">
          <IconSearch size={16} />
          <input
            autoFocus
            value={q}
            placeholder="找连接、片段、备忘，或者一个动作"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="cp-list" ref={listRef}>
          {hits.map((one, i) => {
            const head = one.group !== lastGroup ? one.group : null;
            lastGroup = one.group;
            return (
              <div key={one.id}>
                {head && <div className="cp-group">{head}</div>}
                <button
                  className={`cp-row ${i === at ? "on" : ""}`}
                  type="button"
                  // onMouseMove 而不是 onMouseEnter：面板刚弹出来时鼠标碰巧压在某一条上，
                  // enter 不会触发，但一动就该跟手
                  onMouseMove={() => setAt(i)}
                  onClick={() => pick(one)}
                >
                  <span className="cp-label">{one.label}</span>
                  {one.hint && <span className="cp-hint">{one.hint}</span>}
                </button>
              </div>
            );
          })}
          {hits.length === 0 && <p className="cp-empty">没有对得上的。</p>}
        </div>
      </div>
    </div>
  );
}
