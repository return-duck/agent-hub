# Agent Stack

> **画一张图 → 编译成 LangGraph → 看它真的跑起来。**
> 一个 agent 低代码搭建平台的 MVP：React Flow 画布 + Spring Boot/MySQL 持久化 + Node/LangChain 运行时，三者独立部署、由一条事件协议串起来。

这不是"接一个大模型 API 的聊天壳"。整个仓库围绕一个主张构建：

> **画布不是配置，是中间表示（IR）；模型只是可替换的零件；真正的产品主体是 Harness —— 包裹模型的那层运行时外壳。**

---

## 30 秒看懂它做了什么

```
┌──────────────┐   REST + SSE    ┌────────────────────┐   NDJSON 事件流   ┌─────────────────────┐
│  web/        │ ──────────────► │  server/           │ ───────────────► │  runtime/           │
│  React Flow  │ ◄────────────── │  Spring Boot       │ ◄─────────────── │  Node + LangChain   │
│  画布 + 调试台 │   逐条事件广播    │  控制面 + 持久化     │   逐条事件上报     │  编译器 + LangGraph  │
└──────────────┘                 └─────────┬──────────┘                   └──────────┬──────────┘
                                           │ JDBC                                    │
                                     ┌─────▼─────┐                          ┌────────▼────────┐
                                     │ MySQL 8.4 │                          │ 模型 (可替换)     │
                                     │  5 张表    │                          │ 工具 (白名单)     │
                                     └───────────┘                          └─────────────────┘
```

一条 run 的完整链路（**已实测跑通**）：

1. 在画布上拖出 `开始 → 提示词 → 大模型(绑定 calculator 工具) → 结束`，保存 → 图以 JSON 落进 MySQL；
2. 点「运行」→ server 建 `run` 行 → 把图和会话历史下发给 runtime；
3. runtime 把画布图**编译**成 LangGraph StateGraph（LLM 节点在编译期被展开成 `model → tools → model` 的 ReAct 循环）→ `streamEvents(v2)` 执行；
4. 每个 LangChain 回调被映射成协议事件（`node.started` / `llm.token` / `tool.finished` / …），以 NDJSON 流式回吐；
5. server 给每条事件分配单调 `seq` → **先落库再推送** → 通过 SSE 广播给浏览器；
6. 浏览器把事件流 `reduce` 成 UI 状态：逐字流式输出、画布节点逐个点亮、工具调用卡片展开。
7. 断线重连按 `Last-Event-ID` 续传，**不丢不重**。

---

## 已实测的证据（不是"应该能跑"）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 三层测试 | `scripts/test.sh` | **97 个用例全绿**（runtime 60 · server 24 · web 13） |
| 端到端验收 | `scripts/e2e.sh` | **38/38 项通过** |
| 真实 MySQL 落库 | `bash scripts/db.sh app-cli -e "select ... " agent_stack` | `run_event` 54 行、`seq` 1..54 无重复 |
| 真实工具调用 | e2e 断言 | `calculator` 算出 `(12+8)*3 = 60`，`isError=false` |
| 断点续传 | e2e 断言 | `?afterSeq=50` 恰好返回 seq 51–54 |
| 失败收敛 | e2e 断言 | 非法图 → `run.error(INVALID_GRAPH)` + `run.finished(FAILED)`，且错误带 `nodeId` |

e2e 覆盖的真实事件流（54 条）被录制在 [`contracts/fixtures/events.jsonl`](contracts/fixtures/events.jsonl)，
被 **runtime、web、server 三端各自的契约测试读同一份文件** —— 任何一端改字段，三端一起红。

---

## 三个目录 = 三个独立部署单元

| 目录 | 职责 | 构建产物 | 端口 |
|---|---|---|---|
| [`web/`](web/) | 画布与调试台（React 19 + React Flow 12 + Vite） | `web/dist` 静态资源 | 5173 (dev) |
| [`server/`](server/) | 控制面与持久化（Spring Boot 3.5 + JPA + Flyway） | `server/target/*.jar` | 8080 |
| [`runtime/`](runtime/) | agent 运行（Node 22 + LangChain v1 + LangGraph） | `runtime/dist`（node 进程） | 8090 |
| [`contracts/`](contracts/) | 契约真源（3 份 JSON Schema + 录制 fixture） | 仅构建期参与，不部署 | — |

