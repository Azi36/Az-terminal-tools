import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconDatabase, IconGauge, IconLink, IconPie, IconPlug, IconPulse, IconRefresh, IconTerminal, IconTrash, IconX,
} from "../components/icons";
import { fmtRate, fmtSize, fmtUptime } from "../format";

type Tab = "overview" | "proc" | "ports" | "docker" | "net" | "disk";

interface Probe {
  os: string;
  supported: boolean;
  prettyName: string;
  kernel: string;
  hostname: string;
  cpuModel: string;
  cores: number;
}

interface Cpu { name: string; total: number; idle: number }
interface Mem {
  total: number; free: number; available: number;
  buffers: number; cached: number; swapTotal: number; swapFree: number;
}
interface Nic { name: string; rx: number; tx: number }
interface Disk { source: string; mount: string; total: number; used: number; avail: number }

interface Sample {
  uptime: number;
  load: [number, number, number];
  cpus: Cpu[];
  mem: Mem;
  nics: Nic[];
  disks: Disk[];
  sessions: number;
}

interface Proc {
  pid: number; ppid: number; user: string;
  cpu: number; mem: number; rss: number;
  state: string; command: string;
}

interface Port { proto: string; addr: string; port: number; process: string; pid: number }
interface Ports { rows: Port[]; tool: string; blind: boolean }
interface Service { unit: string; load: string; active: string; sub: string; description: string }

interface Container { id: string; name: string; image: string; state: string; status: string; ports: string }

interface DuEntry { name: string; path: string; size: number }
interface DuListing { path: string; parent: string | null; total: number; entries: DuEntry[]; skipped: number }

/** 一次采样连同它落地的时刻 —— 算占用率和速率都得靠两次之间的时间差 */
interface Shot { at: number; sample: Sample }

/** 留几轮历史画曲线。2 秒一轮的话，60 轮正好是两分钟 */
const KEEP = 60;

interface StatsPanelProps {
  /** 连着的会话 id；没连上就只摆个空面板 */
  sessionId: string | null;
  /** 这一页正显示着才轮询 —— 切走了就别再占着服务器 */
  active: boolean;
  onActivity?: () => void;
  /**
   * 把服务器上某个端口转发到本地。
   * 端口表里那些「仅本机」的（3306、6379 这类）正是最常要转发的东西，
   * 在这儿直接给出口，省得记下端口号再跑去隧道页手填一遍。
   */
  onForward?: (remotePort: number, label: string) => void;
  /** 往当前终端里塞一条命令（「进这个容器」用的） */
  onRunInTerminal?: (command: string) => void;
}

const errText = (e: unknown): string =>
  e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);

/** KiB → 人话（后端那几个数全是 KiB） */
const kib = (value: number) => fmtSize(value * 1024);

/** 占用率配色：跟 r-shell 一个路子，颜色本身带信息 */
function level(pct: number): string {
  if (pct >= 90) return "hot";
  if (pct >= 70) return "warm";
  return "";
}

/**
 * 一条走势线。用不着图表库：几十个点连一条折线，
 * viewBox 固定 100×28、preserveAspectRatio 关掉，宽度交给 CSS 拉。
 */
function Spark({ points, max }: { points: number[]; max: number }) {
  if (points.length < 2) return <div className="spark-empty" />;
  const top = Math.max(max, 1);
  const step = 100 / (points.length - 1);
  const path = points
    .map((value, i) => `${(i * step).toFixed(2)},${(28 - Math.min(value / top, 1) * 27).toFixed(2)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,28 ${path} 100,28`} className="spark-fill" />
      <polyline points={path} className="spark-line" />
    </svg>
  );
}

function Bar({ pct, label }: { pct: number; label?: string }) {
  const value = Math.max(0, Math.min(100, pct));
  return (
    <div className="st-bar" title={label} role="img" aria-label={label ?? `${value.toFixed(0)}%`}>
      <i className={level(value)} style={{ width: `${value}%` }} />
    </div>
  );
}

/**
 * 服务器状态面板。
 *
 * 全部靠读 `/proc` 和 `df` / `ps` / `du`，服务器上不用装任何东西。
 * 采集走的是终端那条 SSH 连接上另开的子通道，不二次认证、也不占用交互 shell。
 */
