import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { adoptSshConfig, exportAll, importAll, scanSshConfig, type ConfigHost } from "../backup";
import type { Release } from "../update";
import {
  IconDownload,
  IconLock,
  IconMonitor,
  IconMoon,
  IconServer,
  IconSun,
  IconTerminal,
  IconX,
} from "../components/icons";
import { FONT_SIZES, TERM_SCHEMES } from "../termThemes";
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
  fresh,
  liveSessions,
  onDataChanged,
  onClose,
  version,
}: SettingsProps) {
  // 导出 / 导入 / 扫 ssh config 的即时反馈，就在按钮旁边说一句
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ hosts: ConfigHost[]; already: number } | null>(null);

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

  const doImport = () => run(async () => {
    const result = await importAll();
    if (!result) return null;
    onDataChanged();
    const parts = [
      result.connections && `${result.connections} 条连接`,
      result.snippets && `${result.snippets} 条指令`,
      result.notes && `${result.notes} 条备忘`,
      result.bookmarks && `${result.bookmarks} 个收藏`,
    ].filter(Boolean);
    return parts.length ? `导入了 ${parts.join(" · ")}` : "文件里没有可导入的内容";
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
  const [update, setUpdate] = useState<{
    /** done = 装好了，就差重启；重启这一下留给用户自己点 */
    state: "idle" | "checking" | "downloading" | "done";
    note?: string;
    tone?: "ok" | "bad";
  }>({ state: "idle" });

  const checkUpdate = async () => {
    setUpdate({ state: "checking" });
    try {
      const found = await check();
      if (!found) {
        setUpdate({ state: "idle", note: `已经是最新的（v${version}）`, tone: "ok" });
        return;
      }
      setUpdate({ state: "downloading", note: `发现 v${found.version}，下载中……`, tone: "ok" });
      await found.downloadAndInstall();
      // 装好了**不自动重启**：重启等于把所有开着的会话掐掉、没保存的编辑器内容丢掉。
      // 用户点的可能只是「检查一下」，不该顺手替他做这个决定。
      setUpdate({ state: "done", note: `v${found.version} 装好了，重启之后生效`, tone: "ok" });
    } catch (e) {
      setUpdate({
        state: "idle",
        note: `查不到更新：${e instanceof Error ? e.message : String(e)}`,
        tone: "bad",
      });
    }
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
                </p>
                <div className="data-acts">
                  <button className="btn-ghost sm" type="button" disabled={busy} onClick={doExport}>导出</button>
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
                  <button className="btn-ghost sm" type="button" disabled={update.state === "checking" || update.state === "downloading"} onClick={checkUpdate}>
                    {update.state === "checking" ? "查着……" : update.state === "downloading" ? "下载中……" : "检查更新"}
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

            {update.note && (
              <p className={`data-note ${update.tone}`}>
                {update.note}
                {update.state === "done" && liveSessions > 0 && ` · 现在有 ${liveSessions} 条会话连着，重启会全部断开`}
              </p>
            )}

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
    </div>
  );
}
