#!/usr/bin/env bash
# 直接部署到服务器（不使用 Docker）。
#
#   bash scripts/deploy.sh {all|frontend|java|node|verify|ssh}
#
# 设计取舍：
#  - 只做「构建产物替换」，不做首次装机。服务器侧的 systemd 单元、nginx 配置、
#    /opt/agent-stack/shared/*.env 都已就位，本脚本刻意不碰它们 —— 代码部署与
#    环境装机是两件事，混在一起会让「只发一次前端」变成一次全量变更。
#  - 组件名用本地目录名（frontend / java / node），落到服务器上对应
#    /opt/agent-stack/{web,server,runtime}。
#  - 上传走 `ssh 'cat > 文件'` 而不是 scp：免去 scp 与密码交互的组合问题，
#    并且顺带校验字节数。
#  - 所有替换都是「先上传到 incoming，再原子替换」，失败时线上仍是旧版本。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"

APP_DIR="${APP_DIR:-/opt/agent-stack}"
JAVA_HEALTH="http://127.0.0.1:18080/actuator/health"
NODE_HEALTH="http://127.0.0.1:8090/healthz"
PUBLIC_PORT="${PUBLIC_PORT:-8080}"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 读 env.yml
# env.yml 是本地凭据文件（已在 .gitignore 中，不入库）。刻意不引 yq：
# 这里只需要两个标量，用 sed 提取比多一个依赖更省事。
ENV_YML="$ROOT/env.yml"
[ -f "$ENV_YML" ] || die "缺少 $ENV_YML（里面应有 ip 与 password）"
DEPLOY_HOST="$(sed -nE 's/^[[:space:]]*ip:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' "$ENV_YML" | head -1)"
DEPLOY_PASSWORD="$(sed -nE 's/^[[:space:]]*password:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' "$ENV_YML" | head -1)"
[ -n "$DEPLOY_HOST" ] || die "env.yml 里没读到 ip"
[ -n "$DEPLOY_PASSWORD" ] || die "env.yml 里没读到 password"
SSH_PORT="${SSH_PORT:-22}"
SSH_USER="${SSH_USER:-root}"

WORK="$(mktemp -d -t agent-stack-deploy.XXXXXX)"
ASKPASS="$WORK/askpass.sh"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# 用 SSH_ASKPASS 传密码：不把密码放进命令行（那会出现在 ps 里），也不写进 ssh 配置。
printf '#!/bin/sh\nprintf "%%s\\n" %s\n' "'${DEPLOY_PASSWORD//\'/\'\\\'\'}'" > "$ASKPASS"
chmod 700 "$ASKPASS"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=25 -o NumberOfPasswordPrompts=1
          -o PreferredAuthentications=password -o PubkeyAuthentication=no
          -o IPQoS=none -o LogLevel=ERROR -p "$SSH_PORT")

sshrun() {
  env -u SSH_AUTH_SOCK DISPLAY=:0 SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force \
    ssh "${SSH_OPTS[@]}" "$SSH_USER@$DEPLOY_HOST" "$@"
}

# ---------------------------------------------------------------- 基础动作
upload() {  # upload <本地文件> <服务器绝对路径>：走 stdin，并校验字节数
  local src="$1" dst="$2"
  local size; size="$(wc -c < "$src" | tr -d ' ')"
  [ "$size" -gt 0 ] || die "本地文件为空: $src"
  sshrun "mkdir -p '$(dirname "$dst")'"
  # 这里必须是「重定向到 sshrun」这一个动作；拆成两步的话 ssh 会因为等 stdin 而挂住
  sshrun "cat > '$dst'" < "$src"
  local remote; remote="$(sshrun "wc -c < '$dst'" | tr -d ' ')"
  [ "$remote" = "$size" ] || die "上传校验失败：本地 $size 字节，服务器 $remote 字节（$dst）"
}

wait_http() {  # wait_http <url> <期望片段> <systemd单元名> <超时秒>
  local url="$1" expect="$2" name="$3" timeout="$4"
  for _ in $(seq 1 "$timeout"); do
    if sshrun "curl -sf --max-time 3 '$url'" 2>/dev/null | grep -q "$expect"; then
      return 0
    fi
    sleep 1
  done
  warn "$name 在 ${timeout}s 内未就绪，日志尾部："
  sshrun "journalctl -u '$name' -n 25 --no-pager 2>/dev/null" || true
  die "$name 未就绪"
}

