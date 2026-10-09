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

## 踩过的八个坑（已在代码里修掉）

1. **模板里写死路径**：`APP_DIR` 可配置，但 nginx/systemd 模板写死了 `/home/admin/agent-stack`，
   配置一旦不同就会出现"单元指向不存在的目录"。现在模板用 `__APP_DIR__` 等占位符，
   由 `install.sh` 的 `render()` 渲染，并校验没有残留占位符。
2. **`systemctl start` 被 StartLimit 拒绝**：单元之前失败过会进入 failed，
   300 秒窗口内 systemd 直接拒绝启动，表现为"启动了但没有任何新日志"。
   现在启动前先 `systemctl reset-failed`，并检查 `start` 的返回值。

3. **`umask` 作用域泄漏导致前端 403**：`upload_installer()` 为写含密码的配置设了 `umask 077`，
   但它泄漏到了后续的打包流程 —— `cp` 把前端文件建成 `600`，tar 把 `600` 打进包，
   服务器解包后 nginx（以 `nginx` 用户运行）读不了，页面直接 **403 Permission denied**。
   第一次没暴露是因为 `init` 分支恰好"先打包再设 umask"，而 `all` 分支相反。
   现在：① `umask` 用子 shell 限定作用域；② 打包后 `chmod -R a+rX` 归一化；
   ③ 服务器解包后再次归一化（目录 755 / 文件 644）；④ `do_web` 增加就绪校验 ——
   只检查"文件放好了"不够，必须确认 nginx 真能读到（403 就是读不到）。

4. **反代时 `Host` 不带端口，导致所有浏览器 POST 被 403 "Invalid CORS request"**
   现象：页面能打开、agent 列表能加载，但一"新建 agent"就报
   `POST /api/agents → 403 Forbidden`。
   原因：nginx 原本写 `proxy_set_header Host $host;`，而 **`$host` 不包含端口**。
   于是后端把自己的地址算成 `116.62.47.207:18080`，与浏览器送来的
   `Origin: http://116.62.47.207:8080` 不同源 → Spring 判定为跨域请求 →
   启用 CORS 校验 → 白名单里只有开发用的 `localhost:5173` → 直接 403。
   （这也解释了为什么 `Origin: http://116.62.47.207` 不带端口时反而能通过。）
   修法：① 两处代理都改用 **`$http_host`**（保留端口，同源判定成立，CORS 根本不启用）；
   ② 仍然把真实访问地址写进 `AGENT_STACK_CORS_ORIGINS` 作为第二道保险
   （`WebConfig` 用的是 `allowedOrigins` 精确匹配且开了 `allowCredentials`，
   所以必须逐个列出，不能用 `*`）。

5. **相对基址 + 深路径 = 白屏**
   公开对话页的 URL 是 `/a/<slug>` 这种「文件形状」的路径。若 vite 用 `base: './'`，
   产物里是 `./assets/x.js`，浏览器会解析成 `/a/assets/x.js`（404），JS 根本没加载 → 白屏。
   改为绝对基址 `base: '/'`；80 端口的 `/studio/` 挂载点由 nginx 额外把 `/assets/`
   也指向同一份文件（该路径已确认没被简历站占用）。

6. **`try_files` 的回退是一次内部重定向，会重新做 location 匹配**
   80 端口上写 `try_files $uri $uri/ /index.html` 时，回退目标已经离开本 location，
   落到 server 块的根（= 简历站目录），于是公开对话页渲染成了**简历站首页**。
   回退目标必须落在自己可控的 location 里（这里用 `/studio/index.html`）。

7. **80 端口的短链不能用根路径 `/api`**
   短链 `/a/<slug>` 推导出的 API 基址是 `/api`，而根路径 `/api` 是**简历站后端**的
   命名空间（它的 `js/p_login.js` 等依赖），不能占用。所以 80 端口的 `/a/<slug>`
   直接 302 到 `/studio/a/<slug>`，在那个挂载点下推导出的是 `/studio/api`，一切自洽。

## 用户体系与发布（本次迭代）

- 注册/登录/登出/me 在 `/api/auth/**`；口令用 PBKDF2WithHmacSHA256，令牌只存 SHA-256
- `/api/**` 默认要求登录，只有注册登录、`/api/public/**`、`/api/capabilities` 例外
- agent 按 owner 隔离，非本人一律 404（不是 403），避免被用来枚举
- 发布后公开页：`<公网IP>:8080/a/<slug>`、`<公网IP>/studio/a/<slug>`（80 端口），
  以及 `<公网IP>/a/<slug>`（80 端口会 302 到 /studio/a/）
- 访客用浏览器本地生成的 visitorId 隔离会话；同一个 agent 的会话列表在
  `GET /api/agents/{id}/conversations` 里可见，并区分访客会话与本机会话

8. **React Flow 的视图性变更污染了 `dirty`**
   `onNodesChange` 对所有变更都置 `dirty: true`，而 React Flow 在节点挂载/测量时会发
   `dimensions`、`select` 这类**视图性**变更。后果是：刚选中一个 agent 就显示"保存 *"，
   并且依赖 `dirty` 判断"是否已保存"的组件（会话列表、调用轨迹）永远停在空状态。
   现在只对 `position` / `add` / `remove` / `replace` 这类真正改内容的变更置 dirty。
   （这个 bug 是 CDP 驱动真实浏览器验收时发现的 —— 单测和接口测试都覆盖不到。）

## 中断 / 断点重试 / 调用轨迹（本次迭代）

- **中断**：`POST /api/runs/{id}/cancel`（主人）与公开页对应接口。实现是关掉
  Java→Node 的 NDJSON 事件流，Node 侧的 `req/res 'close'` 会 abort 掉正在跑的 LangGraph，
  不需要另立取消协议。中断收敛为 `CANCELLED`，**不发 run.error**（中断不是错误），
  并保留已产出的部分回答。
- **编辑并重发**：`POST /api/conversations/{id}/rewind {keepSeq}` 删掉 seq > keepSeq 的
  消息及其所属 run（`run_event` 与 `trace_span` 级联删除）。
- **断点重试**：`POST /api/runs/{id}/retry` 先回退这一轮再用同样输入重跑，并在 run 上
  记录 `retry_of_run_id` 血缘。粒度是**一轮**而非一个节点 —— runtime 刻意保持无状态
  （历史每次从 MySQL 全量下发），所以"断点"就是上一次完整轮次的边界。
- **调用轨迹（持久化）**：新表 `trace_span`，kind = `node | model | tool | mcp | skill`，
  含 span_seq / 起止时间 / 耗时 / 输入 / 输出 / 属性 / 错误。
  查询入口：`GET /api/runs/{id}/traces`、`/api/conversations/{id}/traces`、
  `/api/agents/{id}/runs`；公开页也能查自己那一轮。
  工作室右侧有可折叠的「调用轨迹」面板（运行列表 + span 时间线 + 输入输出展开）。

> **MCP 与技能**：项目里目前没有 MCP / 技能节点的生产者（见 DESIGN 的"未实施"清单），
> 但轨迹把它们作为一等类别准备好了 —— 协议里有 `kind`、表和界面都按类别展示，
> 将来接入 `@langchain/mcp-adapters` 或技能包时只需在工具注册表里登记名字。
