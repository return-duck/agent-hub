#!/usr/bin/env bash
# 启动 Java 后端（server 组件）
#
# 装了 systemd 单元就交给 systemd（开机自启 + 崩溃限频重启）；
# 没有单元时退回 nohup 方式（与 resume-server 的启动方式一致）。
set -euo pipefail

# APP_DIR 从脚本自身位置推导（脚本在 $APP_DIR/<component>/ 下），
# 这样无论装到 /opt 还是 /home/admin 都不用改脚本
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=agent-stack-server
PORT_FILE="$APP_DIR/shared/server.env"

mkdir -p "$APP_DIR/server/logs"

if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  echo "[start] 由 systemd 托管，执行 systemctl restart $SERVICE"
  systemctl restart "$SERVICE"
  sleep 3
  systemctl --no-pager --lines=10 status "$SERVICE" || true
  exit 0
fi

# --- 回退：nohup（与 /home/admin 下 resume-server 的启动方式一致） ---
[ -f "$APP_DIR/server/agent-stack-server.jar" ] || { echo "缺少 jar"; exit 1; }
[ -x "$APP_DIR/jre/bin/java" ] || { echo "缺少 JRE: $APP_DIR/jre/bin/java"; exit 1; }

# 若端口已被占用，先停掉占用者
PORT=$(sed -n 's/^AGENT_STACK_SERVER_PORT=//p' "$PORT_FILE" | head -1)
PORT=${PORT:-18080}
if command -v lsof >/dev/null 2>&1; then
  pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "${pid:-}" ] && { echo "[start] 停止占用 $PORT 的进程: $pid"; kill "$pid" 2>/dev/null || true; sleep 1; }
fi

echo "[start] 启动 server on 127.0.0.1:$PORT ..."
set -a; . "$PORT_FILE"; set +a
nohup "$APP_DIR/jre/bin/java" \
  -Xms256m -Xmx256m -XX:MaxMetaspaceSize=128m -XX:+UseSerialGC \
  -jar "$APP_DIR/server/agent-stack-server.jar" --server.address=127.0.0.1 \
  >> "$APP_DIR/server/logs/server.log" 2>&1 &
echo $! > "$APP_DIR/server/logs/server.pid"

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/actuator/health" >/dev/null 2>&1; then
    echo "[start] OK http://127.0.0.1:$PORT/actuator/health  (PID $(cat "$APP_DIR/server/logs/server.pid"))"
    exit 0
  fi
  sleep 1
done
echo "[start] 启动超时，日志尾部："
tail -n 40 "$APP_DIR/server/logs/server.log" || true
exit 1
