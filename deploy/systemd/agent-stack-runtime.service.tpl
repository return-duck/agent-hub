[Unit]
Description=Agent Stack runtime（Node + LangChain 执行器）
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
WorkingDirectory=__APP_DIR__/current/runtime

# 模型 API key 在这个文件里（权限 600，属主 __RUN_USER__）
EnvironmentFile=__APP_DIR__/shared/runtime.env
Environment=NODE_ENV=production

# 入口是 dist/main.js：它无条件启动服务，不做任何"是否被直接执行"的判断。
# 曾经用 import.meta.url 判断过，但部署走 current/ 软链时 Node 会解析成 realpath，
# 结果是进程活着却不监听 —— 这个坑有专门的注释与实测记录。
ExecStart=__APP_DIR__/.toolchain/node/bin/node dist/main.js

Restart=on-failure
RestartSec=15
TimeoutStopSec=15
LimitNOFILE=65535

# runtime 只监听 127.0.0.1（由 runtime.env 里的 RUNTIME_HOST 决定），不对外暴露
[Install]
WantedBy=multi-user.target
