#!/usr/bin/env bash
# ============================================================================
# Agent Stack 服务器端抢救脚本（在服务器上以 root 运行，可重复执行/幂等）
#
# 背景：部署后 Spring Boot 因内存不足起不来，systemd 反复重启把 1674MB 的机器
#       拖到连 sshd 都发不出 banner。本脚本按"先松绑、再诊断、后重启"的顺序处理。
#
# 每一步都会写进 /opt/agent-stack/fix.log，因此即使中途断连也能看到进展。
# 不删除任何用户数据，不需要重新下载 JRE/Node。
# ============================================================================
set -u
exec > >(tee -a /opt/agent-stack/fix.log) 2>&1

APP_DIR=/opt/agent-stack
RUN_USER=agentstack
# 这台机器可用内存只有 1674MB，且与 MySQL 同机 → 堆压到 256MB
HEAP_MB=256
# 对外端口用 8080：它已被安全组放行（从公网 TCP 可达已实测），
# 而 8081 无法在应用未启动时验证是否放行。用 8080 可以不改安全组就对外可用。
APP_PORT=8080
RUNTIME_PORT=8090

# ---- 运行时二进制解析：不能写死 .toolchain 路径 ----
# 安装脚本会"优先复用系统已装的 Java"，所以服务器上可能根本没有 .toolchain/jre。
# 这里按 已下载的 → 系统已装的 顺序解析，Node 同理。
find_java() {
  local c=() bin major
  [ -x "$APP_DIR/.toolchain/jre/bin/java" ] && { echo "$APP_DIR/.toolchain/jre/bin/java"; return 0; }
  command -v java >/dev/null 2>&1 && c+=("$(command -v java)")
  for bin in /usr/lib/jvm/*/bin/java /usr/lib/jvm/*/jre/bin/java /opt/java/*/bin/java; do
    [ -x "$bin" ] && c+=("$bin")
  done
  for bin in "${c[@]}"; do
    major="$("$bin" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/' || true)"
    [ -n "$major" ] && [ "$major" -ge 21 ] 2>/dev/null && { echo "$bin"; return 0; }
  done
  return 1
}
find_node() {
  if [ -x "$APP_DIR/.toolchain/node/bin/node" ]; then echo "$APP_DIR/.toolchain/node/bin/node"; return 0; fi
  command -v node >/dev/null 2>&1 && { command -v node; return 0; }
  return 1
}

# HTTP 就绪检查：优先 curl（几乎都有），退回 node fetch（需要 Node >=18）
http_ok() { # http_ok <url> <期望子串>
  local url="$1" expect="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time 8 "$url" 2>/dev/null | grep -q "$expect" && return 0
    return 1
  fi
  [ -n "${NODE_BIN:-}" ] || return 1
  "$NODE_BIN" -e "fetch('$url').then(r=>r.text()).then(t=>process.exit(t.includes('$expect')?0:1)).catch(()=>process.exit(1))" 2>/dev/null
}

step() { echo; echo "############ $* ############"; }
mem()  { free -m | awk '/^Mem:/{printf "  total=%sMB used=%sMB free=%sMB available=%sMB\n",$2,$3,$4,$7}'; }

step "0. 起始状态 $(date '+%F %T')"
uptime
mem
echo "--- 我的服务状态 ---"
systemctl is-active agent-stack-server agent-stack-runtime 2>&1 | tr '\n' ' '; echo
echo "--- 正在监听 ---"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -20

step "0b. 解析运行时二进制与校验产物"
JAVA_BIN="$(find_java)" && echo "  JAVA_BIN = $JAVA_BIN" || { echo "  ❌ 找不到 >=21 的 Java"; JAVA_BIN=""; }
NODE_BIN="$(find_node)" && echo "  NODE_BIN = $NODE_BIN" || { echo "  ❌ 找不到 node"; NODE_BIN=""; }
[ -n "$JAVA_BIN" ] && "$JAVA_BIN" -version 2>&1 | head -1 | sed 's/^/    /'
[ -n "$NODE_BIN" ] && echo "    node $("$NODE_BIN" -v)"
echo "--- 产物是否就位 ---"
ls -l "$APP_DIR/current/agent-stack-server.jar" 2>/dev/null | sed 's/^/  /' || echo "  ❌ 缺少 jar"
ls -l "$APP_DIR/current/runtime/dist/main.js" 2>/dev/null | sed 's/^/  /' || echo "  ❌ 缺少 runtime dist/main.js"
ls -l "$APP_DIR/current/runtime/node_modules" -d 2>/dev/null | sed 's/^/  /' || echo "  ❌ 缺少 node_modules"
ls -l "$APP_DIR/current" 2>/dev/null | sed 's/^/  /'

step "1. 原始失败原因（改动之前的日志，用于定位根因）"
echo "--- agent-stack-server 最后 60 行 ---"
journalctl -u agent-stack-server -n 60 --no-pager 2>/dev/null | tail -60
echo "--- 是否出现 OOM / 端口占用 / 数据库错误 ---"
journalctl -u agent-stack-server -n 400 --no-pager 2>/dev/null | grep -iE "out of memory|oom|killed|address already in use|port .* was already|communications link failure|access denied|unknown database|FlywayException" | tail -12 || echo "  （无匹配）"
echo "--- 8081/8080 此刻的占用 ---"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":(8081|8080)\b" | sed 's/^/  /' || echo "  （无人监听）"

step "1b. 停掉并禁止自启我的服务（松绑内存，防止无限重启）"
systemctl disable --now agent-stack-server 2>&1 | tail -2
systemctl disable --now agent-stack-runtime 2>&1 | tail -2
sleep 3
systemctl is-active agent-stack-server agent-stack-runtime 2>&1 | tr '\n' ' '; echo
mem

step "2. 谁在吃内存 / 谁占着端口"
echo "--- RSS 前 12 ---"
ps -eo pid,rss,etime,comm --sort=-rss 2>/dev/null | head -13
echo "--- 运行中的服务（前 30）---"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -30
echo "--- 8080 占用者 ---"
P8080="$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':8080\b' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 )"
if [ -n "${P8080:-}" ]; then
  echo "  pid=$P8080  cmd=$(tr '\0' ' ' < /proc/$P8080/cmdline 2>/dev/null | cut -c1-120)"
  UNIT8080="$(grep -oE '[A-Za-z0-9_.@-]+\.service' /proc/$P8080/cgroup 2>/dev/null | head -1)"
  echo "  所属 systemd 单元: ${UNIT8080:-未识别（可能是手工启动的进程）}"
else
  echo "  8080 当前无人监听"
  UNIT8080=""
fi

if [ -z "$JAVA_BIN" ] || [ -z "$NODE_BIN" ]; then
  echo "❌ 缺少运行时（Java/Node），无法继续。请先安装： dnf install -y java-21-openjdk-headless"
  echo "   然后重新运行本脚本。"
  exit 1
fi

step "3. 释放内存：停掉 8080 上的既有应用（用户已授权；只停服务不删文件，可随时恢复）"
if [ -n "${UNIT8080:-}" ] && [ "$UNIT8080" != "agent-stack-server.service" ]; then
  echo "  停止并禁止自启: $UNIT8080"
  systemctl disable --now "$UNIT8080" 2>&1 | tail -2
  sleep 2
  echo "$UNIT8080" > "$APP_DIR/stopped-for-memory.txt"
  echo "  （已记录到 $APP_DIR/stopped-for-memory.txt，恢复方式：systemctl enable --now $UNIT8080）"
elif [ -n "${P8080:-}" ]; then
  echo "  8080 由非 systemd 进程占用，仅停止该进程 pid=$P8080（不删文件）"
  kill "$P8080" 2>/dev/null && sleep 2 && kill -9 "$P8080" 2>/dev/null
fi
mem

step "4. 安装保守配置的 systemd 单元（堆 ${HEAP_MB}MB / 端口 $APP_PORT / 限制重启次数）"
# 堆大小、启动频率限制都在这里定死，避免再出现"OOM → 5 秒重启 → 整机卡死"的循环
cat > /etc/systemd/system/agent-stack-runtime.service <<UNIT
[Unit]
Description=Agent Stack runtime (Node + LangChain)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR/current/runtime
EnvironmentFile=$APP_DIR/shared/runtime.env
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} dist/main.js
Restart=on-failure
RestartSec=15
TimeoutStopSec=15
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/agent-stack-server.service <<UNIT
[Unit]
Description=Agent Stack 控制面与持久化 (Spring Boot)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR/current
EnvironmentFile=$APP_DIR/shared/server.env
ExecStart=${JAVA_BIN} \\
    -Xms${HEAP_MB}m -Xmx${HEAP_MB}m -XX:MaxMetaspaceSize=128m -Xss512k \\
    -XX:+UseSerialGC -XX:+ExitOnOutOfMemoryError \\
    -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=$APP_DIR/logs \\
    -Duser.timezone=UTC \\
    -jar $APP_DIR/current/agent-stack-server.jar
Restart=on-failure
RestartSec=15
SuccessExitStatus=143
TimeoutStopSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

echo "  端口改为 $APP_PORT（安全组已放行的端口）"
sed -i "s/^AGENT_STACK_SERVER_PORT=.*/AGENT_STACK_SERVER_PORT=$APP_PORT/" "$APP_DIR/shared/server.env"
grep -E '^(AGENT_STACK_SERVER_PORT|AGENT_STACK_RUNTIME_URL)=' "$APP_DIR/shared/server.env" | sed 's/^/  /'

systemctl daemon-reload
systemctl enable agent-stack-runtime agent-stack-server >/dev/null 2>&1
echo "  单元已安装并 enable"

step "5. 启动服务（先 runtime 后 server）"
systemctl start agent-stack-runtime
for i in $(seq 1 60); do
  if http_ok "http://127.0.0.1:$RUNTIME_PORT/healthz" '"status":"ok"'; then
    echo "  runtime 就绪（${i}s）"; break
  fi
  sleep 1
done
mem

systemctl start agent-stack-server
OK=0
for i in $(seq 1 150); do
  if http_ok "http://127.0.0.1:$APP_PORT/actuator/health" '"status":"UP"'; then
    echo "  server 就绪（${i}s）"; OK=1; break
  fi
  if ! systemctl is-active --quiet agent-stack-server; then
    echo "  ❌ server 进程已退出，最后 40 行日志："
    journalctl -u agent-stack-server -n 40 --no-pager
    break
  fi
  sleep 1
done

step "6. 结果"
if [ "$OK" -eq 1 ]; then
  echo "  ✅ 本机健康检查通过"
  echo "--- 前端是否可访问（同一端口同时提供 UI 与 API）---"
  echo -n "  GET /                → "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "http://127.0.0.1:$APP_PORT/" 2>/dev/null || echo "失败"
  echo -n "  GET /api/capabilities → "; curl -s --max-time 10 "http://127.0.0.1:$APP_PORT/api/capabilities" 2>/dev/null; echo
  echo "--- 监听端口 ---"
  (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":(8080|8090)\b" | sed 's/^/  /'
else
  echo "  ❌ server 未就绪"
  systemctl status agent-stack-server --no-pager -l 2>/dev/null | head -20
  journalctl -u agent-stack-server -n 60 --no-pager
fi

mem
echo
echo "############ 抢救结束 $(date '+%F %T') ############"