**每个目录自带 `package.json` / `pom.xml`、`.env.example`、`Dockerfile`、`README`，可单独安装、构建、部署**，刻意**不用 pnpm workspace** —— 部署 `web/` 不该先装根目录。

安全边界：**API key 只存在于 `runtime/.env`**，server 只传模型名，浏览器只与 server 通信（单一 origin、单一 CORS 点）。

---

## 快速开始

前提：本机有 Node ≥ 20 与 `npm`。**JDK / Maven / MySQL 都不需要预先安装** —— 项目会自己拉一套到 `.toolchain/`（约 360MB，全部 gitignore，不需要 sudo，删目录即完全卸载）。

```bash
git clone <this-repo> && cd agent-stack

# 1) 一次性：下载 JDK 21 + Maven 3.9.11 + MySQL 8.4.7 到项目内
scripts/toolchain.sh

# 2) 装依赖（三个目录各自独立）
(cd runtime && npm install)
(cd web && npm install)
npm install                       # 仅用于契约代码生成

# 3) 一条命令起全栈（MySQL 3307 + runtime 8090 + server 8080 + web 5173）
scripts/dev.sh
```

打开 <http://127.0.0.1:5173>：左侧选中或新建 agent → 中间画布已有示例图 → 右侧「运行」面板填 `topic` 为 `(12+8)*3` → 点「运行」。

观察点：右侧**逐字**吐出回答；画布上**节点逐个点亮**；工具卡片展开可看到 `calculator` 的参数、耗时与结果；顶部状态条显示统计。

停止：`scripts/stop.sh`（MySQL 保留）或 `scripts/stop.sh --all`。

### 换成真实模型（零代码改动）

```bash
cp runtime/.env.example runtime/.env
# 编辑 runtime/.env：
#   MODEL_PROVIDER=openai
#   OPENAI_API_KEY=sk-xxxx
#   OPENAI_BASE_URL=https://api.deepseek.com/v1     # 任意 OpenAI 兼容端点
#   MODEL_NAME=deepseek-chat
```

没填 key 时不会报错，而是降级到内置的**确定性脚本化模型**（`mode=scripted`，前端顶部有横幅提示）。
这样"能不能跑起来"永远不取决于有没有 key —— 也让 CI 可以零凭证地验证整条链路。

---

## 常用命令

```bash
scripts/dev.sh            # 起全栈
scripts/stop.sh [--all]   # 停服务
scripts/test.sh           # 契约漂移检查 + 三层测试（97 个用例）
scripts/e2e.sh            # 端到端验收（38 项断言，会自己保证服务在线）
scripts/db.sh status      # 项目级 MySQL 状态
scripts/db.sh app-cli -e "select * from run_event limit 5" agent_stack
scripts/toolchain.sh      # 幂等地补齐/校验项目内工具链

cd runtime && npm run run-graph fixtures/graph-with-tools.json '{"topic":"(12+8)*3"}'
                          # 不依赖 Java 与前端，直接看一次 run 的事件流
cd runtime && npm run spike      # 重新验证 LangChain v1 API 的真实形态
```

---

## 这个项目想证明什么

### 1. 对 LangChain / LangGraph 的**可验证**掌握

仓库里所有 API 用法都先经过 [`runtime/scripts/spike.ts`](runtime/scripts/spike.ts) 对**实际装出来的版本**取证，而不是照记忆写。几个只有读源码/spike 才能发现的坑，都留了注释和回归测试：

