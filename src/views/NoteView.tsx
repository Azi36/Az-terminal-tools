import { useEffect, useRef, useState } from "react";
import { IconTrash } from "../components/icons";
import { fmtWhen } from "../format";
import type { Note } from "../types";

interface NoteViewProps {
  note: Note;
  onChange: (note: Note) => void;
  onDelete: (note: Note) => void;
}

/**
 * 备忘录编辑器：敲完就存，不用点保存。
 * 由 App 用 key={note.id} 挂载，切笔记直接重挂，省掉同步逻辑。
 */
export function NoteView({ note, onChange, onDelete }: NoteViewProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [savedAt, setSavedAt] = useState(note.updatedAt);
  const first = useRef(true);

  // 停手 500ms 落盘
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const now = Date.now();
      onChange({ ...note, title, body, updatedAt: now });
      setSavedAt(now);
    }, 500);
    return () => clearTimeout(timer);
    // note / onChange 变动不该重开计时器，只跟着内容走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body]);

  return (
    <div className="note-view">
      <div className="note-head">
        <input
          className="note-title"
          value={title}
          placeholder="无题"
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className="note-saved">{fmtWhen(savedAt)}存过</span>
        <button className="icon-btn sm" type="button" onClick={() => onDelete(note)} aria-label="删除备忘">
          <IconTrash size={15} />
        </button>
      </div>
      <textarea
        className="note-body"
        value={body}
        placeholder="随便写。这台机器之外没人看得见。"
        spellCheck={false}
        onChange={(e) => setBody(e.target.value)}
      />
    </div>
  );
}
