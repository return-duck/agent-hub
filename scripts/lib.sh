#!/usr/bin/env bash
# 公共函数：端口探测与等待
# 用法： source scripts/lib.sh

ROOT="${AGENT_STACK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_DIR="$ROOT/.toolchain/logs"
mkdir -p "$LOG_DIR"

port_open() { nc -z 127.0.0.1 "${1:?port required}" >/dev/null 2>&1; }

wait_port() { # wait_port <port> <seconds> <name>
  local port="$1" limit="${2:-60}" name="${3:-service}" i
  for ((i = 1; i <= limit; i++)); do
    if port_open "$port"; then return 0; fi
    sleep 1
  done
  printf '\033[1;31m[wait]\033[0m %s 在 %ss 内没有在端口 %s 就绪\n' "$name" "$limit" "$port" >&2
  return 1
}

info() { printf '\033[1;34m%s\033[0m %s\n' "${TAG:-[agent-stack]}" "$*"; }
ok()   { printf '\033[1;32m%s\033[0m %s\n' "${TAG:-[agent-stack]}" "$*"; }
warn() { printf '\033[1;33m%s\033[0m %s\n' "${TAG:-[agent-stack]}" "$*"; }
fail() { printf '\033[1;31m%s\033[0m %s\n' "${TAG:-[agent-stack]}" "$*" >&2; }
