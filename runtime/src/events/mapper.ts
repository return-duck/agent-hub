/**
 * LangChain streamEvents(v2) → 协议事件 的映射器。
 *
 * 设计要点：这是一个【纯函数类】—— 输入是 LangChain 的事件对象，输出是协议事件数组，
 * 不依赖网络、不依赖模型。因此可以用录制好的事件 fixture 做回放断言
 * （见 test/mapper.test.ts），这是整套可观测性唯一可被单测钉死的部分。
 *
 * 已在本机读源码 / spike 确认的事实，不要凭直觉改：
 *  - toolsCondition 硬编码 return "tools"，所以路由函数是我们自己写的（见 compile.ts）。
 *  - 执行中的节点名在 metadata.langgraph_node 里；__start__ / __end__ 是伪节点，要忽略。
 *  - on_chat_model_stream 的 data.chunk 是 AIMessageChunk；没有它就没有 token 级流式。
 *  - on_chat_model_end 在流式模型下的 data.output 直接就是 AIMessageChunk（不是 LLMResult）。
 *  - on_tool_end 的 data.output 是 ToolMessage（content / tool_call_id / status）。
 */
import {
  contentToText,
  estimateTokens,
} from '../util/messageText.js';
import { events, type OutboundEvent } from '../protocol/events.js';
import type { CanvasNodeInfo } from '../compiler/compile.js';
import { TRUNCATION_MARKER } from '../tools/httpGet.js';

interface RawEvent {
  event?: string;
  name?: string;
  run_id?: string;
  metadata?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
}

interface OpenNode {
  info: CanvasNodeInfo;
  compiledName: string;
  startedAt: number;
}

interface OpenTool {
  toolName: string;
  callId: string;
  canvasNodeId: string;
  startedAt: number;
}

export interface MapperOptions {
  runId: string;
  nodeIndex: Map<string, CanvasNodeInfo>;
  modelName: string;
  toolResultMaxChars: number;
}

export class EventMapper {
  private readonly runId: string;
  private readonly nodeIndex: Map<string, CanvasNodeInfo>;
  private readonly modelName: string;
  private readonly toolResultMaxChars: number;

  /** 画布节点 id -> 已开启但尚未收尾的节点 */
  private readonly openCanvasNodes = new Map<string, OpenNode>();
  private readonly openTools = new Map<string, OpenTool>();
  private lastCanvasNodeId: string | null = null;

  readonly totals = { inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0, steps: 0 };

  constructor(options: MapperOptions) {
    this.runId = options.runId;
    this.nodeIndex = options.nodeIndex;
    this.modelName = options.modelName;
    this.toolResultMaxChars = options.toolResultMaxChars;
  }

  map(raw: RawEvent): OutboundEvent[] {
    switch (raw.event) {
      case 'on_chain_start':
        return this.onChainStart(raw);
      case 'on_chain_end':
        return this.onChainEnd(raw);
      case 'on_chat_model_stream':
        return this.onChatModelStream(raw);
      case 'on_chat_model_end':
        return this.onChatModelEnd(raw);
      case 'on_tool_start':
        return this.onToolStart(raw);
      case 'on_tool_end':
        return this.onToolEnd(raw, false);
      case 'on_tool_error':
        return this.onToolEnd(raw, true);
      default:
        // on_chain_stream / on_custom_event / 根图事件都不需要暴露给前端
        return [];
    }
  }

  /**
   * 运行收尾前调用：为所有仍未关闭的画布节点补一条 node.finished。
   * 不变量「每个 node.started 都有配对的 node.finished」是 UI 不会出现"永久转圈"的前提。
   */
  finishOpenNodes(status: 'ok' | 'error'): OutboundEvent[] {
    const out: OutboundEvent[] = [];
    const now = Date.now();
    for (const [canvasNodeId, open] of this.openCanvasNodes) {
      out.push(
        events.nodeFinished(this.runId, canvasNodeId, open.info.nodeType, now - open.startedAt, status),
      );
    }
    this.openCanvasNodes.clear();
    return out;
  }

  /**
   * 只有 run 自己的 name 命中编译期节点名，才算"这个画布节点在跑"。
   *
   * 不能只看 metadata.langgraph_node：LangGraph 会在节点内部再包一层 RunnableLambda，
   * 它的 langgraph_node 同样是 n3__model，但 name 是 "RunnableLambda"。
   * 用 metadata 判断会在工具调用前就提前发 node.finished（前端表现为节点闪烁）。
   */
  private chainInfo(raw: RawEvent): { info: CanvasNodeInfo; compiledName: string } | null {
    const name = typeof raw.name === 'string' ? raw.name : null;
    if (!name) return null;
    const info = this.nodeIndex.get(name);
    return info ? { info, compiledName: name } : null;
  }

