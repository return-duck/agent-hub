#!/usr/bin/env bash
# ============================================================================
# Agent Stack · 三包分离部署（服务器端，由 deploy.sh 上传后在服务器上执行）
#
#   install.sh init     一次性：建目录 / 迁移 JRE / 停旧单元 / 装 nginx+systemd / 建库
#   install.sh web      解包前端 → nginx 托管并 reload
#   install.sh server   解包 Java → 重启后端
#   install.sh runtime  解包 Node → npm ci → 重启运行时
#   install.sh verify   端到端验收
#
# 幂等，可重复执行。不改动你现有的 80 端口 resume 站点，只新增一个 8080 的 server 块。
# ============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SELF_DIR/server-config.env"
INCOMING="$(dirname "$SELF_DIR")"

step() { echo; echo "############ $* ############"; }
ok()   { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
info() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "缺少 $CONFIG"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a
: "${APP_DIR:?}"; : "${RUN_AS:?}"

if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then exec sudo -E bash "$0" "$@"; fi
  die "需要 root 权限"
fi

APP_PORT="${APP_PORT:-8080}"
SERVER_PORT="${SERVER_PORT:-18080}"
RUNTIME_PORT="${RUNTIME_PORT:-18090}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

# ------------------------------------------------------------------ 工具函数
ensure_user() {
  getent group "$RUN_AS" >/dev/null 2>&1 || groupadd -r "$RUN_AS" || die "建组失败"
  if ! id -u "$RUN_AS" >/dev/null 2>&1; then
    useradd -r -g "$RUN_AS" -s /sbin/nologin -d "$APP_DIR" "$RUN_AS" 2>/dev/null \
      || useradd -r -g "$RUN_AS" -s /usr/sbin/nologin -d "$APP_DIR" "$RUN_AS" \
      || die "建用户失败"
    info "已创建服务账号 $RUN_AS（非 root、无登录）"
  fi
}

# 把模板里的 __XXX__ 占位符换成实际值。
# 之所以要模板化：APP_DIR / 端口 / 运行时路径都来自配置，
# 之前把它们写死在 nginx/systemd 文件里，一旦配置与写死值不一致，
# 就会出现"单元指向不存在的目录"这种极难一眼看出的故障（真实踩过）。
render() { # render <模板> <目标> [额外 sed 表达式...]
  local tpl="$1" out="$2"; shift 2
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__APP_PORT__|$APP_PORT|g" \
      -e "s|__SERVER_PORT__|$SERVER_PORT|g" \
      -e "s|__RUNTIME_PORT__|$RUNTIME_PORT|g" \
      -e "s|__RUN_AS__|$RUN_AS|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__JAVA_BIN__|$APP_DIR/jre/bin/java|g" \
      "$@" "$tpl" > "$out"
  if grep -qE '__[A-Z_]+__' "$out"; then
    warn "  模板 $tpl 里还有未替换的占位符："
    grep -nE '__[A-Z_]+__' "$out" | head -5
    return 1
  fi
}

http_ok() { # http_ok <url> <期望子串>
  curl -s --max-time 8 "$1" 2>/dev/null | grep -q "$2"
}

wait_http() { # wait_http <url> <期望子串> <名称> <最多秒>
  local url="$1" expect="$2" name="$3" limit="${4:-90}" i
  for ((i = 1; i <= limit; i++)); do
    if http_ok "$url" "$expect"; then ok "  $name 就绪（${i}s）"; return 0; fi
    sleep 1
  done
  warn "  $name 在 ${limit}s 内未就绪"
  return 1
}

# ================================================================ init
do_init() {
  step "1. 建目录与服务账号"
  mkdir -p "$APP_DIR"/{web,server/logs,runtime/logs,shared,incoming}
  ensure_user

  step "2. 停掉旧部署（原 /opt/agent-stack 的两个单元）"
  systemctl stop agent-stack-server agent-stack-runtime 2>/dev/null || true
  sleep 2
  systemctl is-active agent-stack-server agent-stack-runtime 2>&1 | tr '\n' ' '; echo
  info "释放了 $APP_PORT / 8090 端口"

  step "3. 迁移 JRE 21（复用已下载的，不重新下载）"
  if [ -x "$APP_DIR/jre/bin/java" ]; then
    ok "  已是 $APP_DIR/jre：$("$APP_DIR/jre/bin/java" -version 2>&1 | head -1)"
  elif [ -x "${JRE_SOURCE:-}/bin/java" ]; then
    info "  从 $JRE_SOURCE 迁移（同分区 mv，秒级完成）"
    rm -rf "$APP_DIR/jre"
    mv "$JRE_SOURCE" "$APP_DIR/jre" || cp -R "$JRE_SOURCE" "$APP_DIR/jre"
    ok "  JRE 就绪：$("$APP_DIR/jre/bin/java" -version 2>&1 | head -1)"
  else
    die "找不到 JRE。系统自带的是 Java 11（Spring Boot 3.5 需要 17+），
    请执行: dnf install -y java-21-openjdk-headless
    或把 JRE 21 解压到 $APP_DIR/jre"
  fi
  info "  Node 用系统自带的：$("$NODE_BIN" --version 2>/dev/null || echo 未找到)"

  step "4. 安装 nginx 配置（新增 8080，不动你的 80）"
  [ -f /etc/nginx/conf.d/agent-stack.conf ] && cp /etc/nginx/conf.d/agent-stack.conf \
      "/etc/nginx/conf.d/agent-stack.conf.bak.$(date +%Y%m%d%H%M%S)"
  render "$SELF_DIR/files/nginx-agent-stack.conf" /tmp/agent-stack.nginx.conf || die "nginx 模板渲染失败"
  install -m 644 /tmp/agent-stack.nginx.conf /etc/nginx/conf.d/agent-stack.conf
  info "  nginx root=$APP_DIR/web  proxy /api → 127.0.0.1:$SERVER_PORT  listen $APP_PORT"
  if nginx -t 2>&1 | tail -3; then
    systemctl is-active --quiet nginx || systemctl start nginx
    systemctl reload nginx
    ok "  nginx 已加载新配置（:8080）"
  else
    die "nginx -t 校验失败，已保留备份；请检查 /etc/nginx/conf.d/agent-stack.conf"
  fi

  step "4b. 安装 80 端口子路径入口 /studio/（备用访问路径）"
  # 放进 default.d 会【被包含进 80 端口那个 server 块内部】，
  # 因为你的 nginx.conf 里本来就有 include /etc/nginx/default.d/*.conf;
  # 所以无需改动 nginx.conf 一个字。用独立前缀，不碰简历站的 /api/。
  if [ -d /etc/nginx/default.d ]; then
    render "$SELF_DIR/files/nginx-studio.conf" /tmp/agent-stack-studio.conf || die "studio 模板渲染失败"
    install -m 644 /tmp/agent-stack-studio.conf /etc/nginx/default.d/agent-stack-studio.conf
    ln -sfn web "$APP_DIR/studio"
    if nginx -t 2>&1 | tail -2; then
      systemctl reload nginx
      ok "  已启用 http://<ip>/studio/ （不影响原有的 / 简历站）"
    else
      rm -f /etc/nginx/default.d/agent-stack-studio.conf
      warn "  studio 配置校验失败，已回滚该文件（nginx 保持原状）"
    fi
  else
    warn "  没有 /etc/nginx/default.d 目录，跳过 80 端口子路径入口"
  fi

  step "5. 安装 systemd 单元"
  render "$SELF_DIR/files/systemd/agent-stack-server.service"  /tmp/agent-stack-server.service  || die "server 单元渲染失败"
  render "$SELF_DIR/files/systemd/agent-stack-runtime.service" /tmp/agent-stack-runtime.service || die "runtime 单元渲染失败"
  install -m 644 /tmp/agent-stack-server.service  /etc/systemd/system/agent-stack-server.service
  install -m 644 /tmp/agent-stack-runtime.service /etc/systemd/system/agent-stack-runtime.service
  info "  server  ExecStart=$APP_DIR/jre/bin/java ... WorkingDirectory=$APP_DIR/server"
  info "  runtime ExecStart=$NODE_BIN dist/main.js  WorkingDirectory=$APP_DIR/runtime"
  systemctl daemon-reload
  systemctl enable agent-stack-server agent-stack-runtime >/dev/null 2>&1
  ok "  单元已安装并 enable（开机自启，含重启频率限制）"

  step "6. 创建数据库 schema 与专用账号（幂等）"
  MYSQL_ADMIN=(mysql -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -u "$DB_ADMIN_USER")
  if [ -n "${DB_ADMIN_PASSWORD:-}" ]; then export MYSQL_PWD="$DB_ADMIN_PASSWORD"; fi
  "${MYSQL_ADMIN[@]}" <<SQL || die "建库失败，请检查 DB_ADMIN_USER / DB_ADMIN_PASSWORD"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
  unset MYSQL_PWD
  ok "  schema \`$DB_NAME\` 与账号 $DB_USER 就绪（表由 Flyway 在 server 启动时创建）"

  step "7. 写入各组件配置（权限 600）"
  write_envs

  # init 在第 2 步为了腾端口停掉了服务；若组件已就位就重新拉起，
  # 否则跑完 init 会出现"服务是停的、API 502"这种看起来像部署失败的假象。
  if [ -f "$APP_DIR/server/agent-stack-server.jar" ]; then
    systemctl reset-failed agent-stack-server 2>/dev/null || true
    systemctl start agent-stack-server 2>/dev/null || true
    info "  已重新启动 server"
  fi
  if [ -f "$APP_DIR/runtime/dist/main.js" ] && [ -d "$APP_DIR/runtime/node_modules" ]; then
    systemctl reset-failed agent-stack-runtime 2>/dev/null || true
    systemctl start agent-stack-runtime 2>/dev/null || true
    info "  已重新启动 runtime"
  fi
  ok "init 完成"
}

# 把配置写进各组件读的 env 文件（init 与 config 共用；权限 600）
write_envs() {
  cat > "$APP_DIR/shared/server.env" <<ENV
AGENT_STACK_DB_HOST=${DB_HOST:-127.0.0.1}
AGENT_STACK_DB_PORT=${DB_PORT:-3306}
AGENT_STACK_DB_NAME=$DB_NAME
AGENT_STACK_DB_USER=$DB_USER
AGENT_STACK_DB_PASSWORD=$DB_PASSWORD
AGENT_STACK_RUNTIME_URL=http://127.0.0.1:$RUNTIME_PORT
AGENT_STACK_SERVER_PORT=$SERVER_PORT
AGENT_STACK_CORS_ORIGINS=${CORS_ORIGINS:-}
ENV
  cat > "$APP_DIR/shared/runtime.env" <<ENV
RUNTIME_HOST=127.0.0.1
RUNTIME_PORT=$RUNTIME_PORT
MODEL_PROVIDER=${MODEL_PROVIDER:-deepseek}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
MODEL_NAME=${MODEL_NAME:-}
MODEL_BASE_URL=${MODEL_BASE_URL:-}
MODEL_TEMPERATURE=${MODEL_TEMPERATURE:-0.2}
TOOL_HTTP_ALLOWLIST=${TOOL_HTTP_ALLOWLIST:-example.com,httpbin.org}
ENV
  chmod 600 "$APP_DIR/shared/server.env" "$APP_DIR/shared/runtime.env"
  chown -R "$RUN_AS:$RUN_AS" "$APP_DIR"
  chmod 755 "$APP_DIR" "$APP_DIR"/{web,server,runtime,shared,incoming} 2>/dev/null || true
  ok "  配置已写入 $APP_DIR/shared/（权限 600）"
}

# ================================================================ web
do_web() {
  step "部署前端（nginx 静态托管）"
  local tar="$INCOMING/agent-stack-web.tar.gz"
  [ -f "$tar" ] || die "缺少 $tar"

  rm -rf "$APP_DIR/web.new"
  mkdir -p "$APP_DIR/web.new"
  tar -xzf "$tar" -C "$APP_DIR/web.new"
  [ -f "$APP_DIR/web.new/index.html" ] || die "前端包里没有 index.html"

  # 原子替换：先备份旧的，再换
  rm -rf "$APP_DIR/web.old"
  [ -d "$APP_DIR/web" ] && mv "$APP_DIR/web" "$APP_DIR/web.old"
  mv "$APP_DIR/web.new" "$APP_DIR/web"
  chown -R "$RUN_AS:$RUN_AS" "$APP_DIR/web"

  # 权限归一化：nginx 以 nginx 用户读静态文件，600/700 会直接 403
  find "$APP_DIR/web" -type d -exec chmod 755 {} +
  find "$APP_DIR/web" -type f -exec chmod 644 {} +
  chown -R "$RUN_AS:$RUN_AS" "$APP_DIR/web"

  # 80 端口子路径访问用的软链：studio -> web（相对路径）
  # 用相对软链的好处：上面的"原子替换"是 mv web web.old; mv web.new web，
  # 软链指向的是名称 web，所以替换完会自动跟着指向新目录，不需要额外维护。
  ln -sfn web "$APP_DIR/studio"

  nginx -t >/dev/null 2>&1 || die "nginx 配置校验失败"
  systemctl reload nginx
  ok "  前端已更新（$(find "$APP_DIR/web" -type f | wc -l) 个文件）并 reload nginx"

  # 就绪校验：光看"文件放好了"不够，必须确认 nginx 真的能读到（403 就是读不到）
  if http_ok "http://127.0.0.1:$APP_PORT/" '<div id="root">'; then
    ok "  经 nginx 验证可访问（http://127.0.0.1:$APP_PORT/ 返回页面）"
  else
    warn "  经 nginx 访问异常，错误日志："
    tail -5 /var/log/nginx/agent-stack.error.log 2>/dev/null || true
    die "前端部署后不可访问"
  fi
  rm -rf "$APP_DIR/web.old"
}

# ================================================================ server
do_server() {
  step "部署 Java 后端"
  local tar="$INCOMING/agent-stack-server.tar.gz"
  [ -f "$tar" ] || die "缺少 $tar"

  systemctl stop agent-stack-server 2>/dev/null || true
  # 关键：之前失败过会让单元进入 failed 并可能撞上 StartLimitBurst，
  # 此时 systemctl start 会被 systemd 直接拒绝（"Start request repeated too quickly"），
  # 表现成"启动了但没有任何新日志"。必须先 reset-failed。
  systemctl reset-failed agent-stack-server 2>/dev/null || true
  mkdir -p "$APP_DIR/server/logs"
  tar -xzf "$tar" -C "$APP_DIR/server"
  chmod +x "$APP_DIR/server/start.sh" "$APP_DIR/server/stop.sh" 2>/dev/null || true
  chown -R "$RUN_AS:$RUN_AS" "$APP_DIR/server"
  ok "  jar 与启停脚本已就位"

  if ! systemctl start agent-stack-server; then
    warn "  systemctl start 直接失败："
    systemctl status agent-stack-server --no-pager -l 2>&1 | head -15
    journalctl -u agent-stack-server -n 20 --no-pager || true
    die "server 启动被拒绝"
  fi
  if wait_http "http://127.0.0.1:$SERVER_PORT/actuator/health" '"status":"UP"' "server" 150; then
    ok "  后端已启动（127.0.0.1:$SERVER_PORT）"
  else
    warn "  后端未就绪，最后 40 行日志："
    journalctl -u agent-stack-server -n 40 --no-pager || true
    systemctl stop agent-stack-server 2>/dev/null || true
    die "server 部署失败（已停服务避免抖动）"
  fi
}

# ================================================================ runtime
do_runtime() {
  step "部署 Node runtime"
  local tar="$INCOMING/agent-stack-runtime.tar.gz"
  [ -f "$tar" ] || die "缺少 $tar"

  systemctl stop agent-stack-runtime 2>/dev/null || true
  systemctl reset-failed agent-stack-runtime 2>/dev/null || true
  mkdir -p "$APP_DIR/runtime/logs"
  # 注意：包里没有 node_modules（照 resume-agent 的 pack.sh 做法），解包不会覆盖已装的依赖
  tar -xzf "$tar" -C "$APP_DIR/runtime"
  chmod +x "$APP_DIR/runtime/start.sh" "$APP_DIR/runtime/stop.sh" 2>/dev/null || true
  chown -R "$RUN_AS:$RUN_AS" "$APP_DIR/runtime"

  step "  安装依赖（npm ci --omit=dev，约 150MB，需几分钟）"
  local npm_bin; npm_bin="$(dirname "$NODE_BIN")/npm"
  [ -x "$npm_bin" ] || npm_bin="$(command -v npm)"
  [ -n "$npm_bin" ] || die "找不到 npm"
  # 先 cd 再 sudo：sudo 会保留 cwd，比 --prefix 的行为更可预测
  ( cd "$APP_DIR/runtime" && \
    sudo -u "$RUN_AS" env HOME="$APP_DIR" \
        npm_config_cache="$APP_DIR/runtime/.npm-cache" \
        "$npm_bin" ci --omit=dev --no-audit --no-fund \
        --fetch-timeout=60000 --fetch-retries=2 \
        --registry="${NPM_REGISTRY:-https://registry.npmmirror.com}" ) \
    || die "npm ci 失败（可换官方源重试：NPM_REGISTRY=https://registry.npmjs.org）"
  chown -R "$RUN_AS:$RUN_AS" "$APP_DIR/runtime"
  ok "  依赖就绪（$(du -sh "$APP_DIR/runtime/node_modules" 2>/dev/null | cut -f1)）"

  systemctl start agent-stack-runtime || {
    warn "  systemctl start 直接失败："
    systemctl status agent-stack-runtime --no-pager -l 2>&1 | head -15
    die "runtime 启动被拒绝"
  }
  if wait_http "http://127.0.0.1:$RUNTIME_PORT/healthz" '"status":"ok"' "runtime" 90; then
    ok "  运行时已启动（127.0.0.1:$RUNTIME_PORT）"
  else
    warn "  运行时未就绪，最后 40 行日志："
    journalctl -u agent-stack-runtime -n 40 --no-pager || true
    die "runtime 部署失败"
  fi
}

# ================================================================ verify
do_verify() {
  step "端到端验收"
  echo "--- 服务状态 ---"
  systemctl is-active agent-stack-server agent-stack-runtime 2>&1 | sed 's/^/  /'
  echo "--- 监听端口 ---"
  (ss -ltnp 2>/dev/null || netstat -ltnp) | grep -E ":($APP_PORT|$SERVER_PORT|$RUNTIME_PORT)\b" | sed 's/^/  /'
  echo "--- 组件健康 ---"
  echo -n "  nginx    :$APP_PORT  → "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 8 "http://127.0.0.1:$APP_PORT/"
  echo -n "  server   :$SERVER_PORT → "; curl -s --max-time 8 "http://127.0.0.1:$SERVER_PORT/actuator/health"; echo
  echo -n "  runtime  :$RUNTIME_PORT → "; curl -s --max-time 8 "http://127.0.0.1:$RUNTIME_PORT/healthz"; echo
  echo "--- 经 nginx 反代（浏览器实际走的路径） ---"
  echo -n "  /                  → "; curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 8 "http://127.0.0.1:$APP_PORT/"
  echo -n "  /api/capabilities  → "; curl -s --max-time 10 "http://127.0.0.1:$APP_PORT/api/capabilities"; echo
  echo "--- 内存 ---"
  free -m | head -2 | sed 's/^/  /'
}

# ================================================================ config
# 只重写 shared/*.env 并重启组件：改了模型 key / 端口后用它，不必重跑整个 init
do_config() {
  step "应用配置（只重写 shared/*.env 并重启组件）"
  write_envs
  echo "--- server.env ---"; sed -E 's/(PASSWORD=).*/\1********/' "$APP_DIR/shared/server.env" | sed 's/^/  /'
  echo "--- runtime.env（key 已脱敏）---"
  sed -E 's/(API_KEY=)(.+)/\1********(长度 \2)/; s/(API_KEY=)$/\1(空，将降级为脚本化模型)/' "$APP_DIR/shared/runtime.env" | sed 's/^/  /'

  systemctl reset-failed agent-stack-runtime 2>/dev/null || true
  systemctl restart agent-stack-runtime
  wait_http "http://127.0.0.1:$RUNTIME_PORT/healthz" '"status":"ok"' "runtime" 60 || warn "  运行时未就绪"

  # 模型配置变了只需要重启 runtime；但若 DB/端口也变了则 server 也要重启，一并做掉更省心
  systemctl reset-failed agent-stack-server 2>/dev/null || true
  systemctl restart agent-stack-server
  wait_http "http://127.0.0.1:$SERVER_PORT/actuator/health" '"status":"UP"' "server" 180 || warn "  后端未就绪"

  do_verify
}

case "${1:-}" in
  init)    do_init ;;
  config)  do_config ;;
  web)     do_web ;;
  server)  do_server ;;
  runtime) do_runtime ;;
  verify)  do_verify ;;
  *)       die "用法: install.sh {init|web|server|runtime|config|verify}" ;;
esac
