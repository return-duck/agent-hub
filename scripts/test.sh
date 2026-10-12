#!/usr/bin/env bash
# 一次跑完三层测试：契约漂移检查 + runtime(Node) + server(Java, 需 MySQL) + web(前端 reducer)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

TAG='[test]'

# ------------------------------------------------------------------ 契约漂移检查
info "检查契约产物是否与 contracts/ 一致 ..."
# 做法：先给现有产物拍快照 → 重新生成 → 逐字节比对。
# 这样在"还没有任何 commit"的仓库里也能正确判断漂移（git diff 对未跟踪文件是瞎的）。
SNAPSHOT="$(mktemp -d)"
trap 'rm -rf "$SNAPSHOT"' EXIT
cp -R "$ROOT/node/src/generated" "$SNAPSHOT/runtime-generated"
cp -R "$ROOT/frontend/src/generated" "$SNAPSHOT/web-generated"

node "$ROOT/scripts/codegen.mjs" >/dev/null

DRIFT=0
diff -r "$SNAPSHOT/runtime-generated" "$ROOT/node/src/generated" >/dev/null || DRIFT=1
diff -r "$SNAPSHOT/web-generated" "$ROOT/frontend/src/generated" >/dev/null || DRIFT=1
if [ "$DRIFT" -ne 0 ]; then
  fail "生成的契约类型与 contracts/ 不一致（产物已被刷新，请一并提交）"
  diff -r "$SNAPSHOT/runtime-generated" "$ROOT/node/src/generated" || true
  diff -r "$SNAPSHOT/web-generated" "$ROOT/frontend/src/generated" || true
  exit 1
fi
ok "契约产物无漂移"

# ------------------------------------------------------------------ MySQL
info "确保 MySQL 在线（server 的集成测试需要真实数据库）..."
bash "$ROOT/scripts/db.sh" start

# ------------------------------------------------------------------ 三层测试
info "runtime 测试 ..."
(cd "$ROOT/node" && npm test --silent)

info "web 测试 ..."
(cd "$ROOT/frontend" && npm test --silent)

info "server 测试 ..."
(cd "$ROOT/java" && "$ROOT/scripts/mvn.sh" -B -q test)

ok "三层测试全部通过"
