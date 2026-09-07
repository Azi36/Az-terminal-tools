import { useMemo } from "react";
import { Logo } from "../components/Logo";
import { IconCommand, IconDatabase, IconNote, IconPlus, IconServer, IconSettings, IconTerminal } from "../components/icons";
import { fmtWhen } from "../format";
import { SHORTCUTS } from "../shortcuts";
import { DB_KINDS, type Connection, type DbConn } from "../types";

interface HomeViewProps {
  version: string;
  connections: Connection[];
  dbs: DbConn[];
  onNewConn: () => void;
  onOpenConn: (conn: Connection) => void;
  onLocal: () => void;
  onNewDb: () => void;
  onOpenDb: (db: DbConn) => void;
  onNote: () => void;
  onPalette: () => void;
  onSettings: () => void;
}

/**
 * 开始页：标签栏空白处双击、Ctrl+Shift+N、或者一个标签都没有的时候看到的就是它。
 * 把所有「从这儿能开什么」摆成一排卡片，下面接最近连过的几台 —— 新手看一眼知道能干什么，老手直接点最近的。
 */
export function HomeView({ version, connections, dbs, onNewConn, onOpenConn, onLocal, onNewDb, onOpenDb, onNote, onPalette, onSettings }: HomeViewProps) {
  const recent = useMemo(() => {
    const conns = connections
      .filter((one) => one.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, 6)
      .map((one) => ({ key: `c:${one.id}`, name: one.name, sub: `${one.username}@${one.host}`, when: one.lastUsedAt ?? 0, color: one.color, icon: <IconServer size={14} />, open: () => onOpenConn(one) }));
    const dbList = dbs
      .filter((one) => one.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, 4)
      .map((one) => ({ key: `d:${one.id}`, name: one.name, sub: `${DB_KINDS.find((k) => k.value === one.kind)?.label ?? one.kind} · ${one.host}:${one.port}`, when: one.lastUsedAt ?? 0, color: one.color, icon: <IconDatabase size={14} />, open: () => onOpenDb(one) }));
    return [...conns, ...dbList].sort((a, b) => b.when - a.when).slice(0, 8);
  }, [connections, dbs]);

  const cards = [
    { title: "连一台服务器", sub: "SSH / SFTP，填主机和账号就能连", hint: SHORTCUTS.newConn, icon: <IconPlus size={18} />, run: onNewConn, primary: true },
    { title: "本机终端", sub: "在这台电脑上开个 shell，旁边带 git 面板", hint: SHORTCUTS.newLocal, icon: <IconTerminal size={18} />, run: onLocal },
    { title: "数据库", sub: "MySQL · PostgreSQL · Redis 的控制台", hint: "", icon: <IconDatabase size={18} />, run: onNewDb },
    { title: "记一条备忘", sub: "随手写，只在这台机器上", hint: "", icon: <IconNote size={18} />, run: onNote },
    { title: "命令面板", sub: "搜连接、片段、备忘，或者一个动作", hint: SHORTCUTS.palette, icon: <IconCommand size={18} />, run: onPalette },
    { title: "设置", sub: "终端配色、快捷键、备份和同步", hint: SHORTCUTS.settings, icon: <IconSettings size={18} />, run: onSettings },
  ];

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <span className="home-mark"><Logo size={40} /></span>
          <div>
            <h1>Az<span>Term</span></h1>
            <p>SSH · SFTP · 本地终端 · 数据库 · 指令库 · 备忘录，免费无账号不过期。<small>v{version}</small></p>
          </div>
        </header>

        <div className="home-cards">
          {cards.map((one) => (
            <button key={one.title} type="button" className={`home-card ${one.primary ? "primary" : ""}`} onClick={one.run}>
              <span className="home-card-icon">{one.icon}</span>
              <b>{one.title}</b>
              <small>{one.sub}</small>
              {one.hint && <kbd>{one.hint}</kbd>}
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <section className="home-recent">
            <h3>最近用过</h3>
            <div className="home-recent-list">
              {recent.map((one) => (
                <button key={one.key} type="button" className="home-recent-item" onClick={one.open} title="点一下打开">
                  <span className="status-dot" style={{ background: one.color }} />
                  {one.icon}
                  <span className="home-recent-main">
                    <b>{one.name}</b>
                    <small>{one.sub}</small>
                  </span>
                  <em>{fmtWhen(one.when)}</em>
                </button>
              ))}
            </div>
          </section>
        )}

        <p className="home-tips">
          左边的侧栏单击打开、双击直接连；标签栏空白处双击回到这一页；
          <kbd>{SHORTCUTS.nextTab}</kbd> 换标签，<kbd>{SHORTCUTS.closeTab}</kbd> 关标签，全部快捷键在设置里有速查表。
        </p>
      </div>
    </div>
  );
}