# ---------------------------------------------------------------- 构建
build_frontend() {
  log "构建前端（frontend/ → dist/）"
  ( cd "$ROOT/frontend" && npm run build >/dev/null )
  [ -f "$ROOT/frontend/dist/index.html" ] || die "前端构建产物缺 index.html"
}

build_java() {
  log "构建 java 后端（java/ → target/*.jar）"
  ( cd "$ROOT/java" && "$ROOT/scripts/mvn.sh" -B -q -DskipTests package )
  ls "$ROOT/java/target/agent-stack-server-"*.jar >/dev/null 2>&1 \
    || die "没找到 jar（期望 java/target/agent-stack-server-*.jar）"
}

build_node() {
  log "构建 node 服务（node/ → dist/）"
  ( cd "$ROOT/node" && npm run build >/dev/null )
  [ -f "$ROOT/node/dist/main.js" ] || die "node 构建产物缺 dist/main.js"
}

# ---------------------------------------------------------------- 各组件部署
deploy_frontend() {
  build_frontend
  local tgz="$WORK/frontend.tgz"
  ( cd "$ROOT/frontend/dist" && tar -czf "$tgz" . )
  log "上传前端静态资源"
  upload "$tgz" "$APP_DIR/incoming/frontend.tgz"

  log "替换 $APP_DIR/web（保留 studio -> web 软链）"
  # 关键：替换后要 chmod a+rX。之前踩过 umask 泄漏进包、文件 600 导致 nginx 403 的坑。
  # 换的是 web 目录本身；studio -> web 是相对软链，仍指向新目录。
  sshrun "set -e
    rm -rf '$APP_DIR/web.new' '$APP_DIR/web.old'
    mkdir -p '$APP_DIR/web.new'
    tar -xzf '$APP_DIR/incoming/frontend.tgz' -C '$APP_DIR/web.new'
    chmod -R a+rX '$APP_DIR/web.new'
    chown -R agentstack:agentstack '$APP_DIR/web.new'
    mv '$APP_DIR/web' '$APP_DIR/web.old'
    mv '$APP_DIR/web.new' '$APP_DIR/web'
    rm -rf '$APP_DIR/web.old'
    echo -n '  已替换，新资源: '; ls '$APP_DIR/web/assets' | head -3 | tr '\n' ' '; echo"
  sshrun "systemctl reload nginx" || warn "nginx reload 失败（纯静态资源通常不影响）"
  ok "前端已更新"
}

deploy_java() {
  build_java
  local jar; jar="$(ls "$ROOT/java/target/agent-stack-server-"*.jar | head -1)"
  log "上传后端 jar（$(basename "$jar") → agent-stack-server.jar）"
  upload "$jar" "$APP_DIR/incoming/agent-stack-server.jar"

  log "替换 jar 并重启 agent-stack-server"
  # reset-failed 不能省：单元进过 failed 后会被 StartLimit 拒绝启动（之前踩过，静默不启）
  sshrun "set -e
    install -m 644 '$APP_DIR/incoming/agent-stack-server.jar' '$APP_DIR/server/agent-stack-server.jar'
    chown agentstack:agentstack '$APP_DIR/server/agent-stack-server.jar'
    systemctl reset-failed agent-stack-server 2>/dev/null || true
    systemctl restart agent-stack-server
    echo '  已重启，等待就绪…'"
  wait_http "$JAVA_HEALTH" '"status":"UP"' agent-stack-server 180
  ok "后端已更新并就绪"
}

