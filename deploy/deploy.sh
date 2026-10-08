#!/usr/bin/env bash
# ============================================================================
# Agent Stack 本地部署脚本（在【你的 Mac 上】执行）
#
#   1. 本机构建三个产物（服务器上不需要 JDK / Maven / npm）
#   2. 组装 release/ 并打包上传
#   3. 在服务器上触发 remote-install.sh 完成安装与重启
#
# 用法：
#   cp deploy/deploy.env.example deploy/deploy.env   # 先填配置
#   bash deploy/deploy.sh                            # 构建 + 上传 + 安装
#   bash deploy/deploy.sh --skip-build               # 复用上次产物，只上传
#   bash deploy/deploy.sh --build-only               # 只在本机构建并组装 release/
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${DEPLOY_CONFIG:-$ROOT/deploy/deploy.env}"
RELEASE_DIR="$ROOT/build/release"

SKIP_BUILD=0
BUILD_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

# ----------------------------------------------------------------- 读取配置
[ -f "$CONFIG" ] || die "找不到配置文件 $CONFIG
请先执行： cp deploy/deploy.env.example deploy/deploy.env  然后填写它"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a

for var in DEPLOY_HOST DEPLOY_USER APP_DIR APP_PORT RUNTIME_PORT DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD; do
  [ -n "${!var:-}" ] || die "配置项 $var 不能为空（见 $CONFIG）"
done
[ "$APP_PORT" != "$RUNTIME_PORT" ] || die "APP_PORT 与 RUNTIME_PORT 不能相同"

: "${SERVE_WEB:=true}"
: "${NODE_VERSION:=v22.12.0}"
: "${JDK_MAJOR:=21}"
: "${NODE_MIRROR:=https://npmmirror.com/mirrors/node}"
: "${NPM_REGISTRY:=https://registry.npmmirror.com}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p "${DEPLOY_SSH_PORT:-22}")
[ -n "${DEPLOY_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${DEPLOY_SSH_KEY/#\~/$HOME}")
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
REMOTE_INCOMING="$APP_DIR/incoming"

remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

# ----------------------------------------------------------------- 本机构建
build_all() {
  info "1/5 检查本机工具链 ..."
  # shellcheck source=../scripts/env.sh
  source "$ROOT/scripts/env.sh"
  [ -x "$JAVA_HOME/bin/java" ] || die "本机缺少 JDK，请先执行 scripts/toolchain.sh"

  info "2/5 构建 runtime 产物（tsc） ..."
  (cd "$ROOT/runtime" && npm run build --silent)

  local MVN_ARGS=(-B -q -DskipTests clean package)
  if [ "$SERVE_WEB" = "true" ]; then
    info "3/5 构建前端产物（vite） ..."
    (cd "$ROOT/web" && npm run build --silent)
    MVN_ARGS+=(-Pwith-web)
    info "    并打进 jar（单端口模式：一个端口同时提供 UI 与 API）"
  else
    warn "3/5 SERVE_WEB=false，跳过前端；请自行用 nginx/CDN 托管 web/dist"
  fi

  info "4/5 打包 server（mvn clean package） ..."
  (cd "$ROOT/server" && "$ROOT/scripts/mvn.sh" "${MVN_ARGS[@]}")

  info "5/5 组装 release/ ..."
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR/runtime" "$RELEASE_DIR/deploy"

  local jar
  jar="$(ls -1 "$ROOT/server/target/"*.jar | grep -v '\.original$' | head -1)"
  [ -n "$jar" ] || die "没找到 server jar"
  cp "$jar" "$RELEASE_DIR/agent-stack-server.jar"

  # runtime 只带产物与依赖清单；node_modules 到服务器上 npm ci --omit=dev 安装（更小、更干净）
  cp -R "$ROOT/runtime/dist" "$RELEASE_DIR/runtime/dist"
  cp "$ROOT/runtime/package.json" "$ROOT/runtime/package-lock.json" "$RELEASE_DIR/runtime/"

  cp "$ROOT/deploy/remote-install.sh" "$RELEASE_DIR/deploy/"
  cp -R "$ROOT/deploy/systemd" "$RELEASE_DIR/deploy/"

  ok "release 组装完成：$(du -sh "$RELEASE_DIR" | cut -f1)"
}

