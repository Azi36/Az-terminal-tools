/**
 * 预设指令：开箱就有几十条常用的，挑着导入，不用从零敲。
 * 导入后就是普通指令，随便改随便删。
 */

export interface PresetSnippet {
  title: string;
  command: string;
  tag: string;
}

export const PRESET_SNIPPETS: PresetSnippet[] = [
  // 系统
  { tag: "系统", title: "系统信息", command: "uname -a" },
  { tag: "系统", title: "发行版版本", command: "cat /etc/os-release" },
  { tag: "系统", title: "开机多久了", command: "uptime" },
  { tag: "系统", title: "实时资源占用", command: "top -b -n 1 | head -20" },
  { tag: "系统", title: "内存", command: "free -h" },
  { tag: "系统", title: "CPU 核数", command: "nproc" },
  { tag: "系统", title: "当前登录用户", command: "who" },

  // 磁盘
  { tag: "磁盘", title: "磁盘占用", command: "df -h" },
  { tag: "磁盘", title: "当前目录谁最占地方", command: "du -sh * | sort -rh | head -20" },
  { tag: "磁盘", title: "找大文件（>100M）", command: "find . -type f -size +100M -exec ls -lh {} \\;" },
  { tag: "磁盘", title: "inode 用量", command: "df -i" },

  // 进程
  { tag: "进程", title: "吃内存排行", command: "ps aux --sort=-%mem | head -15" },
  { tag: "进程", title: "吃 CPU 排行", command: "ps aux --sort=-%cpu | head -15" },
  { tag: "进程", title: "按名字找进程", command: "ps -ef | grep " },

  // 网络
  { tag: "网络", title: "监听端口", command: "ss -tulnp" },
  { tag: "网络", title: "某端口被谁占了", command: "ss -tulnp | grep :80" },
  { tag: "网络", title: "本机 IP", command: "ip addr show" },
  { tag: "网络", title: "出口公网 IP", command: "curl -s ifconfig.me" },
  { tag: "网络", title: "连通性", command: "ping -c 4 1.1.1.1" },

  // 服务
  { tag: "服务", title: "服务状态", command: "systemctl status " },
  { tag: "服务", title: "重启服务", command: "systemctl restart " },
  { tag: "服务", title: "开机自启列表", command: "systemctl list-unit-files --state=enabled" },
  { tag: "服务", title: "失败的服务", command: "systemctl --failed" },

  // 日志
  { tag: "日志", title: "跟一个日志文件", command: "tail -f /var/log/syslog" },
  { tag: "日志", title: "系统日志（最近）", command: "journalctl -n 100 --no-pager" },
  { tag: "日志", title: "某服务日志", command: "journalctl -u nginx -n 100 --no-pager" },
  { tag: "日志", title: "内核报错", command: "dmesg -T | tail -50" },

  // Docker
  { tag: "Docker", title: "容器列表", command: "docker ps -a" },
  { tag: "Docker", title: "镜像列表", command: "docker images" },
  { tag: "Docker", title: "容器日志", command: "docker logs -f --tail 100 " },
  { tag: "Docker", title: "进容器", command: "docker exec -it CONTAINER bash" },
  { tag: "Docker", title: "占用空间", command: "docker system df" },
  { tag: "Docker", title: "清理没用的", command: "docker system prune -f" },
  { tag: "Docker", title: "compose 起服务", command: "docker compose up -d" },

  // Nginx
  { tag: "Nginx", title: "配置语法检查", command: "nginx -t" },
  { tag: "Nginx", title: "平滑重载", command: "nginx -s reload" },
  { tag: "Nginx", title: "访问日志实时", command: "tail -f /var/log/nginx/access.log" },

  // Git
  { tag: "Git", title: "状态", command: "git status" },
  { tag: "Git", title: "最近提交", command: "git log --oneline -20" },
  { tag: "Git", title: "拉取", command: "git pull --rebase" },

  // 文件
  { tag: "文件", title: "详细列表", command: "ls -lah" },
  { tag: "文件", title: "按内容搜文件", command: "grep -rn \"关键词\" ." },
  { tag: "文件", title: "按名字找文件", command: "find . -name \"*.log\"" },
  { tag: "文件", title: "打包目录", command: "tar -czvf out.tar.gz ./目录" },
  { tag: "文件", title: "解包", command: "tar -xzvf 包.tar.gz" },
];
