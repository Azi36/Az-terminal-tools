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
- **多标签** —— 同一台服务器可以开多个，终端 / 文件 / 隧道 / 配置在标签内切；切走的终端还活着。Ctrl+Tab 切换、Ctrl+W 关闭、Ctrl+1..9 跳转
- **搬得走** —— 配置一键导出成 JSON，也能直接从 `~/.ssh/config` 导入

## 不做什么

不要账号、不传云、不过期、不锁功能。凭据交给系统钥匙串（Windows 凭据管理器 / macOS 钥匙串），配置文件里没有明文；主机指纹用标准 `~/.ssh/known_hosts`，跟系统 ssh 共用一份。导出的备份里也**不含密码** —— 明文导出会把「不落明文」这件事作废。

检查更新是你点了才查，不后台连网。

## 自己跑

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 出安装包
```

需要 [Rust](https://rustup.rs) 和 Tauri v2 的系统依赖（Windows 装 VS Build Tools；macOS 装 Xcode Command Line Tools）。

## 发版

打个 `v*` 标签，CI 出 Windows / macOS 安装包并发 Release 草稿。

自动更新要签名，仓库里得配两个 secret：

- `TAURI_SIGNING_PRIVATE_KEY` —— `npm run tauri signer generate` 生成的私钥文件**内容**
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` —— 私钥密码，没设就留空

公钥已经在 `src-tauri/tauri.conf.json` 里。**私钥别进仓库**，丢了就没法给老用户推更新。

代码签名（可选，配了才签，没配就出没签名的包）：macOS 用 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`。

## 许可

MIT
