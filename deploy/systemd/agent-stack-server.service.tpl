[Unit]
Description=Agent Stack 控制面与持久化（Spring Boot）
Documentation=file://__APP_DIR__/current
After=network-online.target
Wants=network-online.target

# 关键：内存不足时 JVM 会被 OOM Kill，如果只写 Restart=on-failure 而不限制频率，
# systemd 会每几秒重启一次、每次都重新申请堆内存 —— 结果是整台机器被抖死，
# 连 sshd 都发不出 banner（这个故障现场真实发生过）。
# 限制为 300 秒内最多失败 5 次，之后放弃并保持 failed 状态，等人工介入。
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_USER__
WorkingDirectory=__APP_DIR__/current

# 数据库密码等敏感项放在这个文件里（权限 600，属主 __RUN_USER__）
EnvironmentFile=__APP_DIR__/shared/server.env

# 堆大小由安装脚本按机器内存算好后注入（不用 MaxRAMPercentage：
# 它只看机器总内存，不知道这台机器上还跑着 MySQL，小规格 ECS 上会算得过大而被 OOM Kill）。
# ExitOnOutOfMemoryError 让内存不足时干脆退出并被 systemd 重启，而不是僵死。
ExecStart=__JAVA_BIN__ \
    __JAVA_OPTS__ \
    -XX:+ExitOnOutOfMemoryError \
    -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=__APP_DIR__/logs \
    -jar __APP_DIR__/current/agent-stack-server.jar

Restart=on-failure
RestartSec=15
# Java 收到 SIGTERM 的退出码；application.yml 里配了优雅停机
SuccessExitStatus=143
TimeoutStopSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
