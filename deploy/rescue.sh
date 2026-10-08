#!/usr/bin/env bash
# ============================================================================
# 救援脚本（本地执行）
#
#   bash deploy/rescue.sh            # 重试等待 → 上传并在服务器上脱离执行 → 跟随日志
#   bash deploy/rescue.sh --follow   # 只看服务器上的执行日志
#   bash deploy/rescue.sh --upload-only
#
# 设计要点：
#  1) 【单连接一次性完成】：用 heredoc 把"写脚本 + chmod + setsid 脱离启动"合成一次 SSH，
#     而不是分 4 次往返 —— 机器刚重启时可用窗口可能只有几十秒，往返越少越好。
#  2) 【自带重试】：你只要跑一次，它会每 30 秒重试、持续 30 分钟，等机器活过来。
#  3) 【服务器端脱离执行】：脚本用 setsid 脱离，连接断了也会跑完（日志在 $REMOTE_LOG）。
#
# 服务器端做的事见 deploy/rescue-remote.sh 顶部注释。
# 支持密钥（DEPLOY_SSH_KEY）或密码（DEPLOY_HOST_PASSWORD）；密码只从 deploy.env 读，不经 argv。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${DEPLOY_CONFIG:-$ROOT/deploy/deploy.env}"
REMOTE_SCRIPT="$ROOT/deploy/rescue-remote.sh"
REMOTE_PATH=/opt/agent-stack/rescue.sh
REMOTE_LOG=/opt/agent-stack/fix.log
RETRY_SECONDS=1800   # 总重试时长

info() { printf '\033[1;34m[rescue]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[rescue]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[rescue] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "缺少 $CONFIG"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a
: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"
PORT="${DEPLOY_SSH_PORT:-22}"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

SSH_BASE=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 -o IPQoS=none
          -o ServerAliveInterval=10 -p "$PORT")
USE_ASKPASS=0
KEY="${DEPLOY_SSH_KEY/#\~/$HOME}"
if [ -n "${DEPLOY_SSH_KEY:-}" ] && [ -f "$KEY" ]; then
  SSH_BASE+=(-i "$KEY")
elif [ -n "${DEPLOY_HOST_PASSWORD:-}" ]; then
  ASKPASS="$(mktemp)"; trap 'rm -f "$ASKPASS"' EXIT
  cat > "$ASKPASS" <<ASK
#!/bin/sh
grep -E '^DEPLOY_HOST_PASSWORD=' "$CONFIG" | head -1 | cut -d= -f2-
ASK
  chmod 700 "$ASKPASS"
  USE_ASKPASS=1
  SSH_BASE+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1)
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

# ---- 单连接：写脚本 + 校验字节数 + setsid 脱离启动 ----
oneshot() {
  local payload
  payload="$(cat <<EOF
cat > $REMOTE_PATH <<'RESCUE_SCRIPT_EOF'
$(cat "$REMOTE_SCRIPT")
RESCUE_SCRIPT_EOF
chmod +x $REMOTE_PATH
rm -f $REMOTE_LOG
(setsid nohup bash $REMOTE_PATH >/dev/null 2>&1 &)
sleep 1
echo "UPLOADED_BYTES=\$(wc -c < $REMOTE_PATH)"
echo LAUNCHED
EOF
)"
  sshrun "$payload"
}

case "${1:-}" in
  --follow)
    info "读取服务器端日志 $REMOTE_LOG ..."
    sshrun "cat $REMOTE_LOG 2>/dev/null || echo '(暂无日志)'"
    exit 0 ;;
  --upload-only)
    oneshot; exit 0 ;;
esac

LOCAL_BYTES="$(wc -c < "$REMOTE_SCRIPT" | tr -d ' ')"
info "目标 $TARGET:$PORT；本地救援脚本 $LOCAL_BYTES 字节"
info "开始重试（每 30 秒一次，最多 $((RETRY_SECONDS / 60)) 分钟）—— 机器可能仍在卡死，属正常"

DEADLINE=$(( $(date +%s) + RETRY_SECONDS ))
OK=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if OUT="$(oneshot 2>&1)"; then
    UP="$(printf '%s' "$OUT" | grep -oE 'UPLOADED_BYTES=[0-9]+' | cut -d= -f2 || true)"
    if [ "${UP:-0}" = "$LOCAL_BYTES" ] && printf '%s' "$OUT" | grep -q LAUNCHED; then
      info "上传校验一致（$UP 字节）并已在服务器上脱离启动 ✅"
      OK=1
      break
    fi
    warn "连上了但上传不完整（${UP:-0}/$LOCAL_BYTES），继续重试"
  fi
  printf '.'
  sleep 30
done
echo

if [ "$OK" -ne 1 ]; then
  die "在 $((RETRY_SECONDS / 60)) 分钟内始终无法登录，说明机器仍在卡死状态。
请在阿里云控制台【重启实例】；如果重启后又卡死，用控制台的【远程连接(VNC)】或
【云助手 → 发送命令】粘贴执行 deploy/emergency-disable.sh 的内容（只有几行，
先给机器松绑并禁止我的服务自启），然后再重跑本脚本。"
fi

info "等待服务器端执行完成（150 秒）..."
sleep 150
info "服务器端执行日志："
echo "-----------------------------------------------------------------------"
sshrun "cat $REMOTE_LOG 2>/dev/null || echo '(暂无日志)'" || true
echo "-----------------------------------------------------------------------"
cat <<TIP

如果上面显示「✅ 本机健康检查通过」，请从公网验证：
    curl -s http://${DEPLOY_HOST}:8080/api/capabilities
    浏览器打开 http://${DEPLOY_HOST}:8080

端口是 8080（不是 8081）：8080 已被安全组放行（公网 TCP 可达已实测），
而 8081 在应用未启动时无法验证是否放行 —— 用 8080 可以不改安全组就对外可用。

若为释放内存停掉了你原有的应用，恢复方式：
    cat /opt/agent-stack/stopped-for-memory.txt      # 看被停的是哪个单元
    systemctl enable --now <上面文件里的单元名>        # 恢复
TIP
