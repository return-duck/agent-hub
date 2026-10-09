# 三包分离部署（前端 / Java / Node 各自独立）

参照你服务器上 `resume-*` 的部署习惯重新设计的部署方式：
**三个组件各自打包、各自上传、各自启动**，前端交给 nginx 托管并反代 `/api` 到 Java。

## 与旧方式的区别

| | 旧（单端口 jar） | 新（三包分离） |
|---|---|---|
| 前端 | 打进 jar 的 `BOOT-INF/classes/static/` | 独立目录，nginx 直接托管 |
| Java | 同一份 jar 同时提供 UI 和 API | 独立 jar，只监听 `127.0.0.1` |
| Node | 独立 | 独立 |
| 更新前端 | 必须重新打 jar、重传 51MB | 只传 600KB 的前端包 |
| 对外入口 | jar 自己监听 8080 | nginx 监听 8080，收口并反代 |

## 拓扑

```
浏览器 :8080 ──► nginx ──┬── /            → /opt/agent-stack/web      （前端静态）
                         └── /api/        → 127.0.0.1:18080          （Java）
                        Java ──► 127.0.0.1:8090                     （Node runtime）
```

nginx 监听 **8080**：该端口已被安全组放行（公网 TCP 可达已实测），因此不需要改安全组。
你原有的 80 端口 resume 站点不受影响（只新增了一个 `server` 块）。

## 服务器目录

```
/opt/agent-stack/                 ← APP_DIR，可用 deploy.env 的 APP_DIR 改
├── web/                          ← 前端静态产物（nginx root，独立）
├── server/                       ← Java 组件（独立）
│   ├── agent-stack-server.jar
│   ├── start.sh  stop.sh         ← 手工启停（systemd 存在时自动走 systemctl）
│   └── logs/
├── runtime/                      ← Node 组件（独立）
│   ├── dist/  node_modules/
│   ├── start.sh  stop.sh
│   └── logs/
├── jre/                          ← Java 21（从上一版迁移复用，未重新下载）
└── shared/
    ├── server.env                ← DB 与端口（600）
    └── runtime.env               ← 模型配置（600）
```

nginx 配置在 `/etc/nginx/conf.d/agent-stack.conf`（你的 `nginx.conf` 已 include 该目录），
systemd 单元为 `agent-stack-server.service` / `agent-stack-runtime.service`。

## 用法

```bash
bash deploy/split/deploy.sh init      # 一次性：建目录/迁移 JRE/装 nginx+systemd/建库
bash deploy/split/deploy.sh web       # 只更新前端（构建 → 上传 → 原子替换 → reload nginx）
bash deploy/split/deploy.sh server    # 只更新 Java（打包 → 上传 → 重启）
bash deploy/split/deploy.sh runtime   # 只更新 Node（打包 → 上传 → npm ci → 重启）
bash deploy/split/deploy.sh all       # 三个都更新
bash deploy/split/deploy.sh verify    # 端到端验收
```

配置复用 `deploy/deploy.env`，另可用这些键覆盖默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `APP_DIR` | `/opt/agent-stack` | 部署根目录；改成 `/home/admin/agent-stack` 即与 resume 同风格 |
| `APP_PORT` | `8080` | nginx 对外端口 |
| `SERVER_PORT` | `18080` | Java 内部端口 |
| `RUNTIME_PORT` | `8090` | Node 内部端口 |
| `NODE_BIN` | `/usr/bin/node` | 复用系统 Node（v22.23.0） |
| `RUN_AS` | `agentstack` | 服务账号（非 root、无登录） |
| `JRE_SOURCE` | `/opt/agent-stack/.toolchain/jre` | 首次 init 时迁入 `$APP_DIR/jre` |

> **注意**：服务器自带的是 Java **11**（Dragonwell），Spring Boot 3.5 需要 17+，
> 所以 Java 必须用 `$APP_DIR/jre`（21）。Node 可以直接用系统的。

## 三个组件的独立性（已实测）

| 操作 | 前端 | Java API | 结果 |
|---|---|---|---|
| 停 Node runtime | 200 | `/api/capabilities` 里 `runtimeUp:false` | 页面照常打开 |
| 停 Java | 200 | 502 | 页面照常打开，只有 API 不可用 |

两个 unit 都写了 `StartLimitIntervalSec=300` / `StartLimitBurst=5`：
内存不足被 OOM Kill 时最多重启 5 次就停手，**不会**像早先那版那样每 5 秒重启一次把整机拖死。

## 踩过的两个坑（已在代码里修掉）

1. **模板里写死路径**：`APP_DIR` 可配置，但 nginx/systemd 模板写死了 `/home/admin/agent-stack`，
   配置一旦不同就会出现"单元指向不存在的目录"。现在模板用 `__APP_DIR__` 等占位符，
   由 `install.sh` 的 `render()` 渲染，并校验没有残留占位符。
2. **`systemctl start` 被 StartLimit 拒绝**：单元之前失败过会进入 failed，
   300 秒窗口内 systemd 直接拒绝启动，表现为"启动了但没有任何新日志"。
   现在启动前先 `systemctl reset-failed`，并检查 `start` 的返回值。
