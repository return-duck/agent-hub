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

# 后台启动一个长期服务，并让它彻底脱离调用方的 fd 与作业控制。
#
# 为什么写这么绕：如果子进程以任何方式继承了调用方的 stdout（哪怕只是"重定向生效前的瞬间"），
# 那么 `scripts/dev.sh | tee log` 这类调用就永远等不到 EOF —— 看起来像脚本卡死，
# 实际脚本早就退出了。CI 里这种"看起来卡住"最难排查，所以这里一次性做干净：
#   - 子 shell 自身的 0/1/2 全部指向 /dev/null（断开与调用方管道的最后一根线）
#   - 服务的输出单独追加到日志文件
#   - disown 让它不出现在作业表里
start_detached() { # start_detached <workdir> <logfile> <cmd...>
  local dir="$1" log="$2"
  shift 2
  ( cd "$dir" && exec nohup "$@" >>"$log" 2>&1 ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
}
