import { useEffect, useMemo, useState } from "react";
import { IconEdit, IconPlay, IconSearch, IconSparkle, IconTrash, IconX } from "./icons";
import { newId } from "../store";
import { PRESET_SNIPPETS, type PresetSnippet } from "../presets";
import { DEFAULT_TAG, type Snippet } from "../types";

interface SnippetPanelProps {
  snippets: Snippet[];
  /** 有连上的终端才能插入 */
  canSend: boolean;
  onSave: (snippet: Snippet) => void;
  onImport: (snippets: Snippet[]) => void;
  onDelete: (snippet: Snippet) => void;
  /** run=true 直接带回车执行，否则只填进命令行等用户按回车 */
  onSend: (command: string, run: boolean) => void;
}

export function SnippetPanel({ snippets, canSend, onSave, onImport, onDelete, onSend }: SnippetPanelProps) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const hit = snippets.filter(
      (one) =>
        !keyword ||
        one.title.toLowerCase().includes(keyword) ||
        one.command.toLowerCase().includes(keyword) ||
        one.tag.toLowerCase().includes(keyword),
    );
    const map = new Map<string, Snippet[]>();
    for (const one of hit) {
      const list = map.get(one.tag) ?? [];
      list.push(one);
      map.set(one.tag, list);
    }
    return [...map.entries()];
  }, [snippets, query]);

  const openNew = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (snippet: Snippet) => { setEditing(snippet); setFormOpen(true); };

  // 侧栏顶部那个「存条指令」按钮在 App 里，靠事件招呼这边开表单
  useEffect(() => {
    const onNew = () => openNew();
    window.addEventListener("az-term:new-snippet", onNew);
    return () => window.removeEventListener("az-term:new-snippet", onNew);
  }, []);

  return (
    <div className="drawer">
      <div className="drawer-search">
        <IconSearch size={14} />
        <input value={query} placeholder="搜标题、指令、标签" onChange={(e) => setQuery(e.target.value)} />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="清空" title="清空">
            <IconX size={13} />
          </button>
        ) : (
          <button type="button" onClick={() => setPresetOpen(true)} aria-label="预设" title="从预设里挑几条">
            <IconSparkle size={14} />
          </button>
        )}
      </div>

      {snippets.length === 0 ? (
        <div className="drawer-empty">
          <p className="sidebar-empty">空的。老敲的那几条，存这儿。</p>
          <button className="btn-ghost sm" type="button" onClick={() => setPresetOpen(true)}>
            <IconSparkle size={14} /> 挑几条预设
          </button>
        </div>
      ) : groups.length === 0 ? (
        <p className="sidebar-empty">没搜到。</p>
      ) : (
        <div className="conn-list">
          {groups.map(([tag, list]) => (
            <div key={tag}>
              <div className="conn-group-title">{tag}</div>
              {list.map((snippet) => (
                <div
                  key={snippet.id}
                  className={`snip-item ${canSend ? "" : "off"}`}
                  role="button"
                  tabIndex={0}
                  title={canSend ? `${snippet.command}\n\n点一下填进终端，▶ 直接执行` : "先连上一台服务器"}
                  onClick={() => canSend && onSend(snippet.command, false)}
                  onKeyDown={(e) => e.key === "Enter" && canSend && onSend(snippet.command, false)}
                >
                  <span className="snip-main">
                    <b>{snippet.title}</b>
                    <code>{snippet.command}</code>
                  </span>
                  <span className="conn-actions">
                    <button
                      type="button"
                      aria-label="执行"
                      title="直接执行（带回车）"
                      disabled={!canSend}
                      onClick={(e) => { e.stopPropagation(); onSend(snippet.command, true); }}
                    >
                      <IconPlay size={12} />
                    </button>
                    <button type="button" aria-label="编辑" title="编辑" onClick={(e) => { e.stopPropagation(); openEdit(snippet); }}>
                      <IconEdit size={13} />
                    </button>
                    <button type="button" aria-label="删除" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(snippet); }}>
                      <IconTrash size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <SnippetForm
          initial={editing}
          onSave={(snippet) => { onSave(snippet); setFormOpen(false); }}
          onClose={() => setFormOpen(false)}
        />
      )}

      {presetOpen && (
        <PresetPicker
          existing={snippets}
          onImport={(list) => { onImport(list); setPresetOpen(false); }}
          onClose={() => setPresetOpen(false)}
        />
      )}
    </div>
  );
}

interface SnippetFormProps {
  initial: Snippet | null;
  onSave: (snippet: Snippet) => void;
  onClose: () => void;
}

function SnippetForm({ initial, onSave, onClose }: SnippetFormProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [tag, setTag] = useState(initial?.tag ?? DEFAULT_TAG);

  const ready = title.trim() && command.trim();

  const submit = () => {
    if (!ready) return;
    onSave({
      id: initial?.id ?? newId(),
      title: title.trim(),
      command: command.trim(),
      tag: tag.trim() || DEFAULT_TAG,
      createdAt: initial?.createdAt ?? Date.now(),
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>{initial ? "改指令" : "存条指令"}</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>叫什么</span>
            <input autoFocus value={title} placeholder="看一眼就知道是干嘛的" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>指令</span>
            <textarea
              rows={4}
              value={command}
              placeholder="docker ps -a"
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && submit()}
            />
          </label>
          <label className="field">
            <span>标签</span>
            <input value={tag} placeholder={DEFAULT_TAG} onChange={(e) => setTag(e.target.value)} />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn-primary" type="button" disabled={!ready} onClick={submit}>保存</button>
        </div>
      </div>
    </div>
  );
}

interface PresetPickerProps {
  existing: Snippet[];
  onImport: (snippets: Snippet[]) => void;
  onClose: () => void;
}

/** 预设挑选器：按标签分组勾选，已经有的自动标灰 */
function PresetPicker({ existing, onImport, onClose }: PresetPickerProps) {
  const had = useMemo(() => new Set(existing.map((one) => one.command.trim())), [existing]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const map = new Map<string, PresetSnippet[]>();
    for (const one of PRESET_SNIPPETS) {
      const list = map.get(one.tag) ?? [];
      list.push(one);
      map.set(one.tag, list);
    }
    return [...map.entries()];
  }, []);

  const toggle = (command: string) => {
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(command)) next.delete(command);
      else next.add(command);
      return next;
    });
  };

  const toggleGroup = (list: PresetSnippet[]) => {
    const free = list.filter((one) => !had.has(one.command.trim()));
    const allOn = free.every((one) => picked.has(one.command));
    setPicked((old) => {
      const next = new Set(old);
      free.forEach((one) => (allOn ? next.delete(one.command) : next.add(one.command)));
      return next;
    });
  };

  const submit = () => {
    const now = Date.now();
    const list = PRESET_SNIPPETS.filter((one) => picked.has(one.command)).map((one, i) => ({
      id: newId(),
      title: one.title,
      command: one.command,
      tag: one.tag,
      createdAt: now + i,
    }));
    if (list.length) onImport(list);
    else onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>预设指令</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body preset-body">
          {groups.map(([tag, list]) => (
            <div className="preset-group" key={tag}>
              <button className="preset-tag" type="button" onClick={() => toggleGroup(list)} title="整组勾上 / 取消">
                {tag}
              </button>
              {list.map((one) => {
                const owned = had.has(one.command.trim());
                return (
                  <label className={`preset-row ${owned ? "owned" : ""}`} key={one.command + one.title}>
                    <input
                      type="checkbox"
                      disabled={owned}
                      checked={owned || picked.has(one.command)}
                      onChange={() => toggle(one.command)}
                    />
                    <span className="preset-title">{one.title}</span>
                    <code>{one.command}</code>
                    {owned && <span className="preset-owned">已有</span>}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <span className="preset-count">选了 {picked.size} 条</span>
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn-primary" type="button" disabled={picked.size === 0} onClick={submit}>导入</button>
        </div>
      </div>
    </div>
  );
}
