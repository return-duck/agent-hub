#!/usr/bin/env bash
# ============================================================================
# Agent Stack · 三包分离部署（本地执行）
#
#   bash deploy/split/deploy.sh init      # 一次性：建目录/迁移 JRE/装 nginx+systemd/建库
#   bash deploy/split/deploy.sh web       # 只打包上传前端 → nginx 托管
#   bash deploy/split/deploy.sh server    # 只打包上传 Java → 重启后端
#   bash deploy/split/deploy.sh runtime   # 只打包上传 Node → npm install → 重启
#   bash deploy/split/deploy.sh config    # 只应用 deploy.env 里的配置（改 key/端口后用这个）
#   bash deploy/split/deploy.sh all       # 三个都来（不含 init）
#   bash deploy/split/deploy.sh verify    # 端到端验收（从公网访问 :8080）
#   bash deploy/split/deploy.sh ssh       # 只测连通性
#
# 三个组件各自独立打包、独立上传、独立启动，互不影响：
#   web      → /home/admin/agent-stack/web            （nginx 静态托管）
#   server   → /home/admin/agent-stack/server/*.jar   （systemd: agent-stack-server）
#   runtime  → /home/admin/agent-stack/runtime/       （systemd: agent-stack-runtime）
#
# 配置复用 deploy/deploy.env（你原来那份），只需要补 DEPLOY_HOST_PASSWORD。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/deploy/split/lib.sh"

COMPONENT="${1:-}"
case "$COMPONENT" in
  init|web|server|runtime|config|all|verify|ssh) ;;
  *) die "用法: bash deploy/split/deploy.sh {init|web|server|runtime|config|all|verify|ssh}" ;;
esac

STAGE_ROOT="$ROOT/build/split"
REMOTE_INCOMING="$APP_DIR/incoming"

# ---------------------------------------------------------------- 连通性
if [ "$COMPONENT" != "verify" ]; then
  info "检查到 $TARGET:$SSH_PORT 的连通性 ..."
  sshrun 'echo ok' >/dev/null || die "连不上服务器。若机器卡死，先在阿里云控制台重启实例"
fi

if [ "$COMPONENT" = "ssh" ]; then ok "SSH 可用"; exit 0; fi

# ---------------------------------------------------------------- 本地构建 + 打包
build_and_pack() { # build_and_pack <component>
  local c="$1"
  local stage="$STAGE_ROOT/$c"
  rm -rf "$stage"; mkdir -p "$stage"

  case "$c" in
    web)
      info "[web] 构建前端（vite build）..."
      (cd "$ROOT/web" && npm run build --silent)
      cp -R "$ROOT/web/dist/." "$stage/"
      ;;
    server)
      info "[server] 打包 Java（mvn clean package，刻意不带 -Pwith-web，前端已独立）..."
      (cd "$ROOT/server" && "$ROOT/scripts/mvn.sh" -B -q -DskipTests clean package)
      local jar
      jar="$(ls -1 "$ROOT/server/target/"*.jar | grep -v '\.original$' | head -1)"
      [ -n "$jar" ] || die "没找到 server jar"
      cp "$jar" "$stage/agent-stack-server.jar"
      cp "$ROOT/deploy/split/files/server/start.sh" "$ROOT/deploy/split/files/server/stop.sh" "$stage/"
      chmod +x "$stage/start.sh" "$stage/stop.sh"
      ;;
    runtime)
      info "[runtime] 构建 Node（tsc）..."
      (cd "$ROOT/runtime" && npm run build --silent)
      cp -R "$ROOT/runtime/dist" "$stage/dist"
      # 照 resume-agent/scripts/pack.sh 的做法：只带源码与清单，绝不打包 node_modules
      cp "$ROOT/runtime/package.json" "$ROOT/runtime/package-lock.json" "$stage/"
      cp "$ROOT/runtime/.env.example" "$stage/" 2>/dev/null || true
      cp "$ROOT/deploy/split/files/runtime/start.sh" "$ROOT/deploy/split/files/runtime/stop.sh" "$stage/"
      chmod +x "$stage/start.sh" "$stage/stop.sh"
      ;;
  esac

  # 权限归一化：保证包内文件对"其它用户"可读。
  # nginx 静态文件必须以 nginx 用户可读（644/755），否则部署完是 403。
  chmod -R a+rX "$stage"
  find "$stage" -type f -name '*.sh' -exec chmod 755 {} +

  local tarball="$STAGE_ROOT/agent-stack-$c.tar.gz"
  rm -f "$tarball"
  tar -C "$stage" -czf "$tarball" .
  ok "[$c] 打包完成 → $(du -h "$tarball" | cut -f1)  $tarball"
}

