/** 文件大小：给人看的那种 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** Unix 秒 → 年内省年份 */
export function fmtMtime(seconds: number): string {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${day}`;
}

/** 毫秒时间戳 → 相对时间 */
export function fmtWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return fmtMtime(Math.floor(ms / 1000));
}

/** 秒 → 「还剩多久」那种说法 */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** Unix 权限位 → rwxr-xr-x */
export function fmtMode(mode?: number | null): string {
  if (!mode) return "";
  const bit = (value: number, flag: number, char: string) => ((value & flag) ? char : "-");
  const part = (value: number) => `${bit(value, 4, "r")}${bit(value, 2, "w")}${bit(value, 1, "x")}`;
  return `${part((mode >> 6) & 7)}${part((mode >> 3) & 7)}${part(mode & 7)}`;
}
