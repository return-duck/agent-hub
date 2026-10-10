# 事件协议参考

> 一条协议同时解决四件事：**流式渲染、断线续传、执行回放、跨语言契约**。
> 它是本项目的架构骨架 —— 契约真源是 [`contracts/events.schema.json`](../contracts/events.schema.json)。

---

## 1. 信封

```jsonc
{
  "seq": 12,                     // 由 server 作为唯一写入者分配，run 内从 1 单调递增
  "type": "tool.finished",       // 判别式联合的判别字段
  "runId": "f41475da-…",         // server 分配的 run id（不是 runtime 回显的那个）
  "nodeId": "n3",                // 画布节点 id；非节点级事件为 null
  "ts": "2026-10-08T10:37:56.123Z",
  "payload": { }                 // 形状由 type 决定
}
```

**三条不变量**（都有测试覆盖）：

1. `seq` 只由 server 分配，单调递增，且**与落库顺序一致**；
2. server **先落库再 publish** —— 客户端看到的任何事件，一定已经在 `run_event` 里；
3. 无论成功、失败、超时还是 runtime 连不上，run **一定**产出 `run.finished` 终态事件。

`runtime` 侧产出的事件**不带 `seq`**（契约测试会断言这一点）：让单调性只有一个来源。

---

## 2. 事件目录（11 个）

| `type` | 触发时机 | `payload` 关键字段 |
|---|---|---|
| `run.started` | runtime 收到请求后立刻发出 | `model{provider,name,mode}`、`graphSchemaVersion`、`input` |
| `node.started` | 画布节点开始执行 | `nodeType`、`label` |
| `node.finished` | 画布节点执行结束 | `nodeType`、`durationMs`、`status: ok\|error` |
| `node.log` | 节点过程中的一步（输入、执行、输出） | `nodeType`、`level`、`message`、`input`、`output` |
| `llm.token` | 模型每吐一个分片 | `delta` |
| `llm.completed` | 一次模型调用结束 | `model`、`inputTokens`、`outputTokens`、`messageCount`、`finishReason`、`durationMs` |
| `tool.started` | 工具开始执行 | `toolName`、`callId`、`args` |
| `tool.finished` | 工具执行结束 | `toolName`、`callId`、`durationMs`、`result`、`isError`、`truncated` |
| `message.completed` | 一条消息定稿 | `role`、`content`、`toolCalls[]`（工具调用轮会有） |
| `run.error` | 运行失败 | `code`、`message`、`retryable` |
| `run.finished` | 运行终结（**总是最后一个**） | `status: SUCCEEDED\|FAILED`、`durationMs`、`answer`、`totals{…}` |

### `run.error.code` 取值

`INVALID_GRAPH` · `INVALID_INPUT` · `MODEL_ERROR` · `TOOL_ERROR` · `STEP_LIMIT` · `RUNTIME_UNAVAILABLE` · `TIMEOUT` · `INTERNAL`

`INVALID_GRAPH` 的 `message` 里会带逐节点问题（`CODE@nodeId: 说明`），前端据此把错误标到对应节点上。
保存期（server 浅层校验）走的是另一条路径：HTTP 400 + `details[] = {code, nodeId, message}`。

---

## 3. LangChain 回调 → 协议事件

映射器（[`runtime/src/events/mapper.ts`](../runtime/src/events/mapper.ts)）是**纯函数**，因此可以用录制的事件做回放断言。