| 事实 | 不处理的后果 |
|---|---|
| `BaseChatModel._streamIterator` **不会**自动发 token 回调 —— `_streamResponseChunks` 必须自己调 `runManager.handleLLMNewToken` | `streamEvents` 里根本没有 `on_chat_model_stream`，前端**完全没有逐字流式** |
| `_streamResponseChunks` 必须 yield `ChatGenerationChunk` **实例**（第二个 chunk 会调 `.concat()`） | `generationChunk.concat is not a function` |
| LangGraph 节点名**禁止包含 `:`** | 编译期直接抛错（所以内部节点用 `__` 连接） |
| prebuilt 的 `toolsCondition` **硬编码** `return "tools"` | 一张图里有多个 LLM 节点必然冲突 → 路由函数我们自己写 |
| 节点内部会再包一层 `RunnableLambda`，其 `metadata.langgraph_node` 与节点同名 | 用 metadata 判断会在工具调用**之前**就发 `node.finished`，前端节点闪烁（有回归测试） |

用到的 LangChain 能力：`StateGraph` / `Annotation.Root` / `messagesStateReducer`（自定义 reducer 语义）、`ToolNode`、条件边与**回边**构成的 ReAct 循环、`streamEvents(v2)` 全部回调语义、`bindTools` + `RunnableBinding` 的 `bind` 顺序陷阱、`ChatGenerationChunk` 累积、`GraphRecursionError` 熔断、自定义 `BaseChatModel` 子类、JSON Schema 描述工具入参。

### 2. 把 Harness 当一等公民

不是罗列概念，而是每一条都落在具体代码 + 测试 + UI 证据上：

| Harness 职责 | 落点 | 证据 |
|---|---|---|
| 执行循环 | `compiler/compile.ts` 装配 StateGraph | 编译器验证 11 条结构规则（18 个用例） |
| 工具调度 | `tools/` + `ToolNode` | 工具异常被包成 `ToolMessage` 回灌，循环不炸（有测试） |
| 上下文管理 | `trimToCharBudget` 按预算裁剪 | 超限必裁剪（确定性，可断言） |
| 权限 | `http_get` 域名白名单，**默认拒绝** | 防 SSRF；工具入参来自模型 = 不可信输入 |
| 可观测性 | `events/mapper.ts` 纯函数映射 | 15 个用例 + 真实事件流回放 + 三端契约测试 |
| 可恢复性 | 事件 append-only + `seq` + `Last-Event-ID` | 断线续传不丢不重（e2e 断言） |
| 错误收敛 | `RunOrchestrator` 的 finally 分支 | **无论成功/失败/超时/连不上 runtime，run 一定有终态** |
| 不变量守护 | 事件映射器保证 `node.started` 必有配对 `node.finished` | UI 不会出现"永久转圈" |
| 无状态运行时 | 会话历史由 MySQL 持有、每次 run 全量下发 | runtime 重启/多副本不丢会话，配得上"独立部署" |

### 3. 契约优先的工程化

- `contracts/*.schema.json` 是唯一真源 → 生成 TS 类型到 `runtime/` 与 `web/`（产物提交进 git，`scripts/test.sh` 做逐字节漂移检查）；
- **Java 侧刻意不为 10 个事件生成类型**：server 只对"信封"（`seq`/`type`/`nodeId`/`payload:JsonNode`）建模，payload 原样转发 → 契约漂移面从 10 个事件缩到 1 个信封，再用 fixture 契约测试把枚举钉住；
- 录制真实事件流做三方契约测试，"文档说的"和"代码做的"被同一份数据约束。

---

## 目录结构