deploy_node() {
  build_node
  local tgz="$WORK/node.tgz"
  ( cd "$ROOT/node" && tar -czf "$tgz" dist package.json package-lock.json )
  log "上传 node 服务"
  upload "$tgz" "$APP_DIR/incoming/node.tgz"

  # 依赖只有 package.json 变了才重装：npm ci 要联网且慢，绝大多数发版不需要
  local local_deps remote_deps reinstall=0
  local_deps="$(shasum -a 256 "$ROOT/node/package.json" | cut -d' ' -f1)"
  remote_deps="$(sshrun "sha256sum '$APP_DIR/runtime/package.json' 2>/dev/null | cut -d' ' -f1" | tr -d ' ' || true)"
  [ "$local_deps" = "$remote_deps" ] || reinstall=1

  log "替换 dist 并重启 agent-stack-runtime（依赖$([ "$reinstall" = 1 ] && echo '有变化，将重装' || echo '无变化，跳过 npm ci')）"
  sshrun "set -e
    cd '$APP_DIR/runtime'
    rm -rf /tmp/as-extract && mkdir -p /tmp/as-extract
    tar -xzf '$APP_DIR/incoming/node.tgz' -C /tmp/as-extract
    rm -rf dist
    mv /tmp/as-extract/dist dist
    cp /tmp/as-extract/package.json /tmp/as-extract/package-lock.json .
    chmod -R a+rX dist
    chown -R agentstack:agentstack dist package.json package-lock.json
    rm -rf /tmp/as-extract
    echo -n '  已替换，入口: '; ls dist/main.js"
  if [ "$reinstall" = 1 ]; then
    log "package.json 有变化，服务器上执行 npm ci --omit=dev"
    sshrun "cd '$APP_DIR/runtime' && npm ci --omit=dev --no-audit --no-fund >/dev/null && chown -R agentstack:agentstack node_modules && echo '  依赖已重装'"
  fi
  sshrun "set -e
    systemctl reset-failed agent-stack-runtime 2>/dev/null || true
    systemctl restart agent-stack-runtime
    echo '  已重启，等待就绪…'"
  wait_http "$NODE_HEALTH" '"status":"ok"' agent-stack-runtime 90
  ok "运行时已更新并就绪"
}

# ---------------------------------------------------------------- 验收
verify() {
  log "验收（从本机与服务器两侧实测）"
  local fail=0
  check() {
    if [ "$2" = "$3" ]; then printf '  ✅ %-42s %s\n' "$1" "$3"
    else printf '  ❌ %-42s 期望 %s 实际 %s\n' "$1" "$2" "$3"; fail=1; fi
  }
  check "java /actuator/health" "UP" \
    "$(sshrun "curl -s --max-time 5 http://127.0.0.1:18080/actuator/health" | sed -nE 's/.*"status":"([A-Z]+)".*/\1/p' | tr -d '\n')"
  check "node /healthz" "ok" \
    "$(sshrun "curl -s --max-time 5 http://127.0.0.1:8090/healthz" | sed -nE 's/.*"status":"([a-z]+)".*/\1/p' | tr -d '\n')"
  for c in agent-stack-server agent-stack-runtime nginx; do
    check "systemd $c" "active" "$(sshrun "systemctl is-active $c" | tr -d '\n')"
  done
  check "前端 :$PUBLIC_PORT/" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$DEPLOY_HOST:$PUBLIC_PORT/")"
  check "前端 :$PUBLIC_PORT/api/capabilities" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$DEPLOY_HOST:$PUBLIC_PORT/api/capabilities")"
  check "80 端口 /studio/" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$DEPLOY_HOST/studio/")"
  check "简历站（未被影响）/" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$DEPLOY_HOST/")"
  printf '  模型与节点类型：%s\n' "$(curl -s --max-time 10 "http://$DEPLOY_HOST:$PUBLIC_PORT/api/capabilities")"
  if [ "$fail" = 0 ]; then ok "验收全部通过"; else die "验收有失败项"; fi
}

# ---------------------------------------------------------------- 主流程
case "${1:-all}" in
  frontend) deploy_frontend ;;
  java)     deploy_java ;;
  node)     deploy_node ;;
  all)
    deploy_frontend
    deploy_java
    deploy_node
    ok "三个组件都已更新"
    ;;
  verify)   verify ;;
  ssh)      shift; exec env -u SSH_AUTH_SOCK DISPLAY=:0 SSH_ASKPASS="$ASKPASS" \
                       SSH_ASKPASS_REQUIRE=force ssh "${SSH_OPTS[@]}" "$SSH_USER@$DEPLOY_HOST" "$@" ;;
  *) die "用法: $0 {all|frontend|java|node|verify|ssh}" ;;
esac
