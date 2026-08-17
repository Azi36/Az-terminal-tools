import { useMemo, useState } from "react";
import { IconSearch, IconTrash, IconX } from "./icons";
import { fmtWhen } from "../format";
import type { Note } from "../types";

interface NotePanelProps {
  notes: Note[];
  openNoteIds: string[];
  onOpen: (note: Note) => void;
  onDelete: (note: Note) => void;
}

export function NotePanel({ notes, openNoteIds, onOpen, onDelete }: NotePanelProps) {
  const [query, setQuery] = useState("");

  // 标题和正文一起搜 —— 备忘录里真正想找的东西多半在正文里
  const sorted = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const hit = keyword
      ? notes.filter(
          (one) => one.title.toLowerCase().includes(keyword) || one.body.toLowerCase().includes(keyword),
        )
      : notes;
    return [...hit].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, query]);

  return (
    <div className="drawer">
      {notes.length > 0 && (
        <div className="drawer-search">
          <IconSearch size={14} />
          <input value={query} placeholder="搜标题和正文" onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="清空" title="清空">
              <IconX size={13} />
            </button>
          )}
        </div>
      )}

      {notes.length === 0 ? (
        <p className="sidebar-empty">空的。想起什么记什么，全在本机。</p>
      ) : sorted.length === 0 ? (
        <p className="sidebar-empty">没搜到。</p>
      ) : (
        <div className="conn-list">
          {sorted.map((note) => (
            <div
              key={note.id}
              className={`note-item ${openNoteIds.includes(note.id) ? "active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(note)}
              onKeyDown={(e) => e.key === "Enter" && onOpen(note)}
            >
              <span className="conn-main">
                <b>{note.title || "无题"}</b>
                <small>{note.body.split("\n")[0]?.trim() || fmtWhen(note.updatedAt)}</small>
              </span>
              <span className="conn-actions">
                <button type="button" aria-label="删除" onClick={(e) => { e.stopPropagation(); onDelete(note); }}>
                  <IconTrash size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
