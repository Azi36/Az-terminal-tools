import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconCheck, IconChevronDown, IconChevronRight, IconDownload, IconPlus, IconPulse,
  IconRefresh, IconTrash, IconUpload, IconX,
} from "./icons";
import { Dialog, type DialogSpec } from "./Dialog";

export interface GitChange { status: string; path: string }
export interface GitCommit { hash: string; subject: string; when: string }
export interface GitInfo {
  root: string;
  branch: string;
  detached: boolean;
  ahead: number;
  behind: number;
  upstream: boolean;
  changes: GitChange[];
  truncated: boolean;
  commits: GitCommit[];
  branches: string[];
  stashes: number;
}

/** 面板要按哪套规矩给参数加引号 —— 送进去的是用户自己的 shell，两边写法不一样 */
export type ShellFamily = "pwsh" | "posix" | "cmd";

interface GitPanelProps {
  git: GitInfo | null;
  /** git 跑不起来时的原话（没装、没权限……），跟「不是仓库」不是一回事 */
  error: string | null;
  /** shell 活着才让点，不然命令没地方去 */
  ready: boolean;
  /** shell 上不上报目录：不上报的话「cd 进去面板自己出来」这句是假的，得换个说法 */
  tracksCwd: boolean;
  shellFamily: ShellFamily;
  onRun: (cmd: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

/**
 * 给 shell 的参数加引号。两边都用单引号，图的是里头的 `$`、反引号、空格一律不生效
 * —— 提交说明里带个 `$` 是常事，双引号会被 shell 当变量吃掉。
 */
export function quoteArg(text: string, family: ShellFamily): string {
  if (family === "cmd") return `"${text.replace(/"/g, '""')}"`;
  if (family === "pwsh") return `'${text.replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** `R  old -> new` 这种改名条目，后面那个才是现在的路径 */
const realPath = (path: string): string => {
  const at = path.indexOf(" -> ");
  return at < 0 ? path : path.slice(at + 4);
};

/** 目录和文件名拆开显示：一列窄面板里，文件名比路径重要 */
const splitPath = (path: string): { dir: string; name: string } => {
  const clean = realPath(path);
  const at = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return at < 0 ? { dir: "", name: clean } : { dir: clean.slice(0, at), name: clean.slice(at + 1) };
};

const CODE_LABEL: Record<string, string> = {
  A: "增", M: "改", D: "删", R: "改名", C: "复制", T: "类型", U: "冲突", "?": "新",
};
const CODE_CLASS: Record<string, string> = {
  A: "new", M: "mod", D: "del", R: "mod", C: "mod", T: "mod", U: "conflict", "?": "new",
};

/** 冲突未解决的那几种状态码，git 自己的定义 */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

type Bucket = "conflict" | "staged" | "dirty" | "untracked";

interface Row { key: string; path: string; code: string; bucket: Bucket }

/**
 * porcelain 的两位状态码拆成「这个文件在暂存区怎么了 / 在工作区怎么了」。
 * 同一个文件可以两边都有（改完暂存又接着改，`MM`），所以一条记录可能落进两组。
 */
function bucketise(changes: GitChange[]): Row[] {
  const rows: Row[] = [];
  for (const one of changes) {
    const code = one.status.padEnd(2, " ");
    if (UNMERGED.has(code)) {
      rows.push({ key: `c:${one.path}`, path: one.path, code: "U", bucket: "conflict" });
      continue;
    }
    if (code === "??") {
      rows.push({ key: `u:${one.path}`, path: one.path, code: "?", bucket: "untracked" });
      continue;
    }
    if (code[0] !== " " && code[0] !== "?") rows.push({ key: `s:${one.path}`, path: one.path, code: code[0], bucket: "staged" });
    if (code[1] !== " " && code[1] !== "?") rows.push({ key: `d:${one.path}`, path: one.path, code: code[1], bucket: "dirty" });
  }
  return rows;
}

/** 一节可折叠的东西。展开收起走 CSS 过渡，不是啪一下没了 */
function Section({
  title, count, tools, open, onToggle, children,
}: {
  title: string;
  count?: number;
  tools?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`git-sec ${open ? "open" : ""}`}>
      <div className="git-sec-head">
        <button className="git-sec-toggle" type="button" onClick={onToggle} aria-expanded={open}>
          <span className="git-caret"><IconChevronRight size={12} /></span>
          {title}
          {count !== undefined && <em>{count}</em>}
        </button>
        {tools && <span className="git-sec-tools">{tools}</span>}
      </div>
      <div className="git-sec-body">{open && children}</div>
    </section>
  );
}

/**
 * 本地终端旁边那块 git 面板。
 *
 * 所有动作都是把命令送进左边的终端执行 —— 不在后台偷偷跑 git：
 * 用户看到的输出、hook 的报错、要输的密码，都跟他自己敲一模一样。
 * 面板只管把状态摆清楚，和少敲几个字。
 */
export function GitPanel({ git, error, ready, tracksCwd, shellFamily, onRun, onRefresh, onClose }: GitPanelProps) {
  const [msg, setMsg] = useState("");
  const [pickBranch, setPickBranch] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [allCommits, setAllCommits] = useState(false);
  const [ask, setAsk] = useState<DialogSpec | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({
    conflict: true, staged: true, dirty: true, untracked: true, commits: true, more: false,
  });
  const branchBox = useRef<HTMLDivElement>(null);

  // 分支下拉：点别处就收起来
  useEffect(() => {
    if (!pickBranch) return;
    const away = (e: MouseEvent) => {
      if (!branchBox.current?.contains(e.target as Node)) setPickBranch(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [pickBranch]);

  const rows = useMemo(() => (git ? bucketise(git.changes) : []), [git]);
  const groups = useMemo(() => ({
    conflict: rows.filter((r) => r.bucket === "conflict"),
    staged: rows.filter((r) => r.bucket === "staged"),
    dirty: rows.filter((r) => r.bucket === "dirty"),
    untracked: rows.filter((r) => r.bucket === "untracked"),
  }), [rows]);

  if (!git) {
    return (
      <aside className="git-panel">
        <div className="git-none">
          <IconPulse size={18} />
          <b>{error ? "git 面板出错" : "这儿不是 git 仓库"}</b>
          <small>
            {error
              ? error
              : tracksCwd
                ? "cd 进一个仓库，面板会自己出来。"
                : "这个 shell 不上报目录：点顶上的路径手填一个仓库目录。"}
          </small>
          <div className="git-none-acts">
            <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => onRun("git init")}>在这儿 git init</button>
            <button className="btn-ghost sm" type="button" onClick={onRefresh}><IconRefresh size={13} />刷新</button>
            <button className="btn-ghost sm" type="button" onClick={onClose}><IconChevronRight size={13} />收起</button>
          </div>
        </div>
      </aside>
    );
  }

  const q = (text: string) => quoteArg(text, shellFamily);
  const run = (cmd: string) => { if (ready) onRun(cmd); };
  const flip = (key: string) => setOpen((one) => ({ ...one, [key]: !one[key] }));
  const repoName = git.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || git.root;
  const staged = groups.staged.length;
  const canCommit = ready && msg.trim().length > 0 && (staged > 0 || groups.dirty.length > 0 || groups.untracked.length > 0);

  const commit = () => {
    const text = msg.replace(/\r/g, "").trimEnd();
    if (!text) return;
    // 一个都没暂存就先 add -A：否则 git 会直接报「nothing added to commit」，
    // 白让人重来一次。已经挑过要提交的东西就别自作主张替他多加。
    if (staged === 0) run("git add -A");
    run(`git commit -m ${q(text)}`);
    setMsg("");
  };

  const branches = git.branches.filter((one) => one.toLowerCase().includes(branchFilter.trim().toLowerCase()));

  const discard = (row: Row) => {
    const path = realPath(row.path);
    if (row.bucket === "untracked") {
      setAsk({
        title: "删掉这个没跟踪的文件？",
        message: `${path}\n\ngit 里没有它的任何记录，删了找不回来。`,
        confirmText: "删掉",
        danger: true,
        onConfirm: () => run(`git clean -f -- ${q(path)}`),
      });
      return;
    }
    setAsk({
      title: "把这个文件的改动扔掉？",
      message: `${path}\n\n工作区的改动会回到上一次提交的样子，没提交过的内容找不回来。`,
      confirmText: "扔掉改动",
      danger: true,
      onConfirm: () => run(`git checkout -- ${q(path)}`),
    });
  };

  const fileRow = (row: Row) => {
    const { dir, name } = splitPath(row.path);
    const label = CODE_LABEL[row.code] ?? row.code;
    return (
      <li className="git-row" key={row.key}>
        <i className={`git-tag ${CODE_CLASS[row.code] ?? "mod"}`} title={row.code}>{label}</i>
        <button
          className="git-path"
          type="button"
          title={`看这个文件的改动：${realPath(row.path)}`}
          disabled={!ready}
          onClick={() => run(row.bucket === "staged" ? `git diff --cached -- ${q(realPath(row.path))}` : `git diff -- ${q(realPath(row.path))}`)}
        >
          <b>{name}</b>
          {dir && <span>{dir}</span>}
        </button>
        <span className="git-row-acts">
          {row.bucket === "staged" ? (
            <button className="icon-btn xs" type="button" title="取消暂存" disabled={!ready} onClick={() => run(`git restore --staged -- ${q(realPath(row.path))}`)}>
              <IconX size={12} />
            </button>
          ) : (
            <button className="icon-btn xs" type="button" title="暂存这个" disabled={!ready} onClick={() => run(`git add -- ${q(realPath(row.path))}`)}>
              <IconPlus size={12} />
            </button>
          )}
          {row.bucket !== "staged" && (
            <button className="icon-btn xs danger" type="button" title={row.bucket === "untracked" ? "删掉这个文件" : "扔掉改动"} disabled={!ready} onClick={() => discard(row)}>
              <IconTrash size={12} />
            </button>
          )}
        </span>
      </li>
    );
  };

  const commits = allCommits ? git.commits : git.commits.slice(0, 6);

  return (
    <aside className="git-panel">
      <header className="git-head">
        <IconPulse size={14} />
        <div className="git-branch-box" ref={branchBox}>
          <button
            className={`git-branch ${pickBranch ? "on" : ""}`}
            type="button"
            title={`${git.detached ? "游离 HEAD" : "当前分支"}：${git.branch} · ${repoName}`}
            onClick={() => { setPickBranch((on) => !on); setBranchFilter(""); }}
          >
            <b>{git.detached ? `HEAD@${git.branch}` : git.branch}</b>
            <IconChevronDown size={11} />
          </button>
          {pickBranch && (
            <div className="git-pop">
              <input
                autoFocus
                className="git-pop-find"
                placeholder="换到哪个分支"
                value={branchFilter}
                spellCheck={false}
                onChange={(e) => setBranchFilter(e.target.value)}
              />
              <ul>
                {branches.length === 0 && <li className="git-pop-none">没有对得上的分支</li>}
                {branches.map((one) => (
                  <li key={one}>
                    <button
                      type="button"
                      className={one === git.branch && !git.detached ? "on" : ""}
                      disabled={!ready}
                      onClick={() => { setPickBranch(false); if (one !== git.branch || git.detached) run(`git checkout ${q(one)}`); }}
                    >
                      {one === git.branch && !git.detached && <IconCheck size={11} />}
                      {one}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                className="git-pop-new"
                type="button"
                disabled={!ready || !branchFilter.trim()}
                onClick={() => { const name = branchFilter.trim(); setPickBranch(false); run(`git checkout -b ${q(name)}`); }}
              >
                <IconPlus size={11} />新建 {branchFilter.trim() || "分支"}
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn sm" type="button" title="刷新" onClick={onRefresh}><IconRefresh size={13} /></button>
        <button className="icon-btn sm" type="button" title="收起面板" onClick={onClose}><IconX size={13} /></button>
      </header>

      {/* 跟远程的关系 + 三个最常按的动作。落后 / 领先的条数直接标在按钮上 */}
      <div className="git-remote">
        <button className="git-remote-act" type="button" title="git pull" disabled={!ready || !git.upstream} onClick={() => run("git pull")}>
          <IconDownload size={13} />拉取
          {git.behind > 0 && <em>{git.behind}</em>}
        </button>
        <button className="git-remote-act" type="button" title="git push" disabled={!ready || !git.upstream} onClick={() => run("git push")}>
          <IconUpload size={13} />推送
          {git.ahead > 0 && <em className="up">{git.ahead}</em>}
        </button>
        <button className="git-remote-act" type="button" title="git fetch --all --prune" disabled={!ready} onClick={() => run("git fetch --all --prune")}>
          <IconRefresh size={13} />抓取
        </button>
      </div>
      {!git.upstream && (
        <p className="git-say">
          这条分支还没有上游。
          <button type="button" disabled={!ready} onClick={() => run(`git push -u origin ${q(git.branch)}`)}>推上去并跟踪</button>
        </p>
      )}

      {/* 提交框。一个都没暂存时会先 add -A，省得 git 报「nothing added」白跑一趟 */}
      <div className="git-commit">
        <textarea
          className="git-msg"
          rows={2}
          placeholder="提交说明…… Ctrl+Enter 提交"
          value={msg}
          spellCheck={false}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); if (canCommit) commit(); }
          }}
        />
        <div className="git-commit-foot">
          <small>{staged > 0 ? `已暂存 ${staged} 处` : rows.length > 0 ? "提交时会先 add -A" : "工作区干净"}</small>
          <button className="btn-ghost sm" type="button" disabled={!ready || groups.dirty.length + groups.untracked.length === 0} onClick={() => run("git add -A")}>
            暂存全部
          </button>
          <button className="btn-primary sm" type="button" disabled={!canCommit} onClick={commit}>
            <IconCheck size={12} />提交
          </button>
        </div>
      </div>

      {groups.conflict.length > 0 && (
        <Section title="冲突" count={groups.conflict.length} open={open.conflict} onToggle={() => flip("conflict")}>
          <ul className="git-list">{groups.conflict.map(fileRow)}</ul>
        </Section>
      )}

      {groups.staged.length > 0 && (
        <Section
          title="已暂存"
          count={groups.staged.length}
          open={open.staged}
          onToggle={() => flip("staged")}
          tools={<button className="git-mini" type="button" disabled={!ready} onClick={() => run("git restore --staged .")}>全部取消</button>}
        >
          <ul className="git-list">{groups.staged.map(fileRow)}</ul>
        </Section>
      )}

      {groups.dirty.length > 0 && (
        <Section
          title="改动"
          count={groups.dirty.length}
          open={open.dirty}
          onToggle={() => flip("dirty")}
          tools={<button className="git-mini" type="button" disabled={!ready} onClick={() => run("git add -u")}>全部暂存</button>}
        >
          <ul className="git-list">{groups.dirty.map(fileRow)}</ul>
        </Section>
      )}

      {/* 一条改动都没有时只说一句，不摆三个空分组 */}
      {rows.length === 0 && <p className="git-clean">工作区干净，跟 {git.detached ? "HEAD" : git.branch} 一致。</p>}

      {groups.untracked.length > 0 && (
        <Section
          title="没跟踪"
          count={groups.untracked.length}
          open={open.untracked}
          onToggle={() => flip("untracked")}
          tools={<button className="git-mini" type="button" disabled={!ready} onClick={() => run("git add -A")}>全部暂存</button>}
        >
          <ul className="git-list">{groups.untracked.map(fileRow)}</ul>
        </Section>
      )}

      {git.truncated && <p className="git-say">改动太多，只列了前 200 条。</p>}

      {git.stashes > 0 && (
        <div className="git-stash">
          <span>抽屉里有 {git.stashes} 份</span>
          <button className="git-mini" type="button" disabled={!ready} onClick={() => run("git stash list")}>看看</button>
          <button className="git-mini" type="button" disabled={!ready} onClick={() => run("git stash pop")}>取回最近一份</button>
        </div>
      )}

      <Section title="最近提交" count={git.commits.length} open={open.commits} onToggle={() => flip("commits")}>
        {git.commits.length === 0 ? (
          <p className="git-empty">还没有提交。</p>
        ) : (
          <>
            <ul className="git-list commits">
              {commits.map((one) => (
                <li key={one.hash}>
                  <button type="button" className="git-path" title={`git show ${one.hash}`} disabled={!ready} onClick={() => run(`git show ${one.hash}`)}>
                    <code>{one.hash}</code>
                    <b>{one.subject}</b>
                  </button>
                  <small>{one.when}</small>
                </li>
              ))}
            </ul>
            {git.commits.length > 6 && (
              <button className="git-mini wide" type="button" onClick={() => setAllCommits((on) => !on)}>
                {allCommits ? "只看最近 6 条" : `展开全部 ${git.commits.length} 条`}
              </button>
            )}
          </>
        )}
      </Section>

      <Section title="其它命令" open={open.more} onToggle={() => flip("more")}>
        <div className="git-acts">
          <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => run("git status")}>状态</button>
          <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => run("git diff")}>全部差异</button>
          <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => run("git log --oneline --graph -20")}>日志图</button>
          <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => run("git stash")}>收进抽屉</button>
          <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => run("git commit --amend")}>改上一条</button>
          <button className="btn-ghost sm" type="button" disabled={!ready} onClick={() => run("git remote -v")}>远程地址</button>
        </div>
      </Section>

      <p className="git-foot">按钮都是把命令送进左边的终端，输出在那儿看。</p>

      {ask && <Dialog {...ask} onClose={() => setAsk(null)} />}
    </aside>
  );
}
