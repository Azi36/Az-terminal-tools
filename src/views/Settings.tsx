import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fmtDuration, fmtRate, fmtSize, fmtWhen } from "../format";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  adoptForeign, adoptSshConfig, applyBackup, exportAll, pickBackup, scanForeign, scanSshConfig, sourceLabel,
  syncPull, syncPush, unseal, type ConfigHost, type Found,
} from "../backup";
import type { Release } from "../update";
import { SHORTCUT_GROUPS } from "../shortcuts";
import {
  IconCheck,
  IconDownload,
  IconLock,
  IconMonitor,
  IconMoon,
  IconServer,
  IconSun,
  IconTerminal,
  IconX, IconCommand } from "../components/icons";
import { FONT_SIZES, TERM_SCHEMES } from "../termThemes";
import { HOTKEYS } from "../hotkey";
import { Dialog, type DialogSpec } from "../components/Dialog";
import type { ThemeMode } from "../theme";

interface SettingsProps {
  mode: ThemeMode;
  onModeChange: (mode: ThemeMode) => void;
  /** 空闲多少分钟自动断开；0 = 不断 */
  idleMinutes: number;
  onIdleChange: (minutes: number) => void;
  termScheme: string;
  termFontSize: number;
  /** 用户选的：auto / dark / light */
  termVariant: "auto" | "dark" | "light";
  termDivider: boolean;
  /** 此刻实际生效的那版，色板预览按它画 */
  previewVariant: "dark" | "light";
  onTermChange: (patch: {
    termScheme?: string;
    termFontSize?: number;
    termVariant?: "auto" | "dark" | "light";
    termDivider?: boolean;
  }) => void;
  hostPolicy: string;
  onHostPolicyChange: (policy: "auto" | "ask" | "off") => void;
  /** 同时传几个文件 */
  xferLanes: number;
  onLanesChange: (lanes: number) => void;
  autoReconnect: boolean;
  onReconnectChange: (on: boolean) => void;
  restoreTabs: boolean;
  onRestoreChange: (on: boolean) => void;
  updateNotice: boolean;
  onUpdateNoticeChange: (on: boolean) => void;
  hotkey: string;
  onHotkeyChange: (accelerator: string) => void;
  /** 本地终端用哪个 shell；空 = 自动 */
  localShell: string;
  onLocalShellChange: (shell: string) => void;
  syncUrl: string;
  syncUser: string;
  syncedAt: number;
  onSyncChange: (next: { syncUrl?: string; syncUser?: string; syncedAt?: number }) => void;
  /** 上一次注册热键失败的原因；没失败就是 null */
  hotkeyErr: string | null;
  /** 后端提示的新版本；没有就是 null */
  fresh: Release | null;
  /** 此刻连着的会话数：装完更新要重启，得先把这句说清楚 */
  liveSessions: number;
  /** 导入完要让上层把连接、指令这些重新读一遍 */
  onDataChanged: () => void;
  onClose: () => void;
  version: string;
}

const MODES: { value: ThemeMode; label: string; icon: typeof IconSun }[] = [
  { value: "light", label: "浅色", icon: IconSun },
  { value: "dark", label: "深色", icon: IconMoon },
  { value: "system", label: "跟随系统", icon: IconMonitor },
];

