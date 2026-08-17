/**
 * 主题：浅色 / 深色 / 跟随系统，三档。
 * 键是 Az-term 自己的，不再跟网页共用 —— 桌面 app 想深色，网站想浅色，各管各的。
 */

export type ThemeMode = "light" | "dark" | "system";

const KEY = "az-term-theme";

const systemPrefersDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function getMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
  } catch {}
  // 桌面终端默认深色（终端天生该是深的）
  return "dark";
}

/** 三档 → 真正落到 DOM 上的两态 */
export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

export function applyMode(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", resolveMode(mode));
}

export function setMode(mode: ThemeMode) {
  applyMode(mode);
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
}

/** 首帧前调用，避免闪烁 */
export function initMode(): ThemeMode {
  const mode = getMode();
  applyMode(mode);
  return mode;
}

/** 跟随系统时，系统换色要跟着换 */
export function watchSystem(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