  /** 模型/工具类事件没有节点名，只能靠 metadata.langgraph_node 归属到画布节点 */
  private currentNodeId(raw: RawEvent): string | null {
    const fromMetadata = raw.metadata?.['langgraph_node'];
    if (typeof fromMetadata === 'string') {
      const info = this.nodeIndex.get(fromMetadata);
      if (info) return info.canvasNodeId;
    }
    return this.lastCanvasNodeId;
  }

  private onChainStart(raw: RawEvent): OutboundEvent[] {
    const found = this.chainInfo(raw);
    if (!found) return [];
    const { info, compiledName } = found;
    this.lastCanvasNodeId = info.canvasNodeId;
    this.totals.steps += 1;

    // 同一个画布节点（LLM 节点的 model/tools 两个内部节点）只宣告一次 started，
    // 否则前端会看到节点反复闪烁。
    if (this.openCanvasNodes.has(info.canvasNodeId)) {
      return [];
    }
    const open: OpenNode = { info, compiledName, startedAt: Date.now() };
    this.openCanvasNodes.set(info.canvasNodeId, open);
    return [events.nodeStarted(this.runId, info.canvasNodeId, info.nodeType, info.label)];
  }

  private onChainEnd(raw: RawEvent): OutboundEvent[] {
    const found = this.chainInfo(raw);
    if (!found) return [];
    const { info, compiledName } = found;
    const open = this.openCanvasNodes.get(info.canvasNodeId);
    if (!open) return [];

    // LLM 节点带工具时被展开成 model/tools 两个内部节点：
    // 只有当 model 这一轮【没有】再产生 tool_calls 时，画布上的这个 LLM 节点才算做完。
    if (info.nodeType === 'llm' && compiledName.endsWith('__tools')) {
      return [];
    }
    if (info.nodeType === 'llm' && toolCallsOf(raw) > 0) {
      return [];
    }

    this.openCanvasNodes.delete(info.canvasNodeId);
    return [
      events.nodeFinished(
        this.runId,
        info.canvasNodeId,
        info.nodeType,
        Date.now() - open.startedAt,
        'ok',
      ),
    ];
  }

  private onChatModelStream(raw: RawEvent): OutboundEvent[] {
    const nodeId = this.currentNodeId(raw);
    if (!nodeId) return [];
    const chunk = (raw.data?.['chunk'] ?? null) as { content?: unknown } | null;
    const delta = contentToText(chunk as never);
    if (!delta) return [];
    return [events.llmToken(this.runId, nodeId, delta)];
  }

  private onChatModelEnd(raw: RawEvent): OutboundEvent[] {
    const nodeId = this.currentNodeId(raw);
    const output = raw.data?.['output'];
    const message = extractMessage(output);
    const usage = extractUsage(output, message);
    const content = contentToText(message as never);
    const toolCalls = extractToolCalls(message);
    const durationMs = usage.durationMs;

    const out: OutboundEvent[] = [];

    if (nodeId) {
      const inputTokens = usage.inputTokens ?? estimateTokens(JSON.stringify(raw.data?.['input'] ?? {}));
      const outputTokens = usage.outputTokens ?? estimateTokens(content);
      // 模型没返回 usage 时降级为估算，并用一个**显式字段**告诉前端，
      // 而不是把这件事编码进 model 显示名里（那样前端只能靠字符串匹配，很脆）。
      const estimated = usage.inputTokens === undefined;
      this.totals.llmCalls += 1;
      this.totals.inputTokens += inputTokens;
      this.totals.outputTokens += outputTokens;
      out.push(
        events.llmCompleted(this.runId, nodeId, {
          model: this.modelName,
          inputTokens,
          outputTokens,
          estimated,
          messageCount: Array.isArray((raw.data?.['input'] as { messages?: unknown })?.messages)
            ? ((raw.data?.['input'] as { messages: unknown[] }).messages.length)
            : undefined,
          finishReason: usage.finishReason,
          durationMs,
        }),
      );
    }

    if (content || toolCalls.length > 0) {
      out.push(
        events.messageCompleted(
          this.runId,
          nodeId,
          'assistant',
          content,
          toolCalls.length > 0 ? toolCalls : undefined,
        ),
      );
    }

    return out;
  }