| LangChain `streamEvents(v2)` | 协议事件 | 实现要点 |
|---|---|---|
| `on_chain_start`（节点） | `node.started` | **只认 run 自己的 `name`**，不看 `metadata.langgraph_node`（内部 `RunnableLambda` 的 metadata 与节点同名，会误判） |
| `on_chain_end`（节点） | `node.finished` | 带工具的 LLM 节点：只有 model 这一轮**没有** `tool_calls` 时才算做完 |
| `on_chat_model_stream` | `llm.token` | `data.chunk` 是 `AIMessageChunk`；`content` 可能是 `ContentBlock[]`，需归一化 |
| `on_chat_model_end` | `llm.completed` + `message.completed` | 流式模型下 `data.output` 直接是消息；`usage_metadata` 缺失时降级为估算并在 `model` 字段标注 |
| `on_tool_start` | `tool.started` | `callId` 取 run_id |
| `on_tool_end` / `on_tool_error` | `tool.finished` | `data.output` 是 `ToolMessage`；错误也要发出终态，不能吞 |
| `on_chain_stream` / 根图事件 / `__start__` / `__end__` | — | 刻意忽略 |

### 为什么必须自己调 `handleLLMNewToken`

`BaseChatModel._streamIterator` 只负责 `handleChatModelStart` 与 `handleLLMEnd`，
**不会**自己发出 token 回调。所以自定义模型的 `_streamResponseChunks` 必须显式调用
`runManager.handleLLMNewToken(piece)` —— 否则 `streamEvents` 里根本没有 `on_chat_model_stream`，
前端也就完全没有逐字流式。这一条是 spike 阶段读源码确认的，见 [`runtime/scripts/spike.ts`](../runtime/scripts/spike.ts)。

---

## 4. 传输

```
POST /api/agents/{agentId}/runs           → 202 {runId, conversationId}
GET  /api/runs/{runId}/events[?afterSeq=] → text/event-stream
POST /api/runs/{runId}/…                  → （Phase 2：取消 / 审批 / 恢复）
```

### 内部一跳：runtime → server 用 NDJSON

`POST /execute` 返回 `application/x-ndjson`（一行一个事件），而不是 SSE：

- 消费方是 Java 而不是浏览器，SSE 的分帧与心跳在这里是纯负担；
- Java 侧 `HttpClient.send(req, BodyHandlers.ofLines())` 直接拿到 `Stream<String>`，配上虚拟线程就是最简实现。

### 外部一跳：server → 浏览器用 SSE

- 事件 `id:` 就是 `seq` → 浏览器 `EventSource` 断线重连会**自动**带上 `Last-Event-ID`；
- server 端 `afterSeq` 优先取查询参数，其次取 `Last-Event-ID`（`RunController.resolveAfterSeq`）；
- **回放与订阅的竞态**用一把锁解决：`RunEventChannel.subscribe()` 在同一个 `synchronized` 块里
  完成"回放 `seq > afterSeq` 的历史事件"和"注册订阅者"，所以不会丢也不会重；
- 客户端**必须**在收到 `run.finished` 后主动 `close()`，否则 `EventSource` 会自动重连成死循环。

### 断线续传的实测行为

```bash
curl -N 'http://127.0.0.1:8080/api/runs/<id>/events?afterSeq=50'
# => 恰好 seq 51、52、53、54
```

---

## 5. 三端如何共用这份契约

| 端 | 消费方式 |
|---|---|
| `runtime` | `contracts/events.schema.json` → 生成 `src/generated/events.ts`（产出方类型） |
| `web` | 同一份 schema → 生成自己的 `src/generated/events.ts`（消费方类型 + reducer 输入） |
| `server` | **不为事件生成类型**：只对信封建模（`ProtocolEvent` record），`payload` 保持 `JsonNode` 原样转发 |

Java 侧不做 codegen 是刻意的取舍：server 只是"信使 + 记账"，不解读事件语义，
于是契约漂移面从 10 个事件缩到 1 个信封。代价是 `EventType` 枚举需要人工同步 ——
用 [`ContractTest`](../server/src/test/java/local/agentstack/protocol/ContractTest.java)
读同一份 fixture 来钉死，新增事件时 Java 侧会立刻变红。

三端契约测试读的是**同一个文件**：[`contracts/fixtures/events.jsonl`](../contracts/fixtures/events.jsonl)
（由真实 run 录制，54 条事件）。
