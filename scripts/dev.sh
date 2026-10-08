#!/usr/bin/env bash
# 一条命令起全栈：MySQL(3307) + runtime(8090) + server(8080) + web(5173)
#
# 三个服务彼此独立、各自可单独部署；这里只是本机开发时的编排。
# 服务以后台方式启动，日志写到 .toolchain/logs/*.log，用 scripts/stop.sh 停止。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

TAG='[dev]'

info "1/4 启动项目级 MySQL ..."
bash "$ROOT/scripts/db.sh" start

info "2/4 启动 runtime (Node + LangChain) :8090 ..."
if port_open 8090; then
  warn "8090 已在监听，跳过"
else
  start_detached "$ROOT/runtime" "$LOG_DIR/runtime.log" npx tsx src/main.ts
  wait_port 8090 60 runtime || { tail -20 "$LOG_DIR/runtime.log"; exit 1; }
fi

info "3/4 启动 server (Spring Boot) :8080 ..."
if port_open 8080; then
  warn "8080 已在监听，跳过"
else
  start_detached "$ROOT/server" "$LOG_DIR/server.log" "$ROOT/scripts/mvn.sh" -q -DskipTests spring-boot:run
  wait_port 8080 180 server || { tail -30 "$LOG_DIR/server.log"; exit 1; }
fi

info "4/4 启动 web (Vite) :5173 ..."
if port_open 5173; then
  warn "5173 已在监听，跳过"
else
  start_detached "$ROOT/web" "$LOG_DIR/web.log" npm run dev
  wait_port 5173 90 web || { tail -20 "$LOG_DIR/web.log"; exit 1; }
fi

echo
ok "全栈已就绪："
printf '  前端    http://127.0.0.1:5173\n'
printf '  控制面  http://127.0.0.1:8080/actuator/health\n'
printf '  运行时  http://127.0.0.1:8090/healthz\n'
printf '  数据库  127.0.0.1:3307 (agent_stack / agentstack)\n\n'
printf '  日志    %s/*.log\n' "$LOG_DIR"
printf '  停止    scripts/stop.sh\n'
