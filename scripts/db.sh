#!/usr/bin/env bash
# 项目级 MySQL 8.4.7 实例管理（datadir 在项目内，端口 3307，与系统 MySQL 完全隔离）
# 用法： scripts/db.sh {init|start|stop|restart|status|cli|reset|logs}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"

MYSQL_HOME="$ROOT/.toolchain/mysql"
DATADIR="$ROOT/.toolchain/mysql-data"
RUNDIR="$ROOT/.toolchain/mysql-run"
SOCKET="$RUNDIR/mysql.sock"
PIDFILE="$RUNDIR/mysqld.pid"
ERRLOG="$RUNDIR/error.log"
INITLOG="$RUNDIR/init.log"

PORT="${AGENT_STACK_DB_PORT}"
DB="${AGENT_STACK_DB_NAME}"
TESTDB="${AGENT_STACK_DB_TEST_NAME}"
USER="${AGENT_STACK_DB_USER}"
PASS="${AGENT_STACK_DB_PASSWORD}"

log()  { printf '\033[1;34m[db]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[db]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[db] %s\033[0m\n' "$*" >&2; exit 1; }

[ -x "$MYSQL_HOME/bin/mysqld" ] || die "未找到 MySQL，请先执行 scripts/toolchain.sh"

running() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  return 0
}

mysql_root() { "$MYSQL_HOME/bin/mysql" --socket="$SOCKET" -u root "$@"; }

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if "$MYSQL_HOME/bin/mysqladmin" --socket="$SOCKET" -u root ping >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

do_init() {
  if [ -d "$DATADIR/mysql" ]; then log "datadir 已初始化，跳过"; return 0; fi
  log "初始化 datadir（首次约需 10-20 秒）..."
  mkdir -p "$DATADIR" "$RUNDIR"
  "$MYSQL_HOME/bin/mysqld" --initialize-insecure \
    --basedir="$MYSQL_HOME" --datadir="$DATADIR" \
    --log-error="$INITLOG" \
    || { tail -30 "$INITLOG" 2>/dev/null; die "初始化失败，完整日志：$INITLOG"; }
  log "初始化完成"
}

do_start() {
  if running; then log "已在运行 (pid $(cat "$PIDFILE"), port $PORT)"; return 0; fi
  do_init
  mkdir -p "$RUNDIR"
  log "启动 mysqld (port $PORT) ..."
  nohup "$MYSQL_HOME/bin/mysqld" \
    --basedir="$MYSQL_HOME" \
    --datadir="$DATADIR" \
    --port="$PORT" \
    --socket="$SOCKET" \
    --pid-file="$PIDFILE" \
    --log-error="$ERRLOG" \
    --bind-address=127.0.0.1 \
    --mysqlx=0 \
    --skip-name-resolve \
    >/dev/null 2>&1 &
  disown || true

  if ! wait_ready; then
    tail -30 "$ERRLOG" 2>/dev/null || true
    die "启动超时，完整日志：$ERRLOG"
  fi
  log "已就绪"

  log "确保账号与库存在 ..."
  mysql_root <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB\`     CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS \`$TESTDB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$USER'@'127.0.0.1' IDENTIFIED BY '$PASS';
CREATE USER IF NOT EXISTS '$USER'@'localhost' IDENTIFIED BY '$PASS';
GRANT ALL PRIVILEGES ON \`$DB\`.*     TO '$USER'@'127.0.0.1', '$USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$TESTDB\`.* TO '$USER'@'127.0.0.1', '$USER'@'localhost';
FLUSH PRIVILEGES;
SQL
  log "库 $DB / $TESTDB 与用户 $USER 就绪"
}

do_stop() {
  if ! running; then warn "未在运行"; return 0; fi
  local pid; pid="$(cat "$PIDFILE")"
  log "停止 mysqld (pid $pid) ..."
  "$MYSQL_HOME/bin/mysqladmin" --socket="$SOCKET" -u root shutdown >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 30); do running || break; sleep 1; done
  running && { warn "优雅关闭超时，强制结束"; kill -9 "$pid" 2>/dev/null || true; }
  rm -f "$PIDFILE"
  log "已停止"
}

do_status() {
  if running; then
    log "运行中 pid=$(cat "$PIDFILE") port=$PORT"
    mysql_root -e "SELECT VERSION() AS version;" 2>/dev/null || true
    mysql_root -e "SHOW DATABASES;" 2>/dev/null | sed 's/^/  /' || true
  else
    warn "未运行"
    return 1
  fi
}

do_reset() {
  do_stop || true
  log "删除 datadir ..."
  rm -rf "$DATADIR" "$RUNDIR"
  do_start
}

case "${1:-}" in
  init)    do_init ;;
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  logs)    tail -n 50 "$ERRLOG" 2>/dev/null || warn "无日志" ;;
  cli)     shift; mysql_root "$@" ;;
  app-cli) shift; "$MYSQL_HOME/bin/mysql" -h 127.0.0.1 -P "$PORT" -u "$USER" -p"$PASS" "$@" ;;
  reset)   do_reset ;;
  *)       echo "用法: scripts/db.sh {init|start|stop|restart|status|cli|app-cli|logs|reset}"; exit 2 ;;
esac