upload() { # upload <component>
  local c="$1"
  local tarball="$STAGE_ROOT/agent-stack-$c.tar.gz"
  info "[$c] 上传 ..."
  sshrun "mkdir -p '$REMOTE_INCOMING'"
  sshrun "cat > '$REMOTE_INCOMING/agent-stack-$c.tar.gz'" < "$tarball"
  local local_size remote_size
  local_size="$(wc -c < "$tarball" | tr -d ' ')"
  remote_size="$(sshrun "wc -c < '$REMOTE_INCOMING/agent-stack-$c.tar.gz'" | tr -d ' \r')"
  [ "$local_size" = "$remote_size" ] || die "[$c] 上传不完整（$local_size / $remote_size）"
  ok "[$c] 上传完成并校验一致（$local_size 字节）"
}

# 一次性：把 install.sh 与静态文件（nginx 配置、systemd 单元）送上去
upload_installer() {
  info "上传部署器（install.sh + nginx/systemd 配置）..."
  local payload="$STAGE_ROOT/deployer"
  rm -rf "$payload"; mkdir -p "$payload/files/systemd"
  cp "$ROOT/deploy/split/install.sh" "$ROOT/deploy/split/lib.sh" "$payload/"
  cp "$ROOT/deploy/split/files/nginx-agent-stack.conf" "$payload/files/"
  cp "$ROOT/deploy/split/files/systemd/"*.service "$payload/files/systemd/"
  chmod +x "$payload/install.sh"
  tar -C "$payload" -czf - . | sshrun "mkdir -p '$REMOTE_INCOMING/deployer' && tar -xzf - -C '$REMOTE_INCOMING/deployer'"
  # 服务器端配置（含密码，上传后 chmod 600）
  local env_file="$STAGE_ROOT/server-config.env"
  # 用子 shell 限定 umask 的作用域！
  # 之前直接在函数里 umask 077，会泄漏到后续的打包过程：cp 会把前端文件建成 600，
  # tar 把 600 打进包，服务器解包后 nginx 读不了 → 403 Permission denied。
  (
  umask 077
  cat > "$env_file" <<ENV
APP_DIR=$APP_DIR
APP_PORT=$APP_PORT
SERVER_PORT=$SERVER_PORT
RUNTIME_PORT=$RUNTIME_PORT
NODE_BIN=$NODE_BIN

DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_ADMIN_USER=$DB_ADMIN_USER
DB_ADMIN_PASSWORD=$DB_ADMIN_PASSWORD

MODEL_PROVIDER=$MODEL_PROVIDER
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
MODEL_NAME=${MODEL_NAME:-}
MODEL_BASE_URL=${MODEL_BASE_URL:-}
MODEL_TEMPERATURE=${MODEL_TEMPERATURE:-0.2}
TOOL_HTTP_ALLOWLIST=${TOOL_HTTP_ALLOWLIST:-}

NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
RUN_AS=${RUN_AS:-agentstack}
JRE_SOURCE=${JRE_SOURCE:-/opt/agent-stack/.toolchain/jre}
ENV
  )
  sshrun "cat > '$REMOTE_INCOMING/deployer/server-config.env'" < "$env_file"
  sshrun "chmod 600 '$REMOTE_INCOMING/deployer/server-config.env'"
  ok "部署器已上传"
}

remote_install() { # remote_install <component>
  local c="$1"
  sshrun "bash '$REMOTE_INCOMING/deployer/install.sh' $c"
}

# ---------------------------------------------------------------- 主流程
case "$COMPONENT" in
  init)
    build_and_pack web          # 建库/装 nginx 后顺手把前端也布置上，避免开局是空站
    upload_installer
    upload web
    remote_install init
    remote_install web
    ok "init 完成"
    ;;
  web|server|runtime)
    upload_installer   # 幂等，顺便保证服务器端脚本是最新的
    build_and_pack "$COMPONENT"
    upload "$COMPONENT"
    remote_install "$COMPONENT"
    ;;
  config)
    # 只重写服务器上的 shared/*.env 并重启组件：改了 key / 端口后用它，不必重跑 init
    upload_installer
    remote_install config
    ;;
  all)
    upload_installer
    for c in web server runtime; do
      build_and_pack "$c"
      upload "$c"
      remote_install "$c"
    done
    ok "三个组件都已更新"
    ;;
  verify)
    remote_install verify
    ;;
esac

echo
ok "完成。常用命令："
cat <<TIP
  浏览器        http://${DEPLOY_HOST}:${APP_PORT}
  验收          bash deploy/split/deploy.sh verify
  单独更新前端   bash deploy/split/deploy.sh web
  单独更新后端   bash deploy/split/deploy.sh server
  单独更新运行时 bash deploy/split/deploy.sh runtime

  服务器上（组件各自的启停，和 resume 的 start.sh 习惯一致）：
    ${APP_DIR}/server/start.sh  | stop.sh
    ${APP_DIR}/runtime/start.sh | stop.sh
    systemctl status agent-stack-server agent-stack-runtime
    systemctl reload nginx
TIP
