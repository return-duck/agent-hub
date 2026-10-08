#!/usr/bin/env bash
# 停止由 scripts/dev.sh 启动的三个服务（MySQL 默认保留，加 --all 一并停止）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

TAG='[stop]'

kill_by_port() { # kill_by_port <port> <name>
  local port="$1" name="$2" pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    warn "$name (:$port) 未在运行"
    return 0
  fi
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  ok "$name (:$port) 已停止"
}

kill_by_port 5173 web
kill_by_port 8080 server
kill_by_port 8090 runtime

if [ "${1:-}" = "--all" ]; then
  bash "$ROOT/scripts/db.sh" stop
else
  warn "MySQL 仍在运行（要一起停： scripts/stop.sh --all）"
fi
