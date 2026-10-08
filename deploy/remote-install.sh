#!/usr/bin/env bash
# ============================================================================
# Agent Stack 服务器端安装脚本（由 deploy.sh 上传后在服务器上执行，不要手工改）
#
# 它会做这些事，且可以重复执行（幂等）：
#   1. 探测架构 / 内存 / MySQL 版本
#   2. 若无 JRE、Node，按架构下载官方包到 $APP_DIR/.toolchain（不依赖包管理器）
#   3. 安装 runtime 依赖（npm ci --omit=dev，走国内镜像）
#   4. 建立 releases/<时间戳> 并把 current 软链指过去（原子切换 + 可回滚）
#   5. 创建 MySQL schema 与专用账号（只授权这一个库）
#   6. 写入 systemd 单元并启动/重启两个服务
#   7. 健康检查
# ============================================================================
set -euo pipefail

INCOMING="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$INCOMING/deploy/remote.env"

info() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE（应由 deploy.sh 上传）"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# --------------------------------------------------------------- 提权
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then
    info "以 root 重新执行（sudo）..."
    exec sudo -E bash "$0" "$@"
  fi
  die "需要 root 权限来安装 systemd 服务与建库。请用 root 登录，或为 $USER 配置免密 sudo：
    echo \"$USER ALL=(ALL) NOPASSWD:ALL\" | sudo tee /etc/sudoers.d/agent-stack"
fi

# --------------------------------------------------------------- 前置工具
DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then DOWNLOADER="wget"
else die "服务器上既没有 curl 也没有 wget，请先安装其中之一"; fi

# 下载并显示进度。
#
# 关键：必须有「卡死检测」和「整体超时」。之前的版本只设了 connect-timeout，
# 结果在连得上但对端不传数据时会无限期挂住 —— 在 ECS 上表现为"脚本卡在这里不动"，
# 既没有报错也没有进展（api.adoptium.net 从国内拉就是这个症状）。
#   --speed-limit 10K --speed-time 30  连续 30 秒低于 10KB/s 就放弃
#   --max-time 900                     整体上限，防止慢速拖死
download() { # download <url> <outfile>
  local url="$1" out="$2"
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fL --retry 2 --retry-delay 2 --connect-timeout 15 \
      --speed-limit 10240 --speed-time 30 --max-time 900 \
      --progress-bar -o "$out" "$url"
  else
    wget --tries=2 --timeout=15 --show-progress -O "$out" "$url"
  fi
}