if [ "$SKIP_BUILD" -eq 0 ]; then
  build_all
else
  [ -d "$RELEASE_DIR" ] || die "--skip-build 但 $RELEASE_DIR 不存在，请先完整跑一次"
  info "跳过构建，复用 $RELEASE_DIR"
fi

# ------------------------------------------------------- 生成服务器端配置
# 与 deploy.env 分开：只把服务器真正需要的变量传过去，密码文件在服务器上 chmod 600
write_remote_env() {
  local out="$RELEASE_DIR/deploy/remote.env"
  umask 077
  cat > "$out" <<ENV
# 由 deploy.sh 生成，不要在服务器上手工编辑（下次部署会覆盖）
APP_DIR=$APP_DIR
APP_PORT=$APP_PORT
RUNTIME_PORT=$RUNTIME_PORT
SERVE_WEB=$SERVE_WEB

DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_ADMIN_USER=$DB_ADMIN_USER
DB_ADMIN_PASSWORD=$DB_ADMIN_PASSWORD

MODEL_PROVIDER=$MODEL_PROVIDER
OPENAI_API_KEY=${OPENAI_API_KEY:-}
OPENAI_BASE_URL=${OPENAI_BASE_URL:-}
MODEL_NAME=${MODEL_NAME:-}
TOOL_HTTP_ALLOWLIST=${TOOL_HTTP_ALLOWLIST:-}

JDK_MAJOR=$JDK_MAJOR
NODE_VERSION=$NODE_VERSION
NODE_MIRROR=$NODE_MIRROR
NPM_REGISTRY=$NPM_REGISTRY
ENV
  ok "已生成服务器端配置（含密码，上传后会被置为 600）"
}

write_remote_env

if [ "$BUILD_ONLY" -eq 1 ]; then
  ok "--build-only 结束。产物在 $RELEASE_DIR"
  exit 0
fi

# ----------------------------------------------------------------- 上传
info "上传到 $TARGET:$REMOTE_INCOMING ..."
remote "mkdir -p '$REMOTE_INCOMING'"
# 用 tar over ssh 而不是 rsync：macOS 自带的是 openrsync，行为与 GNU rsync 有差异
tar -C "$RELEASE_DIR" -czf - . | remote "tar -xzf - -C '$REMOTE_INCOMING'"
remote "chmod 600 '$REMOTE_INCOMING/deploy/remote.env'"
ok "上传完成"

# ----------------------------------------------------------------- 远程安装
info "在服务器上执行安装（需要 root 或免密 sudo）..."
remote "bash '$REMOTE_INCOMING/deploy/remote-install.sh'"

echo
ok "部署完成 🎉"
cat <<TIP

接下来确认两件事：

  1. 阿里云控制台 → 该 ECS 实例 → 安全组 → 入方向规则，放行：
        TCP ${APP_PORT}     （应用，必须）
        TCP ${DEPLOY_SSH_PORT:-22}      （SSH，通常已有）
     注意：安全组是独立于服务器系统防火墙的一层，只改系统防火墙没用。
     另外大陆地域未备案的域名走 80/443 会被拦，所以我们用的是高位端口。

  2. 浏览器打开：  http://${DEPLOY_HOST}:${APP_PORT}

服务器上常用的排查命令：

  ssh ${TARGET} 'systemctl status agent-stack-server agent-stack-runtime'
  ssh ${TARGET} 'journalctl -u agent-stack-server -f'
  ssh ${TARGET} 'journalctl -u agent-stack-runtime -f'
  ssh ${TARGET} 'ls -l ${APP_DIR}/current'          # 当前生效的版本
  ssh ${TARGET} 'ls -1 ${APP_DIR}/releases'         # 历史版本，可回滚
TIP