  private onToolStart(raw: RawEvent): OutboundEvent[] {
    const nodeId = this.currentNodeId(raw) ?? 'unknown';
    const callId = typeof raw.run_id === 'string' ? raw.run_id : `tool_${Date.now()}`;
    const toolName = typeof raw.name === 'string' ? raw.name : 'unknown';
    this.openTools.set(callId, { toolName, callId, canvasNodeId: nodeId, startedAt: Date.now() });
    this.totals.toolCalls += 1;
    return [events.toolStarted(this.runId, nodeId, toolName, callId, raw.data?.['input'] ?? {})];
  }

  private onToolEnd(raw: RawEvent, isError: boolean): OutboundEvent[] {
    const callId = typeof raw.run_id === 'string' ? raw.run_id : `tool_${Date.now()}`;
    const open = this.openTools.get(callId);
    this.openTools.delete(callId);

    const toolName = open?.toolName ?? (typeof raw.name === 'string' ? raw.name : 'unknown');
    const nodeId = open?.canvasNodeId ?? this.currentNodeId(raw) ?? 'unknown';
    const durationMs = open ? Date.now() - open.startedAt : 0;

    const output = raw.data?.['output'];
    let result = isError
      ? errorText(raw.data?.['error'])
      : typeof output === 'string'
        ? output
        : contentToText(extractMessage(output) as never) || JSON.stringify(output ?? {});

    const status = isError ? 'error' : extractToolStatus(output);
    const alreadyTruncated = result.includes(TRUNCATION_MARKER);
    let truncated = alreadyTruncated;
    if (result.length > this.toolResultMaxChars) {
      result = result.slice(0, this.toolResultMaxChars) + TRUNCATION_MARKER;
      truncated = true;
    }

    return [
      events.toolFinished(this.runId, nodeId, {
        toolName,
        callId,
        durationMs,
        result,
        isError: isError || status === 'error',
        truncated,
      }),
    ];
  }
}

function toolCallsOf(raw: RawEvent): number {
  const output = raw.data?.['output'] as { messages?: unknown[] } | undefined;
  if (!output || !Array.isArray(output.messages)) return 0;
  for (let i = output.messages.length - 1; i >= 0; i -= 1) {
    const calls = extractToolCalls(output.messages[i]);
    if (calls.length > 0) return calls.length;
  }
  return 0;
}

/** on_chat_model_end 的 output 在流式模型下直接是 message，非流式下是 LLMResult，两种都要兼容 */
function extractMessage(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object') return null;
  const asRecord = output as Record<string, unknown>;
  if ('content' in asRecord || 'tool_calls' in asRecord || 'tool_call_chunks' in asRecord) {
    return asRecord;
  }
  const generations = asRecord['generations'];
  if (Array.isArray(generations) && generations.length > 0) {
    const first = generations[0];
    const generation = Array.isArray(first) ? first[0] : first;
    const message = (generation as { message?: unknown } | undefined)?.message;
    if (message && typeof message === 'object') return message as Record<string, unknown>;
  }
  return null;
}

function extractUsage(
  output: unknown,
  message: Record<string, unknown> | null,
): { inputTokens?: number; outputTokens?: number; finishReason?: string; durationMs?: number } {
  const result: { inputTokens?: number; outputTokens?: number; finishReason?: string; durationMs?: number } = {};

  const usageMetadata = message?.['usage_metadata'] as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  if (usageMetadata) {
    result.inputTokens = usageMetadata.input_tokens;
    result.outputTokens = usageMetadata.output_tokens;
  } else if (output && typeof output === 'object') {
    const llmOutput = (output as Record<string, unknown>)['llmOutput'] as
      | { tokenUsage?: { promptTokens?: number; completionTokens?: number } }
      | undefined;
    const tokenUsage = llmOutput?.tokenUsage;
    if (tokenUsage) {
      result.inputTokens = tokenUsage.promptTokens;
      result.outputTokens = tokenUsage.completionTokens;
    }
  }

  const responseMetadata = message?.['response_metadata'] as
    | { finish_reason?: string; [key: string]: unknown }
    | undefined;
  if (responseMetadata?.['finish_reason']) {
    result.finishReason = String(responseMetadata['finish_reason']);
  }
  return result;
}

function extractToolCalls(input: unknown): Array<{ id?: string; name?: string; args?: unknown }> {
  if (!input || typeof input !== 'object') return [];
  const message = input as Record<string, unknown>;
  const calls = message['tool_calls'];
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === 'object')
    .map((call) => ({
      id: typeof call['id'] === 'string' ? call['id'] : undefined,
      name: typeof call['name'] === 'string' ? call['name'] : undefined,
      args: call['args'],
    }));
}

function extractToolStatus(output: unknown): 'success' | 'error' {
  if (!output || typeof output !== 'object') return 'success';
  const status = (output as Record<string, unknown>)['status'];
  return status === 'error' ? 'error' : 'success';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error ?? {});
}
