[Unit]
Description=Agent Stack 控制面与持久化（Spring Boot）
Documentation=file://__APP_DIR__/current
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__APP_DIR__/current

# 数据库密码等敏感项放在这个文件里（权限 600，属主 __RUN_USER__）
EnvironmentFile=__APP_DIR__/shared/server.env

# MaxRAMPercentage 会让 JVM 按机器内存自适应，比写死 -Xmx 更适合不同规格的 ECS；
# ExitOnOutOfMemoryError 让小内存机器 OOM 时干脆退出并被 systemd 重启，而不是僵死。
ExecStart=__APP_DIR__/.toolchain/jre/bin/java \
    -XX:MaxRAMPercentage=60 \
    -XX:+ExitOnOutOfMemoryError \
    -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=__APP_DIR__/logs \
    -jar __APP_DIR__/current/agent-stack-server.jar

Restart=on-failure
RestartSec=5
# Java 收到 SIGTERM 的退出码；application.yml 里配了优雅停机
SuccessExitStatus=143
TimeoutStopSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
