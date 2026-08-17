/**
 * 版本提示。
 *
 * 「有没有新版」这一句问自己的后端（api.azi36.com，国内直达）；
 * **更新包本身还是从 GitHub 下载**——那条路有签名校验，不自己重造一套分发。
 *
 * 分开的理由很实在：api.github.com 在国内经常拉不动，
 * 拉不动的结果不是"提示晚了"，而是用户永远不知道有新版。
 * 检查这一步必须快且可达；下载那一步慢一点、失败了还能点链接自己去下。
 *
 * 这个请求只是一个 GET，不带任何身份、不上报任何东西。
 */

const ENDPOINT = "https://api.azi36.com/release/az-term";

/** 后端返回的那条发版记录 */
export interface Release {
  version: string;
  /** 这版改了什么，直接显示给用户 */
  notes: string;
  /** 下载页（GitHub Release），更新装不上时兜底给用户点 */
  url: string;
  pubDate?: string;
}

/**
 * 版本比大小：1.10.0 要比 1.9.0 新（按数字比，不是按字符串）。
 * 带 -beta 之类后缀的，数字段相同则认为比正式版旧。
 */
export function isNewer(candidate: string, current: string): boolean {
  const cut = (v: string) => String(v).replace(/^v/i, "").split("-")[0];
  const pre = (v: string) => String(v).includes("-");
  const a = cut(candidate).split(".").map((n) => parseInt(n, 10) || 0);
  const b = cut(current).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  // 数字段一样：预发布版不算新
  return !pre(candidate) && pre(current);
}

/**
 * 问一句有没有新版。拿不到（断网、后端挂了、超时）就当没有，
 * 静静地什么都不做 —— 检查更新失败不该变成一个打扰用户的错误框。
 */
export async function checkRelease(current: string): Promise<Release | null> {
  try {
    const stop = new AbortController();
    // 卡 6 秒就放弃：这是个后台的顺手一问，不值得让它挂着
    const timer = setTimeout(() => stop.abort(), 6000);
    const reply = await fetch(ENDPOINT, { signal: stop.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!reply.ok) return null;

    const data = (await reply.json()) as Partial<Release>;
    if (!data?.version || typeof data.version !== "string") return null;
    if (!isNewer(data.version, current)) return null;

    return {
      version: data.version,
      notes: typeof data.notes === "string" ? data.notes : "",
      url: typeof data.url === "string" && /^https:\/\//.test(data.url)
        ? data.url
        : "https://github.com/Azi36/Az-terminal-tools/releases/latest",
      pubDate: typeof data.pubDate === "string" ? data.pubDate : undefined,
    };
  } catch {
    return null;
  }
}