const IDLE_CHOICES = [
  { value: 0, label: "不断" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
];

const VARIANTS: { value: "auto" | "dark" | "light"; label: string }[] = [
  { value: "auto", label: "跟随界面" },
  { value: "dark", label: "深版" },
  { value: "light", label: "浅版" },
];

const HOST_POLICIES: { value: "auto" | "ask" | "off"; label: string }[] = [
  { value: "auto", label: "自动记住" },
  { value: "ask", label: "头回问我" },
  { value: "off", label: "不校验" },
];

/** 三张全宽卡片：连接 / 外观 / 关于，里头再分小节 */
/**
 * 更新走的四步。之前界面上只有一句「下载中……」——包几十兆，用户看着一句不动的话
 * 分不出「在下」还是「卡死了」，于是把每一步和下载进度都摆出来。
 */
type UpdatePhase = "idle" | "checking" | "downloading" | "installing" | "done";

interface UpdateState {
  /** done = 装好了，就差重启；重启这一下留给用户自己点 */
  state: UpdatePhase;
  /** 正在更新到哪一版 */
  version?: string;
  /** 已下载字节 */
  got?: number;
  /** 总字节。服务器不报 Content-Length 时没有，这时进度条走不确定态 */
  total?: number;
  /** 字节 / 秒，滑动平均过的 */
  rate?: number;
  note?: string;
  tone?: "ok" | "bad";
}

const UPDATE_STEPS: { key: UpdatePhase; label: string }[] = [
  { key: "checking", label: "检查" },
  { key: "downloading", label: "下载" },
  { key: "installing", label: "安装" },
  { key: "done", label: "重启生效" },
];

/** 更新进行时的那块卡片：走到第几步、下了多少、多快、还剩多久 */
function UpdateProgress({ update }: { update: UpdateState }) {
  const at = UPDATE_STEPS.findIndex((one) => one.key === update.state);
  if (at < 0) return null;
  const { got = 0, total, rate = 0 } = update;
  const pct = total ? Math.min(100, (got / total) * 100) : 0;
  const left = total && rate > 0 ? fmtDuration((total - got) / rate) : "";

  return (
    <div className="up-card">
      <div className="up-steps">
        {UPDATE_STEPS.map((one, i) => (
          <div className={`up-step ${i < at ? "past" : i === at ? "now" : ""}`} key={one.key}>
            <i>{i < at ? <IconCheck size={11} /> : i + 1}</i>
            <span>{one.label}</span>
          </div>
        ))}
      </div>

      {update.state === "downloading" && (
        <>
          {/* 总大小拿不到时用不确定条：与其编一个假的百分比，不如老实说「在下，不知道还剩多少」 */}
          <div className={`up-bar ${total ? "" : "guessing"}`}>
            <i style={total ? { width: `${pct}%` } : undefined} />
          </div>
          <div className="up-meta">
            <span>{total ? `${fmtSize(got)} / ${fmtSize(total)}` : `已下载 ${fmtSize(got)}`}</span>
            <span className="up-dot" />
            <span>{rate > 0 ? fmtRate(rate) : "连接中……"}</span>
            {left && (<><span className="up-dot" /><span>还剩 {left}</span></>)}
            {total ? <b>{pct.toFixed(0)}%</b> : null}
          </div>
        </>
      )}

      {update.state === "checking" && <p className="up-say">正在问有没有新版……</p>}
      {update.state === "installing" && (
        <>
          <div className="up-bar guessing"><i /></div>
          <p className="up-say">校验签名、写入安装包，这一步不能中断。</p>
        </>
      )}
    </div>
  );
}

export function Settings({
  mode,
  onModeChange,
  idleMinutes,
  onIdleChange,
  termScheme,
  termFontSize,
  termVariant,
  termDivider,
  previewVariant,
  onTermChange,
  hostPolicy,
  onHostPolicyChange,
  xferLanes,
  onLanesChange,
  autoReconnect,
  onReconnectChange,
  restoreTabs,
  onRestoreChange,
  updateNotice,
  onUpdateNoticeChange,
  hotkey,
  localShell,
  onLocalShellChange,
  onHotkeyChange,
  hotkeyErr,
  syncUrl,
  syncUser,
  syncedAt,
  onSyncChange,
  fresh,
  liveSessions,
  onDataChanged,
  onClose,
  version,
}: SettingsProps) {
  // 导出 / 导入 / 扫 ssh config 的即时反馈，就在按钮旁边说一句
  /** 「自动」实际会挑到哪个 shell，占位符里给用户看一眼 */
  const [defaultShell, setDefaultShell] = useState("");
  useEffect(() => { invoke<string>("pty_default_shell").then(setDefaultShell).catch(() => {}); }, []);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ hosts: ConfigHost[]; already: number } | null>(null);
  /** 要口令的那两下（加密导出 / 解开导入）共用这一个弹窗 */
  const [ask, setAsk] = useState<DialogSpec | null>(null);
  /** 从别的工具的文件里认出来的那些，等用户过一眼再决定导不导 */
  const [foreign, setForeign] = useState<Found[] | null>(null);

  const run = async (job: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      const said = await job();
      if (said) setNote({ tone: "ok", text: said });
    } catch (e) {
      const text = e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);
      setNote({ tone: "bad", text });
    } finally {
      setBusy(false);
    }
  };

  const doExport = () => run(async () => {
    const path = await exportAll();
    return path ? `导出好了：${path}` : null;
  });

  const doExportSealed = () => {
    setAsk({
      title: "给这份备份设个口令",
      message: "导出的文件会用这个口令加密。忘了就真的打不开了 —— 这里没有找回，也没有后门。",
      input: { label: "口令（至少 8 个字符）", placeholder: "一句只有你想得起来的话", secret: true },
      confirmText: "加密导出",
      onConfirm: (passphrase) => run(async () => {
        const path = await exportAll(passphrase);
        return path ? `加密导出好了：${path}` : null;
      }),
    });
  };

  /** 套用一份已经是明文的备份，并把结果说成人话 */
  const absorb = async (content: string) => {
    const result = await applyBackup(content);
    onDataChanged();
    const parts = [
      result.connections && `${result.connections} 条连接`,
      result.snippets && `${result.snippets} 条指令`,
      result.notes && `${result.notes} 条备忘`,
      result.bookmarks && `${result.bookmarks} 个收藏`,
    ].filter(Boolean);
    return parts.length ? `导入了 ${parts.join(" · ")}` : "文件里没有可导入的内容";
  };

  const doImport = () => run(async () => {
    const picked = await pickBackup();
    if (!picked) return null;
    // 明文的直接进；加密的先停下来问口令，问完再走同一条路
    if (!picked.sealed) return absorb(picked.content);
    setAsk({
      title: "这份备份是加密的",
      message: "输入导出时设的那个口令。",
      input: { label: "口令", secret: true },
      confirmText: "解开并导入",
      onConfirm: (passphrase) => run(async () => absorb(await unseal(picked.content, passphrase))),
    });
    return null;
  });

  const doScan = () => run(async () => {
    const result = await scanSshConfig();
    setFound(result);
    if (result.hosts.length === 0) {
      return result.already > 0 ? `~/.ssh/config 里那 ${result.already} 台都已经有了` : "~/.ssh/config 里没找到可导入的服务器";
    }
    return null;
  });

  // —— 检查更新 ——
  // 「有没有新版」那一问走 api.azi36.com（国内直达，见 update.ts）；
  // 这里这个 check() 是真去下更新包的，走 GitHub，有签名校验。
  // 分开是因为 api.github.com 国内经常拉不动 —— 拉不动的后果不是"提示晚了"，
  // 是用户永远不知道有新版。
  const [update, setUpdate] = useState<UpdateState>({ state: "idle" });
  /** 下载的计速用的采样点。放 ref 里：每来一个包都 setState 是白烧一遍渲染 */
  const pace = useRef({ at: 0, got: 0, mark: 0, rate: 0 });

  const checkUpdate = async () => {
    setUpdate({ state: "checking" });
    try {
      const found = await check();
      if (!found) {
        setUpdate({ state: "idle", note: `已经是最新的（v${version}）`, tone: "ok" });
        return;
      }
      pace.current = { at: Date.now(), got: 0, mark: 0, rate: 0 };
      setUpdate({ state: "downloading", version: found.version, got: 0 });
      await found.downloadAndInstall((event) => {
        if (event.event === "Started") {
          // contentLength 后端不一定给（分块传输就没有）：给不出总数就走不确定进度条
          pace.current = { at: Date.now(), got: 0, mark: 0, rate: 0 };
          setUpdate((one) => ({ ...one, state: "downloading", got: 0, total: event.data.contentLength || undefined }));
          return;
        }
        if (event.event === "Progress") {
          pace.current.got += event.data.chunkLength;
          const now = Date.now();
          const span = now - pace.current.at;
          // 400ms 采一次样：更新包几十兆、包上千个，每个都往界面上推没有意义
          if (span < 400) return;
          const spot = ((pace.current.got - pace.current.mark) * 1000) / span;
          // 滑动平均，不然网络一抖数字就乱跳
          pace.current.rate = pace.current.rate ? pace.current.rate * 0.7 + spot * 0.3 : spot;
          pace.current.at = now;
          pace.current.mark = pace.current.got;
          setUpdate((one) => ({ ...one, got: pace.current.got, rate: pace.current.rate }));
          return;
        }
        if (event.event === "Finished") {
          // 下完到装完之间没有进度可报，但这一段是真的要等（校验签名 + 落盘），得让界面说一声
          setUpdate((one) => ({ ...one, state: "installing", got: one.total ?? pace.current.got }));
        }
      });
      // 装好了**不自动重启**：重启等于把所有开着的会话掐掉、没保存的编辑器内容丢掉。
      // 用户点的可能只是「检查一下」，不该顺手替他做这个决定。
      setUpdate({ state: "done", version: found.version, note: `v${found.version} 装好了，重启之后生效`, tone: "ok" });
    } catch (e) {
      setUpdate({
        state: "idle",
        note: `更新没成：${e instanceof Error ? e.message : String(e)}`,
        tone: "bad",
      });
    }
  };

  // —— WebDAV 同步 ——
  const [hasSyncPw, setHasSyncPw] = useState(false);
  useEffect(() => { invoke<boolean>("sync_has_password").then(setHasSyncPw).catch(() => {}); }, []);

  /** 上传和下载都要那个加密口令，所以两下都先弹同一个框问一次 */
  const withPassphrase = (title: string, message: string, confirmText: string, job: (pw: string) => Promise<string | null>) => {
    setAsk({
      title,
      message,
      input: { label: "加密口令", secret: true, hint: "跟加密导出用的是同一套。忘了没有找回。" },
      confirmText,
      onConfirm: (passphrase) => run(() => job(passphrase)),
    });
  };

  const doPush = () => withPassphrase(
    "上传到网盘",
    "本机这份配置会加密后传上去，覆盖服务器上那份。",
    "上传",
    async (passphrase) => {
      await syncPush(syncUrl.trim(), syncUser.trim(), passphrase);
      onSyncChange({ syncedAt: Date.now() });
      return "传上去了。";
    },
  );

  const doPull = () => withPassphrase(
    "从网盘拉下来",
    "服务器上那份会盖到本机：同一条连接按 id 覆盖，其余追加。本机独有的不会被删掉。",
    "拉下来",
    async (passphrase) => {
      const result = await syncPull(syncUrl.trim(), syncUser.trim(), passphrase);
      if (result === null) return "服务器上还没有这个文件 —— 先在一台机器上传一次。";
      // 先把拉下来的读进内存，再记同步时间：反过来会拿旧设置把刚导入的盖掉
      onDataChanged();
      onSyncChange({ syncedAt: Date.now() });
      const parts = [
        result.connections && `${result.connections} 条连接`,
        result.snippets && `${result.snippets} 条指令`,
        result.notes && `${result.notes} 条备忘`,
        result.bookmarks && `${result.bookmarks} 个收藏`,
      ].filter(Boolean);
      return parts.length ? `拉下来了：${parts.join(" · ")}` : "服务器上那份是空的";
    },
  );

  const doSavePw = () => {
    setAsk({
      title: "存网盘密码",
      message: "存进系统钥匙串（Windows 凭据管理器 / macOS 钥匙串），不落配置文件。",
      input: { label: "WebDAV 密码", secret: true, hint: "坚果云这类网盘要填「应用密码」，不是登录密码。" },
      confirmText: "存起来",
      onConfirm: (password) => run(async () => {
        await invoke("sync_save_password", { password });
        setHasSyncPw(true);
        return "存好了。";
      }),
    });
  };

  const syncReady = syncUrl.trim() !== "" && hasSyncPw;

  const doForeign = () => run(async () => {
    const rows = await scanForeign();
    if (rows === null) return null;
    setForeign(rows);
    return rows.length === 0 ? "这些文件里没认出服务器 —— 换个导出格式试试，或者用 ~/.ssh/config 那条路" : null;
  });

  const takeForeign = (rows: Found[]) => {
    const count = adoptForeign(rows);
    setForeign(null);
    onDataChanged();
    setNote({
      tone: "ok",
      text: count > 0
        ? `导入了 ${count} 台，在侧栏「导入」分组里。密码第一次连的时候再输。`
        : "这些机器库里都已经有了，没重复添加。",
    });
  };

  const adopt = (hosts: ConfigHost[]) => {
    const count = adoptSshConfig(hosts);
    setFound(null);
    onDataChanged();
    setNote({ tone: "ok", text: `导入了 ${count} 台，在侧栏「ssh config」分组里。密码第一次连的时候再输。` });
  };

  return (
    <div className="page">
      <header className="page-head">
        <h2>设置</h2>
        <span className="page-sub">改完即时生效，全存在本机</span>
        <span className="foot-spacer" />
        <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭" title="关闭标签">
          <IconX size={15} />
        </button>
      </header>

      <div className="page-body">
        <div className="page-stack">
          <section className="page-card">
            <h3><IconServer size={14} />连接</h3>

            <div className="card-group">
              <h4>空闲自动断开<em className={idleMinutes === 0 ? "off" : "on"}>{idleMinutes === 0 ? "从不" : `${idleMinutes} 分钟`}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  没输入也没输出这么久就先断开，切回那个标签会自动接上。默认「不断」——挂着跑的活儿不该被我掐掉；关标签、关窗口，连接都是立刻断的。
                </p>
                <div className="seg" role="radiogroup" aria-label="空闲自动断开">
                  {IDLE_CHOICES.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      role="radio"
                      aria-checked={idleMinutes === choice.value}
                      className={idleMinutes === choice.value ? "on" : ""}
                      onClick={() => onIdleChange(choice.value)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>主机指纹校验<em className={hostPolicy === "off" ? "warn" : "on"}>{HOST_POLICIES.find((one) => one.value === hostPolicy)?.label}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  跟系统 ssh 共用一份记录。默认「自动记住」：头一回连的机器直接记下来不打扰你，指纹变了才拦住报警 —— 那才是该停下来看一眼的时候。
                </p>
                <div className="seg" role="radiogroup" aria-label="主机指纹校验">
                  {HOST_POLICIES.map((one) => (
                    <button
                      key={one.value}
                      type="button"
                      role="radio"
                      aria-checked={hostPolicy === one.value}
                      className={hostPolicy === one.value ? "on" : ""}
                      onClick={() => onHostPolicyChange(one.value)}
                    >
                      {one.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>掉线自动重连<em className={autoReconnect ? "on" : "off"}>{autoReconnect ? "开着" : "关着"}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  网抖一下、Wi-Fi 换个热点，自己接回来，最多试 4 次（3 秒 → 6 秒 → 12 秒这样往后退）。
                  只在手上有凭据（记过密码或用密钥）时才自动接；你自己点的「断开」不算掉线。
                </p>
                <div className="seg" role="radiogroup" aria-label="掉线自动重连">
                  <button type="button" role="radio" aria-checked={autoReconnect}
                    className={autoReconnect ? "on" : ""} onClick={() => onReconnectChange(true)}>开</button>
                  <button type="button" role="radio" aria-checked={!autoReconnect}
                    className={!autoReconnect ? "on" : ""} onClick={() => onReconnectChange(false)}>关</button>
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>记住上次的标签<em className={restoreTabs ? "on" : "off"}>{restoreTabs ? "开着" : "关着"}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  下次打开时把上次那些标签摆回来。<b>不会自动连</b> —— 一启动就往一堆服务器上连不合适，
                  标签在那儿，点一下「连接」就行。
                </p>
                <div className="seg" role="radiogroup" aria-label="记住上次的标签">
                  <button type="button" role="radio" aria-checked={restoreTabs}
                    className={restoreTabs ? "on" : ""} onClick={() => onRestoreChange(true)}>开</button>
                  <button type="button" role="radio" aria-checked={!restoreTabs}
                    className={!restoreTabs ? "on" : ""} onClick={() => onRestoreChange(false)}>关</button>
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>同时传几个文件<em className="on">{xferLanes} 个</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  一堆小文件时开大能快好几倍（时间都花在来回上，不是带宽）；线路不稳或服务器抠门就调回 1。
                  大文件不受影响，反正一个就吃满了。
                </p>
                <div className="seg" role="radiogroup" aria-label="同时传几个文件">
                  {[1, 2, 3, 5].map((count) => (
                    <button
                      key={count}
                      type="button"
                      role="radio"
                      aria-checked={xferLanes === count}
                      className={xferLanes === count ? "on" : ""}
                      onClick={() => onLanesChange(count)}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>凭据保管<em className="ok">系统钥匙串</em></h4>
              <p className="page-meta">
                勾了「记住」的密码存进 Windows 凭据管理器 / macOS 钥匙串，我们自己的文件里没有明文。连接配置、指令、备忘全在本机，不出这台机器；想撤销某台的记忆，打开那条连接的配置页点「忘掉」。
              </p>
            </div>
          </section>

          <section className="page-card">
            <h3><IconDownload size={14} />数据</h3>

            <div className="card-group">
              <h4>备份与迁移</h4>
              <div className="row-between">
                <p className="page-meta">
                  连接、指令、备忘、收藏、偏好设置导成一个 JSON 文件，换机器搬过去就行。
                  <b>密码不在里面</b> —— 它们在系统钥匙串里，导成明文就把「不落明文」这件事作废了；
                  到新机器第一次连的时候再输一次。
                  <br />
                  文件要经网盘、聊天工具或者邮件走一趟的话用<b>加密导出</b>：里面虽然没有密码，
                  但主机名、用户名、跳板机链路、内网端口本身就是情报。口令忘了没有找回。
                </p>
                <div className="data-acts">
                  <button className="btn-ghost sm" type="button" disabled={busy} onClick={doExport}>导出</button>
                  <button
                    className="btn-ghost sm"
                    type="button"
                    disabled={busy}
                    onClick={doExportSealed}
                    title="用口令加密：里面没有密码，但主机名和内网拓扑本身就是情报"
                  >
                    加密导出
                  </button>
                  <button className="btn-ghost sm" type="button" disabled={busy} onClick={doImport}>导入</button>
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>从 ~/.ssh/config 导入</h4>
              <div className="row-between">
                <p className="page-meta">
                  服务器清单本来就在 ssh 配置文件里的话，直接读进来，不用重敲一遍。只读不改，你的 ssh 配置一个字都不动。
                </p>
                <div className="data-acts">
                  <button className="btn-ghost sm" type="button" disabled={busy} onClick={doScan}>看看有什么</button>
                </div>
              </div>

              {found && found.hosts.length > 0 && (
                <div className="cfg-found">
                  <div className="cfg-head">
                    找到 {found.hosts.length} 台还没导入的
                    {found.already > 0 && <small>（另有 {found.already} 台已经在库里了）</small>}
                  </div>
                  <div className="cfg-list">
                    {found.hosts.map((one) => (
                      <div className="cfg-row" key={`${one.alias}-${one.host}-${one.port}`}>
                        <b>{one.alias}</b>
                        <span>{one.user || "root"}@{one.host}{one.port === 22 ? "" : `:${one.port}`}</span>
                        {one.keyPath && <small title={one.keyPath}>密钥</small>}
                      </div>
                    ))}
                  </div>
                  <div className="cfg-acts">
                    <button className="btn-ghost sm" type="button" onClick={() => setFound(null)}>算了</button>
                    <button className="btn-primary sm" type="button" onClick={() => adopt(found.hosts)}>
                      全部导入
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="card-group">
              <h4>从别的工具导入</h4>
              <div className="row-between">
                <p className="page-meta">
                  认 Xshell 的 <code>.xsh</code>、PuTTY 导出的 <code>.reg</code>，
                  以及 Termius 这类工具导出的 JSON。可以一次选多个文件。
                  <br />
                  只取<b>主机、端口、用户名</b>三样。<b>密码不认</b> —— 那几家的密码是用它们自己的
                  密钥加密的，解得开也不该解。导进来第一次连的时候自己输一次。
                </p>
                <div className="data-acts">
                  <button className="btn-ghost sm" type="button" disabled={busy} onClick={doForeign}>选文件</button>
                </div>
              </div>

              {foreign && foreign.length > 0 && (
                <div className="cfg-found">
                  <div className="cfg-head">认出 {foreign.length} 台</div>
                  <div className="cfg-list">
                    {foreign.map((one) => (
                      <div className="cfg-row" key={`${one.host}-${one.port}-${one.username}`}>
                        <b>{one.name}</b>
                        <span>{one.username || "root"}@{one.host}{one.port === 22 ? "" : `:${one.port}`}</span>
                        <small>{sourceLabel(one.source)}</small>
                      </div>
                    ))}
                  </div>
                  <div className="cfg-acts">
                    <button className="btn-ghost sm" type="button" onClick={() => setForeign(null)}>算了</button>
                    <button className="btn-primary sm" type="button" onClick={() => takeForeign(foreign)}>全部导入</button>
                  </div>
                </div>
              )}
            </div>

            <div className="card-group">
              <h4>网盘同步<em className={syncReady ? "on" : "off"}>{syncReady ? "配好了" : "没配"}</em></h4>
              <p className="page-meta">
                把加密后的备份放到自己的 WebDAV 网盘上，换台机器拉回来。
                <b>只有你点的时候才发生</b> —— 没有自动同步、没有后台轮询。
                <br />
                传上去的<b>永远是密文</b>，这一条不给开关：备份里虽然没有密码，
                但主机名、用户名、跳板机链路、内网端口就是一张内网地图。
              </p>
              <div className="form-grid">
                <label className="field span2">
                  <span>文件地址</span>
                  <input
                    value={syncUrl}
                    spellCheck={false}
                    placeholder="https://dav.jianguoyun.com/dav/我的坚果云/az-term.json"
                    onChange={(e) => onSyncChange({ syncUrl: e.target.value })}
                  />
                  <em className="field-hint">要指到一个<b>文件</b>，不是目录。上级目录得先在网盘里建好。</em>
                </label>
                <label className="field">
                  <span>用户名</span>
                  <input
                    value={syncUser}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="邮箱或账号"
                    onChange={(e) => onSyncChange({ syncUser: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>密码</span>
                  <div className="field-row">
                    <button className="btn-ghost sm" type="button" disabled={busy} onClick={doSavePw}>
                      {hasSyncPw ? "换一个" : "填一个"}
                    </button>
                    {hasSyncPw && <em className="field-hint">已存进钥匙串</em>}
                  </div>
                </label>
              </div>
              <div className="row-between">
                <p className="page-meta">
                  {syncedAt > 0 ? `上次同步：${fmtWhen(syncedAt)}` : "还没同步过"}
                </p>
                <div className="data-acts">
                  <button className="btn-ghost sm" type="button" disabled={busy || !syncReady} onClick={doPush}>上传</button>
                  <button className="btn-ghost sm" type="button" disabled={busy || !syncReady} onClick={doPull}>拉下来</button>
                </div>
              </div>
            </div>

            {note && (
              <p className={`data-note ${note.tone}`}>{note.text}</p>
            )}
          </section>

          <section className="page-card">
            <h3><IconSun size={14} />外观</h3>

            <div className="card-group">
              <h4>应用主题<em className="on">{mode === "system" ? "跟随系统" : mode === "dark" ? "深色" : "浅色"}</em></h4>
              <div className="row-between">
                <p className="page-meta">侧栏、标签、设置这些界面用哪种色；选「跟随系统」就跟着系统的深浅色一起变。终端画布的配色在下面单独设。</p>
                <div className="seg" role="radiogroup" aria-label="主题">
                  {MODES.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={mode === value}
                      className={mode === value ? "on" : ""}
                      onClick={() => onModeChange(value)}
                    >
                      <Icon size={14} />{label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>命令分割线<em className={termDivider ? "on" : "off"}>{termDivider ? "已开" : "关着"}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  每敲一条命令，在输出前画一条带时间的细线，历史一眼能分段。只画在本地画布上，不会发给服务器；vim、top 这类全屏程序里自动不画。
                </p>
                <div className="seg" role="radiogroup" aria-label="命令分割线">
                  <button type="button" role="radio" aria-checked={termDivider}
                    className={termDivider ? "on" : ""} onClick={() => onTermChange({ termDivider: true })}>开</button>
                  <button type="button" role="radio" aria-checked={!termDivider}
                    className={!termDivider ? "on" : ""} onClick={() => onTermChange({ termDivider: false })}>关</button>
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>终端字号<em className="on">{termFontSize}px</em></h4>
              <div className="row-between">
                <p className="page-meta">改完所有开着的终端立刻跟着变，不用重连。</p>
                <div className="seg">
                  {FONT_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={termFontSize === size ? "on" : ""}
                      onClick={() => onTermChange({ termFontSize: size })}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-group">
              <h4>
                <IconTerminal size={13} />终端配色
                <em className="on">{TERM_SCHEMES.find((one) => one.id === termScheme)?.label} · {previewVariant === "dark" ? "深版" : "浅版"}</em>
              </h4>
              <div className="row-between">
                <p className="page-meta">每套配色都有深浅两版。默认跟着界面走——界面浅色，终端就用浅版。</p>
                <div className="seg" role="radiogroup" aria-label="终端深浅">
                  {VARIANTS.map((one) => (
                    <button
                      key={one.value}
                      type="button"
                      role="radio"
                      aria-checked={termVariant === one.value}
                      className={termVariant === one.value ? "on" : ""}
                      onClick={() => onTermChange({ termVariant: one.value })}
                    >
                      {one.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="scheme-grid">
                {TERM_SCHEMES.map((one) => {
                  const theme = one[previewVariant];
                  return (
                    <button
                      key={one.id}
                      type="button"
                      className={`scheme-card ${termScheme === one.id ? "on" : ""}`}
                      onClick={() => onTermChange({ termScheme: one.id })}
                      title={one.label}
                    >
                      <span className="scheme-preview" style={{ background: theme.background, color: theme.foreground }}>
                        <b style={{ color: theme.green }}>$</b>
                        <i style={{ background: theme.red }} />
                        <i style={{ background: theme.yellow }} />
                        <i style={{ background: theme.blue }} />
                        <i style={{ background: theme.magenta }} />
                        <i style={{ background: theme.cyan }} />
                      </span>
                      {one.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="page-card">
            <h3><IconCommand size={14} />快捷键</h3>
            <p className="page-meta">
              应用级的一律带 Shift 或 Alt：不带 Shift 的 Ctrl 组合在 shell 里都有正经用途（Ctrl+W 删词、Ctrl+P 上一条历史），
              终端有焦点时不抢。终端里右键也能看到这些。
            </p>
            <div className="keys-groups">
              {SHORTCUT_GROUPS.map((group) => (
                <div className="keys-group" key={group.title}>
                  <h4>{group.title}</h4>
                  {group.items.map((item) => (
                    <div className="keys-row" key={item.keys}>
                      <span>{item.what}</span>
                      <kbd>{item.keys}</kbd>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="page-card">
            <h3><IconLock size={14} />关于<em className="on">v{version}</em></h3>
            <div className="row-between">
              <div className="label">
                <b>AzTerm</b>
                <small>SSH · SFTP · 指令库 · 备忘录，免费无账号不过期</small>
              </div>
              <div className="data-acts">
                {update.state === "done" ? (
                  <button className="btn-primary sm" type="button" onClick={() => void relaunch()}>
                    重启生效
                  </button>
                ) : (
                  <button
                    className="btn-ghost sm"
                    type="button"
                    disabled={update.state !== "idle"}
                    onClick={checkUpdate}
                  >
                    {update.state === "idle" ? "检查更新" : <><span className="spin-dot" />在更新</>}
                  </button>
                )}
                <button className="btn-ghost sm" type="button" onClick={() => void openUrl("https://azi36.com")}>
                  去主站
                </button>
              </div>
            </div>
            {/* 后端提示有新版：把版本号和更新说明摆出来，点了才下载 */}
            {fresh && update.state === "idle" && !update.note && (
              <div className="rel-card">
                <div className="rel-head">
                  <b>{fresh.version} 可以更新了</b>
                  {fresh.pubDate && <small>{fresh.pubDate.slice(0, 10)} 发布</small>}
                </div>
                {fresh.notes && <pre className="rel-notes">{fresh.notes}</pre>}
                <div className="rel-acts">
                  <button className="btn-ghost sm" type="button" onClick={() => void openUrl(fresh.url)}>
                    去下载页
                  </button>
                  <button className="btn-primary sm" type="button" onClick={checkUpdate}>
                    直接更新
                  </button>
                </div>
              </div>
            )}

            {/* 检查 / 下载 / 安装 这三步都在这块卡片里报进度 */}
            <UpdateProgress update={update} />

            {update.note && (
              <p className={`data-note ${update.tone}`}>
                {update.note}
                {update.state === "done" && liveSessions > 0 && ` · 现在有 ${liveSessions} 条会话连着，重启会全部断开`}
              </p>
            )}

            <div className="card-group">
              <h4>本地终端<em className={localShell ? "on" : "off"}>{localShell ? "指定了 shell" : "自动"}</em></h4>
              <label className="field">
                <span>用哪个 shell</span>
                <input
                  value={localShell}
                  spellCheck={false}
                  placeholder={`留空自动挑：${defaultShell || "pwsh → PowerShell → $SHELL"}`}
                  onChange={(e) => onLocalShellChange(e.target.value)}
                />
                <em className="field-hint">
                  填可执行文件的路径或命令名（pwsh、bash、cmd.exe……）。已经开着的终端要重启才会换。
                  PowerShell 和 bash 会把当前目录报给 git 面板，zsh 暂时不会 —— 面板上可以手填目录。
                </em>
              </label>
            </div>

            <div className="card-group">
              <h4>全局热键<em className={hotkey ? "on" : "off"}>{hotkey ? "开着" : "关着"}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  不在前台也能一下把窗口叫出来，再按一下收回去 —— 想敲一条命令的时候不用先去找它。
                  这个键是<b>全系统</b>抢的，选一个别的软件用不到的。
                </p>
                <select
                  className="enc-pick"
                  value={hotkey}
                  aria-label="全局热键"
                  onChange={(e) => onHotkeyChange(e.target.value)}
                >
                  {HOTKEYS.map((one) => (
                    <option key={one.value} value={one.value}>{one.label}</option>
                  ))}
                </select>
              </div>
              {hotkeyErr && <p className="data-note bad">{hotkeyErr}</p>}
            </div>

            <div className="card-group">
              <h4>新版提示<em className={updateNotice ? "on" : "off"}>{updateNotice ? "开着" : "关着"}</em></h4>
              <div className="row-between">
                <p className="page-meta">
                  开起来几秒后问一句 api.azi36.com「有没有新版」——就一个 GET，不带身份、不上报任何东西，
                  拿不到就当没有。更新包本身还是从 GitHub 下（那条路有签名校验）。
                  嫌它连网就关掉，关了之后只有你点「检查更新」才会查。
                </p>
                <div className="seg" role="radiogroup" aria-label="新版提示">
                  <button type="button" role="radio" aria-checked={updateNotice}
                    className={updateNotice ? "on" : ""} onClick={() => onUpdateNoticeChange(true)}>开</button>
                  <button type="button" role="radio" aria-checked={!updateNotice}
                    className={!updateNotice ? "on" : ""} onClick={() => onUpdateNoticeChange(false)}>关</button>
                </div>
              </div>
            </div>
            <p className="page-meta">
              Azi36 家族第 002 号产品 AzTerm · 桌面版（Windows / macOS）<br />
              开源于 github.com/Azi36/Az-terminal-tools · 官网 term.azi36.com
            </p>
          </section>
        </div>
      </div>

      {ask && <Dialog {...ask} onClose={() => setAsk(null)} />}
    </div>
  );
}
