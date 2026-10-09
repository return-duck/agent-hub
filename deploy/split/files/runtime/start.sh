#!/usr/bin/env bash
# 启动 Node runtime（runtime 组件）
#
# 装了 systemd 单元就交给 systemd；没有则退回 nohup（与 resume-agent 的 start.sh 一致）
set -euo pipefail

# APP_DIR 从脚本自身位置推导（脚本在 $APP_DIR/<component>/ 下），
# 这样无论装到 /opt 还是 /home/admin 都不用改脚本
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=agent-stack-runtime

mkdir -p "$APP_DIR/runtime/logs"

if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  echo "[start] 由 systemd 托管，执行 systemctl restart $SERVICE"
  systemctl restart "$SERVICE"
  sleep 3
  systemctl --no-pager --lines=10 status "$SERVICE" || true
  exit 0
fi

# --- 回退：nohup ---
cd "$APP_DIR/runtime"
[ -f dist/main.js ] || { echo "缺少 dist/main.js（先构建并上传 runtime 包）"; exit 1; }
[ -d node_modules ] || { echo "缺少 node_modules，请先执行: npm install"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "未找到 node（需要 Node 20+）"; exit 1; }

set -a; [ -f "$APP_DIR/shared/runtime.env" ] && . "$APP_DIR/shared/runtime.env"; set +a
PORT="${RUNTIME_PORT:-18090}"

if command -v lsof >/dev/null 2>&1; then
  pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "${pid:-}" ] && { echo "[start] 停止占用 $PORT 的进程: $pid"; kill "$pid" 2>/dev/null || true; sleep 1; }
fi

echo "[start] 启动 runtime on ${RUNTIME_HOST:-127.0.0.1}:$PORT ..."
nohup node dist/main.js >> logs/agent.log 2>&1 &
echo $! > logs/agent.pid

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "[start] OK http://127.0.0.1:$PORT/healthz  (PID $(cat logs/agent.pid))"
    exit 0
  fi
  sleep 1
done
echo "[start] 启动超时，日志尾部："
tail -n 40 logs/agent.log || true
exit 1
