import { useEffect, useRef, useState } from "react";
import { IconX } from "./icons";

export interface DialogSpec {
  title: string;
  /** 说明文字，可省 */
  message?: string;
  /** 要输入内容时给上，纯确认弹窗就不给 */
  input?: { label: string; initial?: string; placeholder?: string };
  confirmText?: string;
  danger?: boolean;
  onConfirm: (value: string) => void;
}

interface DialogProps extends DialogSpec {
  /** 就地弹：不加全屏遮罩，由调用方决定摆在哪 */
  inline?: boolean;
  onClose: () => void;
}

/**
 * 一个弹窗顶掉浏览器的 alert/confirm/prompt：
 * 系统弹窗在各平台 webview 里样式不一、还可能被吞，自己画一个稳妥。
 */
export function Dialog({ title, message, input, confirmText, danger, inline, onConfirm, onClose }: DialogProps) {
  const [value, setValue] = useState(input?.initial ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirm = () => {
    if (input && !value.trim()) return;
    onConfirm(value.trim());
    onClose();
  };

  const card = (
      <div className={`modal dialog ${inline ? "inline" : ""}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="modal-body">
          {message && <p className="dialog-msg">{message}</p>}
          {input && (
            <label className="field">
              <span>{input.label}</span>
              <input
                ref={inputRef}
                autoFocus
                value={value}
                placeholder={input.placeholder}
                onChange={(e) => setValue(e.target.value)}
                // 中文输入法选词那一下的 Enter 不算确认（macOS 的 WebView 会把它当普通 Enter 发过来）
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && confirm()}
              />
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button
            className={danger ? "btn-primary danger" : "btn-primary"}
            type="button"
            disabled={!!input && !value.trim()}
            onClick={confirm}
          >
            {confirmText ?? "确定"}
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
