#!/usr/bin/env bash
# 停止 Node runtime（runtime 组件）
set -euo pipefail

# APP_DIR 从脚本自身位置推导（脚本在 $APP_DIR/<component>/ 下），
# 这样无论装到 /opt 还是 /home/admin 都不用改脚本
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=agent-stack-runtime

if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  echo "[stop] systemctl stop $SERVICE"
  systemctl stop "$SERVICE"
  exit 0
fi

PIDFILE="$APP_DIR/runtime/logs/agent.pid"
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE")"
  echo "[stop] kill $pid"
  kill "$pid" 2>/dev/null || true
  sleep 2
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
else
  echo "[stop] 没有 pid 文件，无事可做"
fi
