import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 全局热键：不在前台也能一下把窗口叫出来，再按一下收回去。
 *
 * 名字里的「Quake」是那个游戏的下拉控制台 —— 想敲一条命令的时候不用先去找窗口。
 * 我们没做「从屏幕顶上滑下来」那套动画，就是显示 / 隐藏，够用而且不跟各平台的
 * 窗口管理器较劲。
 */

/** 可选的几个组合。都是应用里和终端里都用不上的键，不会跟别的抢。 */
export const HOTKEYS: { value: string; label: string }[] = [
  { value: "", label: "不用" },
  { value: "Alt+`", label: "Alt + ` （反引号）" },
  { value: "Ctrl+Alt+T", label: "Ctrl + Alt + T" },
  { value: "Alt+Shift+A", label: "Alt + Shift + A" },
  { value: "F12", label: "F12" },
];

/** 现在挂着的那个，切换时要先摘掉 */
let current: string | null = null;

async function toggleWindow() {
  const win = getCurrentWindow();
  // 最小化的窗口 isVisible 仍然是 true，只看它就会「按一下没反应，再按一下才出来」
  const [visible, minimized] = await Promise.all([win.isVisible(), win.isMinimized()]);
  if (visible && !minimized) {
    await win.hide();
    return;
  }
  if (minimized) await win.unminimize();
  await win.show();
  await win.setFocus();
}

/**
 * 换一个热键（传空字符串就是关掉）。
 *
 * 注册失败最常见的原因是这个组合被别的软件占了 —— 那种情况下不能装作成功，
 * 得把话说回去让用户换一个。
 */
export async function applyHotkey(accelerator: string): Promise<string | null> {
  if (current && current !== accelerator) {
    await unregister(current).catch(() => {});
    current = null;
  }
  if (!accelerator) return null;
  if (current === accelerator) return null;

  try {
    // 上一次跑崩了 / 热更新之后可能还挂着，先摘一下再注册，免得报「已注册」
    if (await isRegistered(accelerator)) await unregister(accelerator).catch(() => {});
    await register(accelerator, (event) => {
      // 插件会为按下和抬起各发一次，只认按下那次，不然一次按键切两回等于没切
      if (event.state === "Pressed") void toggleWindow();
    });
    current = accelerator;
    return null;
  } catch (e) {
    current = null;
    const detail = e instanceof Error ? e.message : String(e);
    return `这个组合注册不了，多半是被别的软件占了（${detail}）`;
  }
}
