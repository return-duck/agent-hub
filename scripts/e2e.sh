#!/usr/bin/env bash
# 端到端验收：把三个服务拉起来，跑完整业务流程并逐条断言。
#
#   scripts/e2e.sh              全栈验收（会自动起服务，结束后按需保留）
#   scripts/e2e.sh --no-start   假定服务已在跑，只跑断言
#
# 这是"业务流程跑通"的可执行证据，也是 CI 的验收步骤。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

TAG='[e2e]'

NO_START=0
[ "${1:-}" = "--no-start" ] && NO_START=1

if [ "$NO_START" -eq 0 ]; then
  info "确保 MySQL 在线 ..."
  bash "$ROOT/scripts/db.sh" start

  if ! port_open 8090; then
    info "启动 runtime :8090 ..."
    start_detached "$ROOT/runtime" "$LOG_DIR/runtime.log" npx tsx src/server.ts
    wait_port 8090 60 runtime || { tail -20 "$LOG_DIR/runtime.log"; exit 1; }
  fi

  if ! port_open 8080; then
    info "启动 server :8080 ..."
    start_detached "$ROOT/server" "$LOG_DIR/server.log" "$ROOT/scripts/mvn.sh" -q -DskipTests spring-boot:run
    wait_port 8080 180 server || { tail -30 "$LOG_DIR/server.log"; exit 1; }
  fi
fi

export E2E_SERVER="http://127.0.0.1:8080"
export E2E_DB_SH="$ROOT/scripts/db.sh"
export AGENT_STACK_DB_NAME="${AGENT_STACK_DB_NAME:-agent_stack}"

set +e
python3 "$ROOT/scripts/e2e.py"
CODE=$?
set -e

if [ $CODE -eq 0 ]; then
  ok "端到端验收通过"
else
  fail "端到端验收失败（退出码 $CODE）"
fi
exit $CODE
