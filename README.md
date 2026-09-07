# Az-term

SSH · SFTP · 指令库 · 备忘录。**免费、无账号、不过期。**

Azi36 家族第 002 号产品 · 桌面版（Windows / macOS）· [term.azi36.com](https://term.azi36.com)

## 有什么

- **SSH 终端** —— xterm.js + Rust（russh）引擎，PTY、颜色、回滚查找、复制粘贴、配色六套、字号四档、命令分割线；支持密码 / 密钥 / **键盘交互（2FA、OTP）** 三种认证
- **字符编码** —— UTF-8 / GBK / Big5 / Shift_JIS 等，连着也能当场换，老服务器不再一屏乱码
- **端口转发** —— 本地转发（-L）、动态 SOCKS5 代理（-D）、远程转发（-R），复用同一条已认证的连接
- **跳板机** —— 相当于 ssh 的 ProxyJump，先过堡垒机再连目标机
- **SFTP 文件面板** —— 本地 / 远程双栏对照，多选、框选、方向键导航、目录整体传输、**并发传输**、速度与剩余时间、**断点续传**、**覆盖确认**、**目录同步**、同栏内复制 / 移动、收藏目录、拖拽上传、改权限
- **内置编辑器** —— 远程配置文件直接改，Ctrl+S 存回原路径，不落临时文件；编码切换、**改动冲突检测**、保留原换行风格、查找替换、跳行、行号
- **会话日志** —— 把一条会话的输出记到文件，事后能翻能 grep
- **掉线自动重连** —— 退避重试，手上有凭据才自动接
- **指令库** —— 45 条常用指令预设，一键插入或执行
- **备忘录** —— 随手记，纯本地
- **数据库控制台** —— MySQL / PostgreSQL / Redis，库表树、SQL 编辑器和结果表，Redis 的 key 浏览和命令行；密码同样在系统钥匙串
- **本地终端 + git 面板** —— 本机也能开 shell 标签（Ctrl+Shift+L，可多开），cd 进仓库时旁边自动出现 git 面板：分支、领先落后、改动、最近提交，一排常用操作按钮和切分支下拉，点的都是把命令送进终端
- **多标签** —— 同一台服务器可以开多个，终端 / 文件 / 隧道 / 配置在标签内切；切走的终端还活着。Ctrl+Tab 切换、Alt+1..9 跳转、Ctrl+Shift+W 关闭、Ctrl+Shift+T 新建；应用级快捷键一律带 Shift 或 Alt，不跟 shell 抢 Ctrl 组合，终端里右键就能看到全部
- **搬得走** —— 配置一键导出成 JSON，也能直接从 `~/.ssh/config` 导入

## 不做什么

不要账号、不传云、不过期、不锁功能。凭据交给系统钥匙串（Windows 凭据管理器 / macOS 钥匙串），配置文件里没有明文；主机指纹用标准 `~/.ssh/known_hosts`，跟系统 ssh 共用一份。导出的备份里也**不含密码** —— 明文导出会把「不落明文」这件事作废。

**唯一一次主动联网**：开起来 4 秒后，向 `api.azi36.com` 发一个 GET 问「有没有新版」。
不带任何身份标识、不上报任何东西，拿不到就当没有。设置里「新版提示」可以关掉，
关了之后只有你点「检查更新」才会查。

更新包本身从 GitHub Release 下载，带 minisign 签名校验。检查和下载分开走，是因为
api.github.com 在国内经常拉不动 —— 拉不动的后果不是提示晚了，是你根本不知道有新版。

除此之外不联网：你的电脑直连你的服务器，中间没有我们的服务器。

## 自己跑

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 出安装包
```

需要 [Rust](https://rustup.rs) 和 Tauri v2 的系统依赖（Windows 装 VS Build Tools；macOS 装 Xcode Command Line Tools）。

## 发版

改了什么记在 [CHANGELOG.md](CHANGELOG.md)；发版时把对应小节抄进 Release 说明，
应用里「设置 → 关于」显示的就是那段。

打个 `v*` 标签，CI 出 Windows / macOS 安装包并发 Release 草稿。

自动更新要签名，仓库里得配两个 secret，**两个都必须有值**：

- `TAURI_SIGNING_PRIVATE_KEY` —— `npm run tauri signer generate` 生成的私钥文件**内容**
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` —— 生成私钥时设的密码

公钥已经在 `src-tauri/tauri.conf.json` 里，是公开的。**私钥和密码都别进仓库**——
两样凑齐就能以你的名义给所有用户推更新。丢了也麻烦：老用户只认这一个公钥，
换新密钥对他们来说等于"签名不对"，只能手动下新包。

自己从头搭一套的话：

```bash
npm run tauri signer generate -w ~/.tauri/你的名字.key --password '一串长密码'
```

把打印出来的公钥填进 `tauri.conf.json` 的 `plugins.updater.pubkey`，
私钥内容和密码分别放进上面两个 secret。

代码签名（可选，配了才签，没配就出没签名的包）：macOS 用 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`。

## 许可

MIT
