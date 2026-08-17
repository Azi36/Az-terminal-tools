import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * 剪贴板：优先走 Tauri 插件（系统剪贴板，最稳），
 * 万一插件不在就退回 webview 的 navigator.clipboard。
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

export async function pasteText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}
