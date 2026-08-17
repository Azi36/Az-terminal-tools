import { useState } from "react";
import { IconX } from "./icons";

interface ChmodDialogProps {
  name: string;
  /** 当前权限（八进制低 12 位） */
  mode: number;
  onApply: (mode: number) => void;
  /** 就地弹：不加全屏遮罩 */
  inline?: boolean;
  onClose: () => void;
}

const WHO = [
  { key: "owner", label: "属主", shift: 6 },
  { key: "group", label: "同组", shift: 3 },
  { key: "other", label: "其他", shift: 0 },
];
const WHAT = [
  { label: "读", bit: 4 },
  { label: "写", bit: 2 },
  { label: "执行", bit: 1 },
];
const PRESETS = [
  { mode: 0o644, hint: "普通文件" },
  { mode: 0o600, hint: "私密文件" },
  { mode: 0o755, hint: "可执行 / 目录" },
  { mode: 0o777, hint: "谁都能动" },
];

/** 权限修改：勾选和八进制两头都能改，改哪个另一个跟着走 */
export function ChmodDialog({ name, mode, onApply, inline, onClose }: ChmodDialogProps) {
  const [value, setValue] = useState(mode & 0o777);
  const [text, setText] = useState((mode & 0o777).toString(8).padStart(3, "0"));

  const set = (next: number) => {
    setValue(next);
    setText(next.toString(8).padStart(3, "0"));
  };

  const toggle = (shift: number, bit: number) => set(value ^ (bit << shift));

  const onText = (raw: string) => {
    setText(raw);
    const parsed = parseInt(raw, 8);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 0o777) setValue(parsed);
  };

  const card = (
      <div className={`modal ${inline ? "inline" : ""}`}>
        <div className="modal-head">
          <h3>改权限 · {name}</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="chmod-grid">
            <span />
            {WHAT.map((what) => <span className="chmod-col" key={what.label}>{what.label}</span>)}
            {WHO.map((who) => (
              <ChmodRow key={who.key} label={who.label} shift={who.shift} value={value} onToggle={toggle} />
            ))}
          </div>

          <label className="field">
            <span>八进制</span>
            <input value={text} maxLength={4} spellCheck={false} onChange={(e) => onText(e.target.value)} />
          </label>

          <div className="chmod-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.mode}
                type="button"
                className={value === preset.mode ? "on" : ""}
                onClick={() => set(preset.mode)}
                title={preset.hint}
              >
                {preset.mode.toString(8)}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn-primary" type="button" onClick={() => { onApply(value); onClose(); }}>
            改成 {value.toString(8).padStart(3, "0")}
          </button>
        </div>
      </div>
  );

  if (inline) return card;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {card}
    </div>
  );
}

function ChmodRow({
  label,
  shift,
  value,
  onToggle,
}: {
  label: string;
  shift: number;
  value: number;
  onToggle: (shift: number, bit: number) => void;
}) {
  return (
    <>
      <span className="chmod-who">{label}</span>
      {WHAT.map((what) => (
        <label className="chmod-cell" key={what.label}>
          <input
            type="checkbox"
            checked={((value >> shift) & what.bit) !== 0}
            onChange={() => onToggle(shift, what.bit)}
          />
        </label>
      ))}
    </>
  );
}