```
agent-stack/
├── contracts/                       # 契约真源（唯一）
│   ├── agent-graph.schema.json      #   画布图 = React Flow 形状（零转换层）
│   ├── events.schema.json           #   10 个协议事件的判别式联合
│   ├── node-manifest.json           #   节点能力清单（驱动 runtime 执行器 + web 表单）
│   └── fixtures/events.jsonl        #   真实录制的 54 条事件（三方契约测试共用）
├── runtime/                         # agent 运行（独立部署）
│   ├── src/compiler/                #   validate / template / state / compile / nodes
│   ├── src/events/mapper.ts         #   LangChain 回调 → 协议事件（纯函数）
│   ├── src/models/                  #   模型工厂 + 确定性脚本化模型
│   ├── src/tools/                   #   calculator（手写求值器，无 eval）/ http_get（白名单）
│   ├── src/generated/               #   契约产物（自动生成，勿手改）
│   ├── scripts/spike.ts             #   LangChain API 取证实录
│   └── test/                        #   60 个用例
├── server/                          # 控制面与持久化（独立部署）
│   └── src/main/java/local/agentstack/
│       ├── domain/                  #   5 个实体 + Timestamps（DATETIME(3) 截断）
│       ├── service/                 #   AgentService / RunService / GraphValidator
│       ├── run/                     #   RuntimeClient / RunOrchestrator / SSE 广播
│       └── api/                     #   REST + SSE + 统一错误体
├── web/                             # 画布与调试台（独立部署）
│   └── src/
│       ├── store/runReducer.ts      #   运行状态 = 事件流的 fold（纯函数）
│       ├── components/              #   画布 / manifest 驱动表单 / 运行面板
│       └── generated/               #   契约产物（自动生成，勿手改）
├── scripts/                         # toolchain / db / dev / stop / test / e2e
├── docs/                            # DESIGN / PLAN / PROTOCOL
└── .toolchain/                      # JDK + Maven + MySQL + 日志（gitignore）
```

---

## 测试策略

| 层 | 位置 | 覆盖重点 |
|---|---|---|
| 单元 | `runtime/test`（Vitest，60） | 图校验 11 条规则、模板渲染、事件映射（**含回归**）、计算器安全性、完整 run 的事件不变量 |
| 单元 | `web/test`（Vitest，13） | `runReducer` 全部迁移 + **回放真实录制事件流** |
| 单元 | `server/src/test`（JUnit，10） | SSE 通道订阅/回放/判重、`Last-Event-ID` 解析、事件契约 |
| 集成 | `server/src/test`（JUnit，14） | **真实 MySQL** 上的 Flyway / 存取往返 / 编排 / 终态收敛（用桩 runtime 精确构造失败场景） |
| 验收 | `scripts/e2e.py`（38 断言） | 新建→保存→修改→运行→事件→落库→续传→失败路径 |

刻意**没有**用 Testcontainers：本机没有 Docker，项目自带真实 MySQL 实例反而更贴近部署形态，也让"用 MySQL 存储"这条要求在验收时可被字面验证。

---

## 明确不做的（以及为什么）

| 不做 | 原因 |
|---|---|
| HITL 人工审批 / `interrupt()` + `Command(resume)` | 需要**持久化 checkpointer**（多 2 张表 + 审批 UI + resume 端点）。编译器的 `checkpointer` 参数已作为接口预留 |
| 条件分支 / 循环 / 子图节点（`condition`/`map`/`agent`/`approval`） | MVP 只支持线性链。校验规则会明确拒绝分叉与环，而不是静默出错 |
| agent 版本管理与回滚 | 表结构和图 schema 版本号（`schemaVersion`）已就位，迁移器属下一阶段 |
| 动态 OpenAPI/MCP 工具、DB 凭证加密、RBAC、向量检索 | 与"保存并运行一个 agent"这条主链路正交 |
| 多租户、协作编辑、插件市场 | 同上 |

---

## 部署

每个目录都有 `Dockerfile`，根目录有 `docker-compose.yml` 把四件事（MySQL + runtime + server + web）串起来：

```bash
docker compose up --build          # 起 MySQL + runtime + server + web
```

> ⚠️ **诚实声明**：本项目的开发与验证环境**没有 Docker**，因此这三个 Dockerfile 与 compose 文件
> **只经过人工审查，未经实际构建验证**。已验证的是它们在非容器形态下对应的启动方式（`scripts/dev.sh`）。
> 首次在服务器上使用 compose 时，请预留调试时间。

生产形态建议：`web/dist` 交给静态服务器（nginx/CDN）并把 `/api` 反代到 server；server 与 runtime 仅在内网互通；MySQL 使用托管实例并把 `AGENT_STACK_DB_*` 指过去。

---

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) —— 架构设计与决策记录（含与设计稿的差异说明）
- [docs/PLAN.md](docs/PLAN.md) —— 实施计划、工期估算与实际完成情况
- [docs/PROTOCOL.md](docs/PROTOCOL.md) —— 事件协议参考（10 个事件 + SSE 续传语义）
