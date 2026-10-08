#!/usr/bin/env bash
# ============================================================================
# 救援脚本（本地执行）：当服务器被内存耗尽拖到 SSH 都发不出 banner 时用。
#
#   bash deploy/rescue.sh            # 上传 → 脱离连接执行 → 跟随日志
#   bash deploy/rescue.sh --follow   # 只跟随日志
#
# 它会做的事（详见 deploy/rescue-remote.sh 顶部注释）：
#   停掉并禁止自启本项目的服务释放内存 → 抓取根因日志 → 停掉占用 8080 的既有应用
#   → 安装保守配置的 systemd 单元（堆 256MB、端口 8080、限制重启次数）→ 启动并验证
#
# 为什么端口用 8080 而不是 8081：8080 已被安全组放行（公网 TCP 可达已实测），
# 而 8081 在应用没起来时无法验证是否放行。用 8080 可以不改安全组就对外可达。
#
# 支持两种登录方式：SSH 密钥（DEPLOY_SSH_KEY 存在时）或密码（DEPLOY_HOST_PASSWORD）。
# 密码只从 deploy.env 读取，不经过命令行参数，也不会被打印。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${DEPLOY_CONFIG:-$ROOT/deploy/deploy.env}"
REMOTE_SCRIPT="$ROOT/deploy/rescue-remote.sh"
REMOTE_PATH=/opt/agent-stack/rescue.sh
REMOTE_LOG=/opt/agent-stack/fix.log

info() { printf '\033[1;34m[rescue]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[rescue] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "缺少 $CONFIG"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a
: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"
PORT="${DEPLOY_SSH_PORT:-22}"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

# ---- 组装 ssh 调用方式 ----
SSH_BASE=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 -o IPQoS=none
          -o ServerAliveInterval=10 -p "$PORT")
USE_ASKPASS=0
if [ -n "${DEPLOY_SSH_KEY:-}" ] && [ -f "${DEPLOY_SSH_KEY/#\~/$HOME}" ]; then
  SSH_BASE+=(-i "${DEPLOY_SSH_KEY/#\~/$HOME}")
elif [ -n "${DEPLOY_HOST_PASSWORD:-}" ]; then
  ASKPASS="$(mktemp)"
  trap 'rm -f "$ASKPASS"' EXIT
  cat > "$ASKPASS" <<ASK
#!/bin/sh
grep -E '^DEPLOY_HOST_PASSWORD=' "$CONFIG" | head -1 | cut -d= -f2-
ASK
  chmod 700 "$ASKPASS"
  USE_ASKPASS=1
  SSH_BASE+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no
             -o NumberOfPasswordPrompts=1)
else
  die "deploy.env 里既没有可用的 DEPLOY_SSH_KEY，也没有 DEPLOY_HOST_PASSWORD"
fi

sshrun() {
  if [ "$USE_ASKPASS" -eq 1 ]; then
    env -u SSH_AUTH_SOCK DISPLAY=:0 SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force \
      ssh "${SSH_BASE[@]}" -o LogLevel=ERROR "$TARGET" "$@"
  else
    ssh "${SSH_BASE[@]}" -o LogLevel=ERROR "$TARGET" "$@"
  fi
}

if [ "${1:-}" != "--follow" ]; then
  info "检查连通性（$TARGET:$PORT）..."
  sshrun 'echo ok' >/dev/null || die "连不上。若服务器已卡死，先在阿里云控制台【重启实例】，再跑本脚本"

  info "上传抢救脚本 ..."
  sshrun "cat > $REMOTE_PATH" < "$REMOTE_SCRIPT"
  local_size=$(wc -c < "$REMOTE_SCRIPT" | tr -d ' ')
  remote_size=$(sshrun "wc -c < $REMOTE_PATH" | tr -d ' \r')
  [ "$local_size" = "$remote_size" ] || die "上传不完整（$local_size vs $remote_size）"
  info "上传完成并校验一致（$local_size 字节）"

  info "在服务器上脱离连接执行（即使断线也会跑完）..."
  sshrun "chmod +x $REMOTE_PATH; rm -f $REMOTE_LOG; (setsid nohup bash $REMOTE_PATH >/dev/null 2>&1 &); sleep 1; echo started"
  info "已启动，等待 150 秒后读取结果 ..."
  sleep 150
fi

info "服务器端执行日志（$REMOTE_LOG）："
echo "-----------------------------------------------------------------------"
sshrun "cat $REMOTE_LOG 2>/dev/null || echo '(暂无日志)'"
echo "-----------------------------------------------------------------------"
info "若上面显示 ✅ 本机健康检查通过，请从公网验证："
echo "    curl -s http://$DEPLOY_HOST:8080/api/capabilities"
