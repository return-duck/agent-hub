#!/bin/sh
# ============================================================================
# 应急：给卡死的机器松绑（极简版，专为在阿里云控制台/云助手里粘贴执行而设计）
#
# 场景：服务器被内存耗尽拖到 SSH 都连不上，重启后可能又立刻卡死。
#       在没有 SSH 的情况下，用它先让机器活过来。
#
# 用法（任选其一）：
#   1) 阿里云控制台 → 实例 → 远程连接（VNC）→ 粘贴下面全部内容
#   2) 阿里云控制台 → 云助手 → 发送命令 → 粘贴
#
# 做的事：停掉并禁止自启本项目的两个服务；顺带停掉占用 8080 的既有应用。
# 【不删除任何文件】，随时可以用 systemctl enable --now <名字> 恢复。
# ============================================================================
systemctl disable --now agent-stack-server agent-stack-runtime

P=$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep ':8080' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 )
if [ -n "$P" ]; then
  U=$(grep -oE '[A-Za-z0-9_.@-]+\.service' /proc/"$P"/cgroup 2>/dev/null | head -1)
  if [ -n "$U" ]; then
    mkdir -p /opt/agent-stack && echo "$U" > /opt/agent-stack/stopped-for-memory.txt
    systemctl disable --now "$U"
  else
    kill "$P" 2>/dev/null
  fi
fi

echo "=== 已完成松绑 ==="
systemctl is-active agent-stack-server agent-stack-runtime 2>&1
free -m
echo "=== 现在可以在你的 Mac 上运行： bash deploy/rescue.sh ==="
