#!/usr/bin/env bash
# ============================================================================
# 三包分离部署的公共部分：读取配置、SSH 封装、日志
# 由 deploy.sh 与 install.sh 共同 source
# ============================================================================

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG="${DEPLOY_CONFIG:-$ROOT/deploy/deploy.env}"

info() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "缺少配置 $CONFIG（可从 deploy/deploy.env.example 复制）"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a
: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"

# ---- 三包分离引入的默认值（不改动你原有的配置项） ----
: "${APP_DIR:=/home/admin/agent-stack}"
: "${APP_PORT:=8080}"          # nginx 对外端口（已被安全组放行）
: "${SERVER_PORT:=18080}"      # Java 只监听 127.0.0.1
: "${RUNTIME_PORT:=18090}"     # Node 只监听 127.0.0.1
: "${NODE_BIN:=/usr/bin/node}" # 复用系统 Node（v22.23.0，已实测）
: "${RUN_AS:=agentstack}"      # 服务运行账号（非 root、无登录）
: "${JRE_SOURCE:=/opt/agent-stack/.toolchain/jre}"   # 复用已下载的 JRE 21（系统只有 Java 11）
: "${NPM_REGISTRY:=https://registry.npmmirror.com}"
: "${MODEL_PROVIDER:=deepseek}"
: "${MODEL_TEMPERATURE:=0.2}"

# 端点覆盖变量在运行时里叫 MODEL_BASE_URL（不是 OPENAI_BASE_URL），这里兼容两种写法，
# 免得"填了 OPENAI_BASE_URL 却不生效"这种查不出原因的坑。
: "${MODEL_BASE_URL:=${OPENAI_BASE_URL:-}}"

# 浏览器 POST 一定带 Origin 头。虽然修好 Host 转发后同源请求不会再触发 CORS 校验，
# 这里仍然把真实访问地址放进白名单，作为第二道保险（例如以后换域名/换端口访问）。
# 注意 WebConfig 用的是 allowedOrigins（精确匹配，不支持通配符）且开了 allowCredentials，
# 所以必须逐个列出，不能用 "*"。
: "${CORS_ORIGINS:=http://${DEPLOY_HOST}:${APP_PORT},http://${DEPLOY_HOST},http://localhost:5173,http://127.0.0.1:5173}"
: "${DEEPSEEK_API_KEY:=}"
: "${OPENAI_API_KEY:=}"

SSH_PORT="${DEPLOY_SSH_PORT:-22}"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

SSH_BASE=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 -o IPQoS=none
          -o ServerAliveInterval=10 -p "$SSH_PORT")
USE_ASKPASS=0
KEY="${DEPLOY_SSH_KEY/#\~/$HOME}"
# 注意顺序：优先用【密码】而不是密钥。
# 因为 deploy.env 里 DEPLOY_SSH_KEY 指向的 ~/.ssh/id_rsa 在本机是存在的，
# 但服务器上未必被授权（本机部署时用的是密码），优先密钥会导致
# "Permission denied, please try again." 而看不出原因。
if [ -n "${DEPLOY_HOST_PASSWORD:-}" ]; then
  ASKPASS="$(mktemp)"; trap 'rm -f "$ASKPASS"' EXIT
  cat > "$ASKPASS" <<ASK
#!/bin/sh
grep -E '^DEPLOY_HOST_PASSWORD=' "$CONFIG" | head -1 | cut -d= -f2-
ASK
  chmod 700 "$ASKPASS"
  USE_ASKPASS=1
  SSH_BASE+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1)
elif [ -n "${DEPLOY_SSH_KEY:-}" ] && [ -f "$KEY" ]; then
  SSH_BASE+=(-i "$KEY")
else
  die "$CONFIG 里既没有 DEPLOY_HOST_PASSWORD，也没有可用的 DEPLOY_SSH_KEY"
fi

sshrun() {
  if [ "$USE_ASKPASS" -eq 1 ]; then
    env -u SSH_AUTH_SOCK DISPLAY=:0 SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force \
      ssh "${SSH_BASE[@]}" -o LogLevel=ERROR "$TARGET" "$@"
  else
    ssh "${SSH_BASE[@]}" -o LogLevel=ERROR "$TARGET" "$@"
  fi
}