export function StatsPanel({ sessionId, active, onActivity, onForward, onRunInTerminal }: StatsPanelProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<Shot[]>([]);
  /** 几秒一轮；用户嫌费流量可以拉长 */
  const [period, setPeriod] = useState(2);

  const beat = useRef(onActivity);
  beat.current = onActivity;

  // 换一条会话（断开重连也算）就把上一台的数据丢干净，
  // 不然重连后头一屏会拿旧计数器减新计数器，画出一根假尖峰
  useEffect(() => {
    setProbe(null);
    setHistory([]);
    setErr(null);
  }, [sessionId]);

  // 探底只做一次：发行版、内核、核数这些一条会话里不会变
  useEffect(() => {
    if (!sessionId || !active || probe) return;
    let dead = false;
    invoke<Probe>("stats_probe", { sessionId })
      .then((one) => { if (!dead) { setProbe(one); setErr(null); } })
      .catch((e) => { if (!dead) setErr(errText(e)); });
    return () => { dead = true; };
  }, [sessionId, active, probe]);

  // 轮询。用自续的 setTimeout 而不是 setInterval：服务器慢的时候
  // setInterval 会让请求一轮压一轮，越堆越多。
  useEffect(() => {
    if (!sessionId || !active || !probe?.supported) return;
    let dead = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const sample = await invoke<Sample>("stats_sample", { sessionId });
        if (dead) return;
        setErr(null);
        setHistory((old) => [...old, { at: Date.now(), sample }].slice(-KEEP));
      } catch (e) {
        if (!dead) setErr(errText(e));
      }
      if (!dead) timer = window.setTimeout(tick, period * 1000);
    };
    void tick();
    return () => { dead = true; if (timer) window.clearTimeout(timer); };
  }, [sessionId, active, probe?.supported, period]);

  const latest = history.length > 0 ? history[history.length - 1] : null;
  const previous = history.length > 1 ? history[history.length - 2] : null;

  /** CPU 占用：两次采样之间，非 idle 的时间占了多大比例 */
  const cpuPct = useMemo(() => {
    if (!latest || !previous) return null;
    const now = latest.sample.cpus[0];
    const before = previous.sample.cpus[0];
    if (!now || !before) return null;
    const span = now.total - before.total;
    if (span <= 0) return null;
    return Math.max(0, Math.min(100, (1 - (now.idle - before.idle) / span) * 100));
  }, [latest, previous]);

  /** 每个核各自的占用，用来看「是不是只有一个核在忙」 */
  const cores = useMemo(() => {
    if (!latest || !previous) return [];
    return latest.sample.cpus.slice(1).map((now, i) => {
      const before = previous.sample.cpus[i + 1];
      if (!before) return 0;
      const span = now.total - before.total;
      if (span <= 0) return 0;
      return Math.max(0, Math.min(100, (1 - (now.idle - before.idle) / span) * 100));
    });
  }, [latest, previous]);

  /** 网卡速率：字节差 ÷ 时间差。网卡热插拔（容器起停）时按名字对，对不上就当 0 */
  const net = useMemo(() => {
    if (!latest || !previous) return { rx: 0, tx: 0 };
    const seconds = (latest.at - previous.at) / 1000;
    if (seconds <= 0) return { rx: 0, tx: 0 };
    let rx = 0;
    let tx = 0;
    for (const now of latest.sample.nics) {
      const before = previous.sample.nics.find((one) => one.name === now.name);
      if (!before) continue;
      rx += Math.max(0, now.rx - before.rx);
      tx += Math.max(0, now.tx - before.tx);
    }
    return { rx: rx / seconds, tx: tx / seconds };
  }, [latest, previous]);

  /** CPU 曲线：整段历史逐对算一遍 */
  const cpuSeries = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < history.length; i += 1) {
      const now = history[i].sample.cpus[0];
      const before = history[i - 1].sample.cpus[0];
      if (!now || !before) continue;
      const span = now.total - before.total;
      out.push(span > 0 ? Math.max(0, Math.min(100, (1 - (now.idle - before.idle) / span) * 100)) : 0);
    }
    return out;
  }, [history]);

  const netSeries = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < history.length; i += 1) {
      const seconds = (history[i].at - history[i - 1].at) / 1000;
      if (seconds <= 0) { out.push(0); continue; }
      let moved = 0;
      for (const now of history[i].sample.nics) {
        const before = history[i - 1].sample.nics.find((one) => one.name === now.name);
        if (!before) continue;
        moved += Math.max(0, now.rx - before.rx) + Math.max(0, now.tx - before.tx);
      }
      out.push(moved / seconds);
    }
    return out;
  }, [history]);

  const memSeries = useMemo(
    () => history.map(({ sample }) =>
      sample.mem.total > 0 ? ((sample.mem.total - sample.mem.available) / sample.mem.total) * 100 : 0),
    [history],
  );

  if (!sessionId) {
    return (
      <div className="page st-page">
        <div className="page-body st-body">
          <p className="page-hint">连上之后这里会显示这台机器的实时状态。</p>
        </div>
      </div>
    );
  }

  if (probe && !probe.supported) {
    return (
      <div className="page st-page">
        <div className="page-body st-body">
          <div className="st-blank">
            <b>这台是 {probe.os || "未知系统"}，状态面板还看不了它</b>
            <p>
              面板靠读 <code>/proc</code> 取数，只有 Linux 有。
              硬凑别的系统的接口能画出图来，但那些数是半真半假的，不如不画。
            </p>
          </div>
        </div>
      </div>
    );
  }

  const mem = latest?.sample.mem;
  const memPct = mem && mem.total > 0 ? ((mem.total - mem.available) / mem.total) * 100 : 0;
  const swapPct = mem && mem.swapTotal > 0 ? ((mem.swapTotal - mem.swapFree) / mem.swapTotal) * 100 : 0;

  return (
    <div className="page st-page" onMouseDown={() => beat.current?.()}>
      <div className="st-head">
        <div className="seg mini">
          <button type="button" className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>
            <IconGauge size={13} />概览
          </button>
          <button type="button" className={tab === "proc" ? "on" : ""} onClick={() => setTab("proc")}>
            <IconPulse size={13} />进程
          </button>
          <button type="button" className={tab === "ports" ? "on" : ""} onClick={() => setTab("ports")}>
            <IconPlug size={13} />端口与服务
          </button>
          <button type="button" className={tab === "docker" ? "on" : ""} onClick={() => setTab("docker")}>
            <IconDatabase size={13} />容器
          </button>
          <button type="button" className={tab === "net" ? "on" : ""} onClick={() => setTab("net")}>
            <IconLink size={13} />网络
          </button>
          <button type="button" className={tab === "disk" ? "on" : ""} onClick={() => setTab("disk")}>
            <IconPie size={13} />磁盘占用
          </button>
        </div>

        <span className="foot-spacer" />

        {probe && (
          <span className="st-who" title={[probe.prettyName, probe.kernel, probe.cpuModel].filter(Boolean).join(" · ")}>
            {probe.hostname || "—"}
            {probe.prettyName && <small>{probe.prettyName}</small>}
          </span>
        )}

        {tab === "overview" && (
          <select
            className="enc-pick"
            value={period}
            aria-label="刷新间隔"
            title="多久取一次数。取数本身很轻，但弱网上拉长一点更稳"
            onChange={(e) => setPeriod(Number(e.target.value))}
          >
            <option value={1}>1 秒</option>
            <option value={2}>2 秒</option>
            <option value={5}>5 秒</option>
            <option value={10}>10 秒</option>
          </select>
        )}
      </div>

      {err && <p className="st-err">{err}</p>}

      <div className="page-body st-body">
        {tab === "overview" && (
          !latest ? (
            <p className="page-hint">正在取第一轮数据……</p>
          ) : (
            <>
              <div className="st-tiles">
                <section className="st-tile">
                  <header>
                    <b>CPU</b>
                    {/* 第一轮没有前一次可减，占用率算不出来，如实说「—」 */}
                    <em className={level(cpuPct ?? 0)}>{cpuPct === null ? "—" : `${cpuPct.toFixed(1)}%`}</em>
                  </header>
                  <Spark points={cpuSeries} max={100} />
                  <footer>
                    <span title="1 / 5 / 15 分钟平均负载">
                      负载 {latest.sample.load.map((one) => one.toFixed(2)).join(" / ")}
                    </span>
                    {probe && probe.cores > 0 && <small>{probe.cores} 核</small>}
                  </footer>
                  {cores.length > 1 && (
                    <div className="st-cores" title="每个核各自的占用">
                      {cores.map((pct, i) => (
                        <i key={i} className={level(pct)} style={{ height: `${Math.max(3, pct)}%` }} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="st-tile">
                  <header>
                    <b>内存</b>
                    <em className={level(memPct)}>{memPct.toFixed(1)}%</em>
                  </header>
                  <Spark points={memSeries} max={100} />
                  <footer>
                    {/* 用「总量 − available」而不是 used：缓存也算「free」那套，
                        Linux 上会吓人一跳，available 才是真正还能拿去用的 */}
                    <span>{mem ? `${kib(mem.total - mem.available)} / ${kib(mem.total)}` : "—"}</span>
                    {mem && mem.swapTotal > 0 && (
                      <small className={swapPct > 50 ? "warn" : ""}>
                        交换区 {swapPct.toFixed(0)}%
                      </small>
                    )}
                  </footer>
                </section>

                <section className="st-tile">
                  <header>
                    <b>网络</b>
                    <em>{fmtRate(net.rx + net.tx)}</em>
                  </header>
                  <Spark points={netSeries} max={Math.max(...netSeries, 1024)} />
                  <footer>
                    <span>↓ {fmtRate(net.rx)}　↑ {fmtRate(net.tx)}</span>
                    <small>{latest.sample.nics.length} 个网卡</small>
                  </footer>
                </section>

                <section className="st-tile st-tile-plain">
                  <header><b>这台机器</b></header>
                  <dl className="st-facts">
                    <dt>已运行</dt><dd>{fmtUptime(latest.sample.uptime)}</dd>
                    <dt>登录会话</dt><dd>{latest.sample.sessions}</dd>
                    {probe?.kernel && (<><dt>内核</dt><dd title={probe.kernel}>{probe.kernel}</dd></>)}
                    {probe?.cpuModel && (<><dt>处理器</dt><dd title={probe.cpuModel}>{probe.cpuModel}</dd></>)}
                  </dl>
                </section>
              </div>

              <section className="page-card st-card">
                <h3>磁盘</h3>
                {latest.sample.disks.length === 0 ? (
                  <p className="page-hint">没读到真实挂载的磁盘（tmpfs 这类不算）。</p>
                ) : (
                  <div className="st-mounts">
                    {latest.sample.disks.map((one) => {
                      const pct = one.total > 0 ? (one.used / one.total) * 100 : 0;
                      return (
                        <div className="st-mount" key={`${one.source}-${one.mount}`}>
                          <div className="st-mount-top">
                            <b title={one.source}>{one.mount}</b>
                            <span className={level(pct)}>{pct.toFixed(0)}%</span>
                          </div>
                          <Bar pct={pct} label={`${one.mount} 用了 ${pct.toFixed(0)}%`} />
                          <small>{kib(one.used)} / {kib(one.total)}　剩 {kib(one.avail)}</small>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )
        )}

        {tab === "proc" && <ProcTab sessionId={sessionId} active={active} />}
        {tab === "ports" && <PortsTab sessionId={sessionId} onForward={onForward} />}
        {tab === "docker" && <DockerTab sessionId={sessionId} onRunInTerminal={onRunInTerminal} />}
        {tab === "net" && <NetTab sessionId={sessionId} />}
        {tab === "disk" && <DiskTab sessionId={sessionId} />}
      </div>
    </div>
  );
}

// ─────────────────────────── 进程 ───────────────────────────

type Sort = "cpu" | "mem";

function ProcTab({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [rows, setRows] = useState<Proc[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("cpu");
  const [auto, setAuto] = useState(true);
  const [killing, setKilling] = useState<Proc | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRows(await invoke<Proc[]>("stats_processes", { sessionId }));
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  // 进程表比概览沉（几百行），5 秒一轮就够看趋势了
  useEffect(() => {
    if (!active) return;
    let dead = false;
    let timer: number | undefined;
    const tick = async () => {
      await load();
      if (!dead && auto) timer = window.setTimeout(tick, 5000);
    };
    void tick();
    return () => { dead = true; if (timer) window.clearTimeout(timer); };
  }, [active, auto, load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? rows.filter((one) =>
          one.command.toLowerCase().includes(needle) ||
          one.user.toLowerCase().includes(needle) ||
          String(one.pid) === needle)
      : rows;
    return [...list].sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss)).slice(0, 200);
  }, [rows, q, sort]);

  return (
    <>
      <div className="st-toolbar">
        <input
          className="st-search"
          value={q}
          placeholder="按命令、用户或 PID 找"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="seg mini">
          <button type="button" className={sort === "cpu" ? "on" : ""} onClick={() => setSort("cpu")}>按 CPU</button>
          <button type="button" className={sort === "mem" ? "on" : ""} onClick={() => setSort("mem")}>按内存</button>
        </div>
        <label className="check-row" title="每 5 秒重新取一次">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动刷新
        </label>
        <button className="btn-ghost sm" type="button" disabled={busy} onClick={() => void load()}>
          <IconRefresh size={13} />{busy ? "取数中" : "刷新"}
        </button>
        <span className="st-count">{shown.length} / {rows.length}</span>
      </div>

      {err && <p className="st-err">{err}</p>}

      <div className="st-table-wrap">
        <table className="st-table">
          <thead>
            <tr>
              <th className="num">PID</th>
              <th>用户</th>
              <th className="num">CPU</th>
              <th className="num">内存</th>
              <th className="num">常驻</th>
              <th>状态</th>
              <th>命令</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((one) => (
              <tr key={one.pid}>
                <td className="num">{one.pid}</td>
                <td>{one.user}</td>
                <td className={`num ${level(one.cpu)}`}>{one.cpu.toFixed(1)}</td>
                <td className="num">{one.mem.toFixed(1)}</td>
                <td className="num">{kib(one.rss)}</td>
                <td><code className="st-state" title={one.state}>{one.state}</code></td>
                <td className="st-cmd" title={one.command}>{one.command}</td>
                <td>
                  <button
                    className="icon-btn sm"
                    type="button"
                    title="结束这个进程"
                    onClick={() => setKilling(one)}
                  >
                    <IconTrash size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && !busy && <p className="page-hint">没有对得上的进程。</p>}
      </div>

      <p className="st-note">
        CPU 那一列是 <code>ps</code> 给的、进程活到现在的<b>平均</b>占用，
        不是这一瞬间的 —— 跟 <code>top</code> 对不上属于正常。
      </p>

      {killing && (
        <KillDialog
          sessionId={sessionId}
          target={killing}
          onClose={() => setKilling(null)}
          onDone={() => { setKilling(null); void load(); }}
        />
      )}
    </>
  );
}

const SIGNALS: { value: string; label: string; hint: string }[] = [
  { value: "TERM", label: "TERM", hint: "礼貌地请它退出，程序有机会收尾（等同 kill）" },
  { value: "INT", label: "INT", hint: "跟在终端里按 Ctrl+C 一样" },
  { value: "HUP", label: "HUP", hint: "很多守护进程收到它是「重新读配置」，不是退出" },
  { value: "KILL", label: "KILL", hint: "立刻弄死，不给收尾机会 —— 没存的数据就丢了" },
];

function KillDialog({
  sessionId, target, onClose, onDone,
}: { sessionId: string; target: Proc; onClose: () => void; onDone: () => void }) {
  const [signal, setSignal] = useState("TERM");
  const [sudo, setSudo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("stats_kill", { sessionId, pid: target.pid, signal, sudo });
      onDone();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>结束进程 {target.pid}</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭"><IconX size={15} /></button>
        </div>
        <div className="modal-body">
          <p className="dialog-msg st-kill-cmd">{target.command}</p>
          <p className="dialog-msg dim">属主 {target.user}　常驻内存 {kib(target.rss)}</p>

          <label className="field">
            <span>发哪个信号</span>
            <select value={signal} onChange={(e) => setSignal(e.target.value)}>
              {SIGNALS.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}
            </select>
            <em className="field-hint">{SIGNALS.find((one) => one.value === signal)?.hint}</em>
          </label>

          <label className="check-row" title="要求这台机器上配了免密 sudo">
            <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} />
            用 sudo 发
          </label>
          {sudo && (
            <em className="field-hint">
              只在配了免密 sudo 时管用。要输密码的机器上这里代劳不了，会直接告诉你去终端页手动做。
            </em>
          )}

          {err && <p className="st-err">{err}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn-primary danger" type="button" disabled={busy} onClick={() => void go()}>
            {busy ? "发送中……" : `发 ${signal}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── 端口与服务 ───────────────────────────

/** 绑在通配地址上就是对外能连的，`127.0.0.1` / `::1` 只有本机自己能连 */
const facesOut = (addr: string) => addr === "0.0.0.0" || addr === "::" || addr === "*";

const ACTION_LABEL: Record<string, string> = {
  start: "启动", stop: "停止", restart: "重启", reload: "重载配置",
};

/**
 * 这个状态下摆哪几个按钮。
 * 全都摆出来的话每行四个，一屏几十行就成了一片按钮墙；
 * 而且「对着已经 dead 的服务点停止」本来也没有意义。
 */
function actionsFor(active: string): string[] {
  if (active === "active") return ["restart", "reload", "stop"];
  if (active === "activating" || active === "deactivating") return ["stop"];
  return ["start"];
}

function PortsTab({ sessionId, onForward }: { sessionId: string; onForward?: (remotePort: number, label: string) => void }) {
  const [ports, setPorts] = useState<Ports | null>(null);
  const [portErr, setPortErr] = useState<string | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [svcErr, setSvcErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  /** 只看没在正常跑的 —— 打开这一页多半就是来找哪个挂了的 */
  const [onlyBad, setOnlyBad] = useState(false);
  const [acting, setActing] = useState<{ svc: Service; action: string } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    // 两边各自成败，一边没有（比如不用 systemd）不该把另一边也拖没
    const [p, s] = await Promise.allSettled([
      invoke<Ports>("stats_ports", { sessionId }),
      invoke<Service[]>("stats_services", { sessionId }),
    ]);
    if (p.status === "fulfilled") { setPorts(p.value); setPortErr(null); } else { setPortErr(errText(p.reason)); }
    if (s.status === "fulfilled") { setServices(s.value); setSvcErr(null); } else { setSvcErr(errText(s.reason)); }
    setBusy(false);
  }, [sessionId]);

  // 端口和服务都是变化很慢的东西，没必要轮询，进来取一次、要看新的自己点刷新
  useEffect(() => { void load(); }, [load]);

  const shownSvc = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return services.filter((one) => {
      if (onlyBad && one.active === "active") return false;
      if (!needle) return true;
      return one.unit.toLowerCase().includes(needle) || one.description.toLowerCase().includes(needle);
    });
  }, [services, q, onlyBad]);

  const failed = services.filter((one) => one.active === "failed").length;

  return (
    <>
      <div className="st-toolbar">
        <button className="btn-ghost sm" type="button" disabled={busy} onClick={() => void load()}>
          <IconRefresh size={13} />{busy ? "取数中" : "刷新"}
        </button>
        <span className="st-count">
          {ports ? `${ports.rows.length} 个监听口` : "—"}
          {services.length > 0 && ` · ${services.length} 个服务`}
          {failed > 0 && <b className="hot">　{failed} 个 failed</b>}
        </span>
      </div>

      <section className="page-card st-card">
        <h3>监听端口{ports?.tool && <em className="st-tool">来自 {ports.tool}</em>}</h3>
        {portErr && <p className="st-err">{portErr}</p>}
        {ports?.blind && (
          <p className="st-note">
            一个进程名都没读到 —— 多半是没用 root 连。端口是真的，占着它的是谁看不到。
          </p>
        )}
        {ports && ports.rows.length > 0 && (
          <div className="st-table-wrap short">
            <table className="st-table">
              <thead>
                <tr>
                  <th className="num">端口</th>
                  <th>协议</th>
                  <th>绑定地址</th>
                  <th>暴露</th>
                  <th>进程</th>
                  <th className="num">PID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ports.rows.map((one) => (
                  <tr key={`${one.proto}-${one.addr}-${one.port}`}>
                    <td className="num">{one.port}</td>
                    <td><code className="st-state">{one.proto}</code></td>
                    <td className="st-mono">{one.addr}</td>
                    <td className="st-nowrap">
                      {facesOut(one.addr)
                        ? <span className="warn" title="任何能连到这台机器的人都能访问">对外</span>
                        : <span className="dim">仅本机</span>}
                    </td>
                    {/* 这一列吃掉剩下的宽度：进程名长短最没准，别去挤地址和端口 */}
                    <td className="st-cmd">{one.process || "—"}</td>
                    <td className="num">{one.pid || "—"}</td>
                    <td className="st-nowrap">
                      {onForward && one.proto.startsWith("tcp") && (
                        <button
                          className="link-quiet"
                          type="button"
                          title="在本机开一个口，连它等于连到这台服务器的这个端口"
                          onClick={() => onForward(one.port, one.process || String(one.port))}
                        >
                          转发到本地
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="page-card st-card">
        <h3>服务</h3>
        {svcErr ? (
          <p className="st-note">{svcErr}</p>
        ) : (
          <>
            <div className="st-toolbar">
              <input
                className="st-search"
                value={q}
                placeholder="按单元名或描述找"
                spellCheck={false}
                onChange={(e) => setQ(e.target.value)}
              />
              <label className="check-row" title="把 active 的收起来">
                <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />
                只看没在跑的
              </label>
              <span className="st-count">{shownSvc.length} / {services.length}</span>
            </div>

            <div className="st-table-wrap">
              <table className="st-table">
                <thead>
                  <tr>
                    <th>单元</th>
                    <th>状态</th>
                    <th>描述</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shownSvc.map((one) => (
                    <tr key={one.unit}>
                      <td className="st-mono st-unit" title={one.unit}>{one.unit.replace(/\.service$/, "")}</td>
                      <td className="st-nowrap">
                        <span className={one.active === "failed" ? "hot" : one.active === "active" ? "" : "dim"}>
                          {one.active}
                        </span>
                        <small className="st-sub"> · {one.sub}</small>
                      </td>
                      <td className="st-cmd" title={one.description}>{one.description}</td>
                      <td className="st-svc-acts">
                        {actionsFor(one.active).map((act) => (
                          <button
                            key={act}
                            className="link-quiet"
                            type="button"
                            onClick={() => setActing({ svc: one, action: act })}
                          >
                            {ACTION_LABEL[act]}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shownSvc.length === 0 && !busy && <p className="page-hint">没有对得上的服务。</p>}
            </div>
          </>
        )}
      </section>

      {acting && (
        <ServiceDialog
          sessionId={sessionId}
          svc={acting.svc}
          action={acting.action}
          onClose={() => setActing(null)}
          onDone={() => { setActing(null); void load(); }}
        />
      )}
    </>
  );
}

function ServiceDialog({
  sessionId, svc, action, onClose, onDone,
}: { sessionId: string; svc: Service; action: string; onClose: () => void; onDone: () => void }) {
  // systemctl 改状态基本都要 root，默认就把勾打上，省得人人都要点一下
  const [sudo, setSudo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = ACTION_LABEL[action] ?? action;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("stats_service_do", { sessionId, unit: svc.unit, action, sudo });
      onDone();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>{label} {svc.unit.replace(/\.service$/, "")}</h3>
          <button className="icon-btn sm" type="button" onClick={onClose} aria-label="关闭"><IconX size={15} /></button>
        </div>
        <div className="modal-body">
          <p className="dialog-msg st-kill-cmd">systemctl {action} {svc.unit}</p>
          <p className="dialog-msg dim">
            {svc.description || "（没有描述）"}　现在是 {svc.active} / {svc.sub}
          </p>
          {(action === "stop" || action === "restart") && (
            <p className="dialog-msg warn">
              这会真的动服务器上正在跑的东西 —— 确认这台是你想动的那台。
            </p>
          )}

          <label className="check-row" title="要求这台机器上配了免密 sudo">
            <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} />
            用 sudo 执行
          </label>
          <em className="field-hint">
            只在配了免密 sudo 时管用。要输密码或者 polkit 拦着的机器上，这里会直接告诉你去终端页手动做。
          </em>

          {err && <p className="st-err">{err}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" type="button" onClick={onClose}>取消</button>
          <button
            className={action === "stop" || action === "restart" ? "btn-primary danger" : "btn-primary"}
            type="button"
            disabled={busy}
            onClick={() => void go()}
          >
            {busy ? "执行中……" : label}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── 网络工具 ───────────────────────────

const NET_TOOLS: { value: string; label: string; hint: string }[] = [
  { value: "ping", label: "ping", hint: "从这台服务器 ping 过去，看通不通、延迟多少" },
  { value: "port", label: "端口探测", hint: "从这台服务器连一下对方的某个端口，看开没开" },
  { value: "dns", label: "DNS 解析", hint: "用这台服务器自己的 DNS 解一个域名 —— 内网域名常常只有它解得出来" },
  { value: "traceroute", label: "路由追踪", hint: "看包从这台服务器出去走了哪几跳（慢，要等一会儿）" },
];

function NetTab({ sessionId }: { sessionId: string }) {
  const [tool, setTool] = useState("ping");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("443");
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!target.trim()) return;
    setBusy(true);
    setErr(null);
    setOut(null);
    try {
      setOut(await invoke<string>("stats_net_probe", {
        sessionId,
        tool,
        target: target.trim(),
        port: tool === "port" ? Number(port) || 443 : null,
      }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="st-toolbar">
        <div className="seg mini wrap">
          {NET_TOOLS.map((one) => (
            <button key={one.value} type="button" className={tool === one.value ? "on" : ""} onClick={() => setTool(one.value)}>
              {one.label}
            </button>
          ))}
        </div>
        <input
          className="st-search grow"
          value={target}
          placeholder="主机名或 IP，比如 10.0.0.31 或 db.internal"
          spellCheck={false}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void go()}
        />
        {tool === "port" && (
          <input
            className="st-search"
            style={{ width: 90 }}
            value={port}
            placeholder="端口"
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && !busy && void go()}
          />
        )}
        <button className="btn-primary sm" type="button" disabled={busy || !target.trim()} onClick={() => void go()}>
          {busy ? "跑着呢……" : "执行"}
        </button>
      </div>

      <p className="st-note">{NET_TOOLS.find((one) => one.value === tool)?.hint}</p>
      {err && <p className="st-err">{err}</p>}

      {out === null && !busy && !err && (
        <div className="st-blank">
          <b>从服务器那边看出去</b>
          <p>
            意义不在于「有个图形界面」—— 在于这几条是<b>在这台服务器上跑的</b>。
            你本机 ping 得通不代表它 ping 得通；内网域名多半也只有它解得出来。
            排查「服务连不上下游」的时候，差的常常就是这一步。
          </p>
        </div>
      )}

      {out !== null && <div className="st-logbox wide"><pre>{out}</pre></div>}
    </>
  );
}

// ─────────────────────────── 容器 ───────────────────────────

const DOCKER_LABEL: Record<string, string> = {
  start: "启动", stop: "停止", restart: "重启", kill: "强杀",
};

/** 这个状态下摆哪几个按钮 —— 对着已经停了的容器点「停止」没有意义 */
const dockerActionsFor = (state: string) =>
  state === "running" ? ["restart", "stop", "kill"] : ["start"];

function DockerTab({
  sessionId, onRunInTerminal,
}: { sessionId: string; onRunInTerminal?: (command: string) => void }) {
  const [rows, setRows] = useState<Container[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** docker 常常要 root；错一次之后把这个勾上再试是最常见的下一步 */
  const [sudo, setSudo] = useState(false);
  const [acting, setActing] = useState<{ one: Container; action: string } | null>(null);
  const [logs, setLogs] = useState<{ one: Container; text: string } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRows(await invoke<Container[]>("stats_docker", { sessionId, sudo }));
      setErr(null);
    } catch (e) {
      setErr(errText(e));
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, [sessionId, sudo]);

  // 容器状态变得不算快，进来取一次就够，要看新的自己点刷新
  useEffect(() => { void load(); }, [load]);

  const showLogs = async (one: Container) => {
    setBusy(true);
    try {
      const text = await invoke<string>("stats_docker_logs", { sessionId, id: one.id, sudo });
      setLogs({ one, text: text.trimEnd() || "（这个容器还没有日志）" });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!acting) return;
    setBusy(true);
    try {
      await invoke("stats_docker_do", { sessionId, id: acting.one.id, action: acting.action, sudo });
      setActing(null);
      await load();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  const running = rows?.filter((one) => one.state === "running").length ?? 0;

  return (
    <>
      <div className="st-toolbar">
        <button className="btn-ghost sm" type="button" disabled={busy} onClick={() => void load()}>
          <IconRefresh size={13} />{busy ? "取数中" : "刷新"}
        </button>
        <label className="check-row" title="这台机器上 docker 要 root 的话勾上（需要免密 sudo）">
          <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} />
          用 sudo
        </label>
        {rows && <span className="st-count">{running} 个在跑 / 共 {rows.length} 个</span>}
      </div>

      {err && <p className="st-err">{err}</p>}

      {rows && rows.length === 0 && !busy && (
        <div className="st-blank">
          <b>这台机器上一个容器都没有</b>
          <p>docker 是装着的、守护进程也在跑，只是 <code>docker ps -a</code> 是空的。</p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th>名字</th>
                <th>状态</th>
                <th>镜像</th>
                <th>端口</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((one) => (
                <tr key={one.id}>
                  <td className="st-mono st-unit" title={one.id}>{one.name}</td>
                  <td className="st-nowrap">
                    <span className={one.state === "running" ? "" : one.state === "exited" ? "dim" : "warn"}>
                      {one.state}
                    </span>
                    <small className="st-sub"> · {one.status}</small>
                  </td>
                  <td className="st-cmd" title={one.image}>{one.image}</td>
                  <td className="st-mono">{one.ports || "—"}</td>
                  <td className="st-svc-acts">
                    <button className="link-quiet" type="button" onClick={() => void showLogs(one)}>日志</button>
                    {one.state === "running" && onRunInTerminal && (
                      <button
                        className="link-quiet"
                        type="button"
                        title="把 docker exec 那条命令送进终端 —— 交互式的东西得在真终端里跑"
                        onClick={() => onRunInTerminal(
                          `${sudo ? "sudo " : ""}docker exec -it ${one.id.slice(0, 12)} sh`,
                        )}
                      >
                        <IconTerminal size={12} />进去
                      </button>
                    )}
                    {dockerActionsFor(one.state).map((act) => (
                      <button key={act} className="link-quiet" type="button" onClick={() => setActing({ one, action: act })}>
                        {DOCKER_LABEL[act]}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="st-note">
        「进去」是把 <code>docker exec -it … sh</code> 送进终端页执行的 ——
        交互式的东西得在真终端里跑，这个面板的通道后面没有 PTY。
      </p>

      {acting && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setActing(null)}>
          <div className="modal">
            <div className="modal-head">
              <h3>{DOCKER_LABEL[acting.action]} {acting.one.name}</h3>
              <button className="icon-btn sm" type="button" onClick={() => setActing(null)} aria-label="关闭"><IconX size={15} /></button>
            </div>
            <div className="modal-body">
              <p className="dialog-msg st-kill-cmd">
                {sudo ? "sudo " : ""}docker {acting.action} {acting.one.id.slice(0, 12)}
              </p>
              <p className="dialog-msg dim">{acting.one.image}　现在是 {acting.one.status}</p>
              {(acting.action === "stop" || acting.action === "kill" || acting.action === "restart") && (
                <p className="dialog-msg warn">这会真的动服务器上正在跑的东西 —— 确认这台是你想动的那台。</p>
              )}
              {acting.action === "kill" && (
                <p className="dialog-msg dim">强杀不给容器收尾的机会，没落盘的数据会丢。停不下来时才用它。</p>
              )}
              {/* 失败了要在弹窗里说：画在弹窗背后的错误没人看得见，用户会以为没点上再点一次 */}
              {err && <p className="dialog-msg warn">{err}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" type="button" onClick={() => setActing(null)}>取消</button>
              <button
                className={acting.action === "start" ? "btn-primary" : "btn-primary danger"}
                type="button"
                disabled={busy}
                onClick={() => void run()}
              >
                {busy ? "执行中……" : DOCKER_LABEL[acting.action]}
              </button>
            </div>
          </div>
        </div>
      )}

      {logs && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setLogs(null)}>
          <div className="modal wide">
            <div className="modal-head">
              <h3>{logs.one.name} 的日志</h3>
              <button className="icon-btn sm" type="button" onClick={() => setLogs(null)} aria-label="关闭"><IconX size={15} /></button>
            </div>
            <div className="modal-body">
              <div className="st-logbox"><pre>{logs.text}</pre></div>
              <em className="field-hint">只取了最后 300 行。跑了几个月的容器日志几个 G 是常事，整个拖回来没意义。</em>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────── 磁盘占用 ───────────────────────────

function DiskTab({ sessionId }: { sessionId: string }) {
  const [path, setPath] = useState("/");
  const [listing, setListing] = useState<DuListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // du 是真会跑很久的（大盘上几十秒起步），所以不自动跑、也不轮询，
  // 每一次都得用户自己点 —— 别让人切过来就无意中给服务器上了个负载
  const scan = useCallback(async (target: string) => {
    setBusy(true);
    setErr(null);
    try {
      const one = await invoke<DuListing>("stats_du", { sessionId, path: target });
      setListing(one);
      setPath(one.path);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const biggest = listing && listing.entries.length > 0 ? listing.entries[0].size : 0;
  /** 子目录之和跟总量的差 —— 那部分是直接躺在这一层的文件 */
  const loose = listing
    ? Math.max(0, listing.total - listing.entries.reduce((sum, one) => sum + one.size, 0))
    : 0;

  return (
    <>
      <div className="st-toolbar">
        <button
          className="btn-ghost sm"
          type="button"
          disabled={busy || !listing?.parent}
          onClick={() => listing?.parent && void scan(listing.parent)}
        >
          上一级
        </button>
        <input
          className="st-search grow"
          value={path}
          spellCheck={false}
          placeholder="/var"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void scan(path)}
        />
        <button className="btn-primary sm" type="button" disabled={busy} onClick={() => void scan(path)}>
          {busy ? "量着呢……" : "量一下"}
        </button>
      </div>

      {err && <p className="st-err">{err}</p>}

      {!listing && !busy && !err && (
        <div className="st-blank">
          <b>看看是什么把盘吃满了</b>
          <p>
            填一个目录（比如 <code>/var</code>）点「量一下」，它会列出各个子目录各占多少，点进去还能接着往下钻。
            底下走的是 <code>du -x</code>：不跨文件系统，所以不会顺着 <code>/proc</code>、网络挂载爬出去。
          </p>
          <p className="dim">大目录要跑一会儿，这也是它不自动跑、不轮询的原因。</p>
        </div>
      )}

      {listing && (
        <>
          <div className="st-du-head">
            <b>{listing.path}</b>
            <span>共 {kib(listing.total)}</span>
            {listing.skipped > 0 && (
              <em className="warn" title="多半是没权限进去，这些目录没算进总数">
                {listing.skipped} 个子目录没读进去，数偏小
              </em>
            )}
          </div>

          <div className="st-du">
            {listing.entries.map((one) => (
              <button
                className="st-du-row"
                type="button"
                key={one.path}
                disabled={busy}
                title={`进 ${one.path}`}
                onClick={() => void scan(one.path)}
              >
                <span className="st-du-name">{one.name}</span>
                <span className="st-du-bar">
                  <i style={{ width: `${biggest > 0 ? (one.size / biggest) * 100 : 0}%` }} />
                </span>
                <span className="st-du-size">{kib(one.size)}</span>
                <span className="st-du-pct">
                  {listing.total > 0 ? `${((one.size / listing.total) * 100).toFixed(0)}%` : ""}
                </span>
              </button>
            ))}
            {loose > 0 && (
              <div className="st-du-row loose" title="不在任何子目录里、直接放在这一层的文件">
                <span className="st-du-name">（这一层的文件）</span>
                <span className="st-du-bar">
                  <i style={{ width: `${biggest > 0 ? Math.min(100, (loose / biggest) * 100) : 0}%` }} />
                </span>
                <span className="st-du-size">{kib(loose)}</span>
                <span className="st-du-pct">
                  {listing.total > 0 ? `${((loose / listing.total) * 100).toFixed(0)}%` : ""}
                </span>
              </div>
            )}
            {listing.entries.length === 0 && <p className="page-hint">这一层没有子目录。</p>}
          </div>
        </>
      )}
    </>
  );
}