# 找一个已经装好的 Java（>= JDK_MAJOR）。
# 有系统 Java 就完全不用下载 —— 在有包管理器镜像的国内机器上这是最稳的路径。
find_system_java() {
  local candidates=() bin major
  command -v java >/dev/null 2>&1 && candidates+=("$(command -v java)")
  for bin in /usr/lib/jvm/*/bin/java /usr/lib/jvm/*/jre/bin/java /opt/java/*/bin/java; do
    [ -x "$bin" ] && candidates+=("$bin")
  done
  for bin in "${candidates[@]}"; do
    major="$("$bin" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
    if [ -n "$major" ] && [ "$major" -ge "$JDK_MAJOR" ] 2>/dev/null; then
      printf '%s' "$bin"
      return 0
    fi
  done
  return 1
}

# 从 Adoptium 风格的镜像目录列表里找最新的 JRE 包
try_jre_mirror() { # try_jre_mirror <镜像根地址>
  local base="$1" dir file
  dir="$base/$JDK_MAJOR/jre/$ARCH_ADOPTIUM/linux/"
  file="$(curl -fsSL --max-time 30 "$dir" 2>/dev/null \
    | grep -oE "OpenJDK${JDK_MAJOR}U-jre_${ARCH_ADOPTIUM}_linux_hotspot_[0-9._]+\.tar\.gz" \
    | sort -V | tail -1)"
  [ -n "$file" ] || return 1
  info "    用镜像: $dir$file"
  download "$dir$file" "$TMP/jre.tar.gz"
}

# --------------------------------------------------------------- 1. 环境探测
info "1/8 探测环境 ..."
case "$(uname -m)" in
  x86_64 | amd64) ARCH_ADOPTIUM=x64;     ARCH_NODE=x64 ;;
  aarch64 | arm64) ARCH_ADOPTIUM=aarch64; ARCH_NODE=arm64 ;;
  *) die "不支持的 CPU 架构: $(uname -m)" ;;
esac
MEM_MB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 ))
info "    架构=$(uname -m)  内存=${MEM_MB}MB  系统=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown)"
# JVM 堆按内存取 1/3 并夹在 256MB..2GB，取整到 128 的倍数。
# 之所以不是 MaxRAMPercentage：它按机器总内存算，不知道这台机器上还有 MySQL 与 Node，
# 1674MB 这种规格上会算出 ~1GB 堆，很容易被 OOM Killer 干掉。
JVM_HEAP_MB=$(( MEM_MB / 3 ))
[ "$JVM_HEAP_MB" -lt 256 ] && JVM_HEAP_MB=256
[ "$JVM_HEAP_MB" -gt 2048 ] && JVM_HEAP_MB=2048
JVM_HEAP_MB=$(( (JVM_HEAP_MB / 128) * 128 ))
JAVA_OPTS="-Xms${JVM_HEAP_MB}m -Xmx${JVM_HEAP_MB}m -XX:MaxMetaspaceSize=192m -Duser.timezone=UTC"
info "    JVM 堆: ${JVM_HEAP_MB}MB（按内存 ${MEM_MB}MB 的 1/3 计算，给 MySQL 与 Node 留余量）"

if [ "$MEM_MB" -lt 1800 ]; then
  warn "内存只有 ${MEM_MB}MB：Spring Boot + Node + MySQL 挤在一起会比较紧张。"
  warn "如果服务反复重启，先看： journalctl -u agent-stack-server -n 100 | grep -i -E 'kill|memory'"
  warn "实在不够就把 MySQL 换成阿里云 RDS（DB_HOST 指过去即可），或升配到 2GB。"
fi

command -v mysql >/dev/null 2>&1 || die "找不到 mysql 客户端。请先安装：
    Alibaba Cloud Linux / CentOS:  sudo dnf install -y mysql
    Ubuntu / Debian:               sudo apt install -y mysql-client"

# --------------------------------------------------------------- 2. Java / Node
info "2/8 准备 JRE $JDK_MAJOR 与 Node $NODE_VERSION ..."
mkdir -p "$APP_DIR/.toolchain" "$APP_DIR/shared" "$APP_DIR/logs" "$APP_DIR/releases"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Java：优先复用，其次国内镜像，最后官方源 ---
JRE_DIR="$APP_DIR/.toolchain/jre"
JAVA_BIN=""
if [ -x "$JRE_DIR/bin/java" ]; then
  JAVA_BIN="$JRE_DIR/bin/java"
  ok "    复用已下载的 JRE：$("$JAVA_BIN" -version 2>&1 | head -1)"
elif JAVA_BIN="$(find_system_java)"; then
  ok "    复用系统已安装的 Java（无需下载）：$JAVA_BIN"
  info "    $("$JAVA_BIN" -version 2>&1 | head -1)"
else
  info "    未找到可用的 Java，开始下载 JRE $JDK_MAJOR（$ARCH_ADOPTIUM）..."
  jre_ok=0
  for mirror in "${JDK_MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/Adoptium}" "https://mirrors.ustc.edu.cn/adoptium" ; do
    if try_jre_mirror "$mirror"; then jre_ok=1; break; fi
    warn "    镜像不可用: $mirror"
  done
  if [ "$jre_ok" -ne 1 ]; then
    warn "    镜像都不可用，尝试官方源（国内可能很慢/超时）..."
    if download "https://api.adoptium.net/v3/binary/latest/${JDK_MAJOR}/ga/linux/${ARCH_ADOPTIUM}/jre/hotspot/normal/eclipse" "$TMP/jre.tar.gz"; then
      jre_ok=1
    fi
  fi
  [ "$jre_ok" -eq 1 ] || die "JRE 下载失败。两个办法：
    1) 用系统包管理器装（最快）：  dnf install -y java-${JDK_MAJOR}-openjdk-headless
       然后重新执行本脚本，它会自动复用系统 Java；
    2) 手工下载 JRE 压缩包，解压后把 bin/java 所在目录放到 $JRE_DIR（使 $JRE_DIR/bin/java 存在）"

  mkdir -p "$TMP/jre" && tar -xzf "$TMP/jre.tar.gz" -C "$TMP/jre"
  inner="$(find "$TMP/jre" -maxdepth 1 -mindepth 1 -type d -name '*jdk*' | head -1)"
  [ -n "$inner" ] || die "JRE 压缩包结构异常"
  rm -rf "$JRE_DIR" && mv "$inner" "$JRE_DIR"
  JAVA_BIN="$JRE_DIR/bin/java"
  ok "    JRE 就绪：$("$JAVA_BIN" -version 2>&1 | head -1)"
fi
[ -x "$JAVA_BIN" ] || die "Java 可执行文件不可用: $JAVA_BIN"

# --- Node ---
NODE_DIR="$APP_DIR/.toolchain/node"
if [ -x "$NODE_DIR/bin/node" ]; then
  ok "    复用已下载的 Node：$("$NODE_DIR/bin/node" -v)"
else
  # 用 .tar.gz 而不是 .tar.xz：精简系统上常常没有 xz
  NODE_TARBALL="node-${NODE_VERSION}-linux-${ARCH_NODE}.tar.gz"
  info "    下载 Node $NODE_VERSION（$ARCH_NODE）..."
  downloaded=0
  for base in "$NODE_MIRROR" "https://nodejs.org/dist"; do
    info "      源: $base"
    if download "$base/$NODE_VERSION/$NODE_TARBALL" "$TMP/node.tar.gz"; then downloaded=1; break; fi
    warn "      该源不可用，换下一个"
  done
  [ "$downloaded" -eq 1 ] || die "Node 下载失败（可手工下载解压到 $NODE_DIR）"
  mkdir -p "$TMP/node" && tar -xzf "$TMP/node.tar.gz" -C "$TMP/node"
  inner="$(find "$TMP/node" -maxdepth 1 -mindepth 1 -type d -name 'node-*' | head -1)"
  [ -n "$inner" ] || die "Node 压缩包结构异常"
  rm -rf "$NODE_DIR" && mv "$inner" "$NODE_DIR"
  ok "    Node 就绪：$("$NODE_DIR/bin/node" -v)  npm $("$NODE_DIR/bin/npm" -v)"
fi
NODE_BIN="$NODE_DIR/bin/node"

# --------------------------------------------------------------- 3. MySQL 检查
info "3/8 检查 MySQL ..."
mysql_admin() {
  if [ -n "${DB_ADMIN_PASSWORD:-}" ]; then
    MYSQL_PWD="$DB_ADMIN_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_ADMIN_USER" "$@"
  else
    mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_ADMIN_USER" "$@"
  fi
}
SERVER_VERSION="$(mysql_admin -N -B -e 'select version()' 2>/dev/null | head -1)" \
  || die "无法用 $DB_ADMIN_USER 连接 MySQL（$DB_HOST:$DB_PORT）。请检查 DB_ADMIN_USER / DB_ADMIN_PASSWORD"
info "    MySQL 版本：$SERVER_VERSION"
case "$SERVER_VERSION" in
  *MariaDB* | *mariadb*)
    die "检测到 MariaDB。schema 迁移使用了 MySQL 8 专有的 utf8mb4_0900_ai_ci 排序规则。
    请改用 MySQL 8.x；若必须用 MariaDB，告诉开发者，我把迁移脚本改成兼容写法。" ;;
esac
SERVER_MAJOR="${SERVER_VERSION%%.*}"
[ "$SERVER_MAJOR" -ge 8 ] 2>/dev/null || die "需要 MySQL 8.x，当前是 $SERVER_VERSION"

# --------------------------------------------------------------- 4. 安装 runtime 依赖
info "4/8 安装 runtime 依赖（npm ci --omit=dev，约 150MB，可能需要几分钟）..."
(
  cd "$INCOMING/runtime"
  # 先清理本地构建可能带上的 devDependencies
  rm -rf node_modules
  # 刻意【不】把输出丢到 /dev/null：npm 装 150MB 依赖要几分钟，
  # 静默会让人以为脚本卡死（下载 JRE 那次就是这么被误判的）。
  # 同时设 fetch-timeout，避免镜像不响应时无限期挂住。
  "$NODE_DIR/bin/npm" ci --omit=dev --no-audit --no-fund \
    --fetch-timeout=60000 --fetch-retries=2 \
    --registry="$NPM_REGISTRY" \
    || die "npm ci 失败。可改用官方源重试： NPM_REGISTRY=https://registry.npmjs.org"
)
ok "    runtime 依赖就绪（$(du -sh "$INCOMING/runtime/node_modules" | cut -f1)）"

# --------------------------------------------------------------- 5. 切换 release
info "5/8 发布新版本 ..."
STAMP="$(date +%Y%m%d-%H%M%S)"
REL="$APP_DIR/releases/$STAMP"
mkdir -p "$REL/runtime"
cp "$INCOMING/agent-stack-server.jar" "$REL/agent-stack-server.jar"
cp -R "$INCOMING/runtime/dist" "$REL/runtime/dist"
cp "$INCOMING/runtime/package.json" "$INCOMING/runtime/package-lock.json" "$REL/runtime/"
cp -R "$INCOMING/runtime/node_modules" "$REL/runtime/node_modules"

rm -f "$APP_DIR/current"
ln -s "$REL" "$APP_DIR/current"
ok "    当前版本 -> $REL"

# 只保留最近 5 个版本，避免磁盘被日志/旧包撑满
KEEP=5
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  info "    清理旧版本 $(basename "$old")"
  rm -rf "$old"
done

# --------------------------------------------------------------- 6. 建库建号
info "6/8 创建 schema 与专用账号（幂等）..."
mysql_admin <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'%' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'%';
FLUSH PRIVILEGES;
SQL
ok "    schema \`$DB_NAME\` 与账号 $DB_USER 就绪（表结构由 server 启动时 Flyway 自动创建）"

# --------------------------------------------------------------- 7. 服务账号与配置
info "7/8 写入运行账号、配置与 systemd 单元 ..."
RUN_USER=agentstack
if ! getent group "$RUN_USER" >/dev/null 2>&1; then
  groupadd -r "$RUN_USER" || die "创建用户组 $RUN_USER 失败"
fi
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  useradd -r -g "$RUN_USER" -s /sbin/nologin -d "$APP_DIR" "$RUN_USER" 2>/dev/null \
    || useradd -r -g "$RUN_USER" -s /usr/sbin/nologin -d "$APP_DIR" "$RUN_USER" \
    || die "创建系统用户 $RUN_USER 失败"
  ok "    已创建系统用户 $RUN_USER（无登录权限，服务以它运行而不是 root）"
fi

# 配置里只有服务器需要的项；模型 key 与数据库密码都在这里，权限 600
cat > "$APP_DIR/shared/server.env" <<ENV
AGENT_STACK_DB_HOST=$DB_HOST
AGENT_STACK_DB_PORT=$DB_PORT
AGENT_STACK_DB_NAME=$DB_NAME
AGENT_STACK_DB_USER=$DB_USER
AGENT_STACK_DB_PASSWORD=$DB_PASSWORD
AGENT_STACK_RUNTIME_URL=http://127.0.0.1:$RUNTIME_PORT
AGENT_STACK_SERVER_PORT=$APP_PORT
ENV

cat > "$APP_DIR/shared/runtime.env" <<ENV
RUNTIME_HOST=127.0.0.1
RUNTIME_PORT=$RUNTIME_PORT
MODEL_PROVIDER=${MODEL_PROVIDER:-deepseek}
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
MODEL_NAME=${MODEL_NAME:-}
MODEL_BASE_URL=${MODEL_BASE_URL:-}
MODEL_EXTRA_PARAMS=${MODEL_EXTRA_PARAMS:-}
MODEL_TEMPERATURE=${MODEL_TEMPERATURE:-0.2}
TOOL_HTTP_ALLOWLIST=${TOOL_HTTP_ALLOWLIST:-example.com,httpbin.org}
ENV

chmod 600 "$APP_DIR/shared/server.env" "$APP_DIR/shared/runtime.env"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
chmod 755 "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/.toolchain"

render_unit() { # render_unit <模板> <目标>
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__APP_PORT__|$APP_PORT|g" \
      -e "s|__RUNTIME_PORT__|$RUNTIME_PORT|g" \
      -e "s|__RUN_USER__|$RUN_USER|g" \
      -e "s|__JAVA_BIN__|$JAVA_BIN|g" \
      -e "s|__JAVA_OPTS__|$JAVA_OPTS|g" \
      "$1" > "$2"
  chmod 644 "$2"
}

render_unit "$INCOMING/deploy/systemd/agent-stack-server.service.tpl"  /etc/systemd/system/agent-stack-server.service
render_unit "$INCOMING/deploy/systemd/agent-stack-runtime.service.tpl" /etc/systemd/system/agent-stack-runtime.service
systemctl daemon-reload
systemctl enable agent-stack-runtime agent-stack-server >/dev/null 2>&1
ok "    systemd 单元已安装"

# --------------------------------------------------------------- 8. 启动 + 健康检查
info "8/8 启动服务 ..."
systemctl restart agent-stack-runtime
systemctl restart agent-stack-server

check_http() { # check_http <url> <期望子串> <名称> <最多等秒>
  local url="$1" expect="$2" name="$3" limit="${4:-90}" i
  for ((i = 1; i <= limit; i++)); do
    if "$NODE_BIN" -e "fetch('$url').then(r=>r.text()).then(t=>process.exit(t.includes('$expect')?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      ok "    $name 就绪（${i}s）"
      return 0
    fi
    if ! systemctl is-active --quiet "agent-stack-${name}"; then
      warn "    $name 进程已退出，最后 30 行日志："
      journalctl -u "agent-stack-${name}" -n 30 --no-pager || true
      return 1
    fi
    sleep 1
  done
  warn "    $name 在 ${limit}s 内没就绪，最后 30 行日志："
  journalctl -u "agent-stack-${name}" -n 30 --no-pager || true
  return 1
}

FAILED=0
check_http "http://127.0.0.1:$RUNTIME_PORT/healthz" '"status":"ok"' runtime 90 || FAILED=1
check_http "http://127.0.0.1:$APP_PORT/actuator/health" '"status":"UP"' server 150 || FAILED=1

# 防火墙提示（安全组是另一层，改系统防火墙不影响安全组）
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  if ! firewall-cmd --list-ports 2>/dev/null | grep -q "$APP_PORT/tcp"; then
    warn "firewalld 正在运行且没有放行 $APP_PORT，执行下面这行放行："
    warn "    sudo firewall-cmd --permanent --add-port=$APP_PORT/tcp && sudo firewall-cmd --reload"
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  ok "安装完成，两个服务都在运行"
  echo "  应用目录   $APP_DIR"
  echo "  当前版本   $(basename "$(readlink -f "$APP_DIR/current")")"
  echo "  访问地址   http://<公网IP>:$APP_PORT"
  echo "  模型       ${MODEL_NAME:-默认} (provider=$MODEL_PROVIDER)"
  echo "  Java       $JAVA_BIN"
  echo "  Node       $NODE_BIN"
  echo
  echo "  提醒：阿里云【安全组】需要放行 TCP $APP_PORT（它独立于系统防火墙）。"
else
  die "服务没有全部就绪，请看上面的日志。常见原因：
    1. 内存不足（<2GB）导致 JVM 被杀：journalctl -u agent-stack-server | grep -i kill
    2. 数据库连接失败：检查 shared/server.env 里的账号密码
    3. 端口被占用：ss -ltnp | grep -E '$APP_PORT|$RUNTIME_PORT'"
fi
