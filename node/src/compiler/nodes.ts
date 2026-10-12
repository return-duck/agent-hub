/**
 * 节点执行器：把画布上的节点翻译成 LangGraph 状态更新函数。
 *
 * LLM 节点在这里被拆成两个节点（model / tools）由 compile.ts 串成一个环，
 * 详见 compile.ts 的注释。
 */
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { RuntimeConfig } from '../config.js';
import { asNumber, asString, toToolNames, type GraphNode } from '../domain/graph.js';
import type { ToolName } from '../generated/manifest.js';
import { httpRequest, redactHeaders } from '../tools/httpRequest.js';
import { contentToText } from '../util/messageText.js';
import { outputKeyOf, resolveBindings } from './bindings.js';
import { emitNodeLog, NodeRunError, stringifyOutput, toJsonValue } from './nodeLog.js';
import { materializeBinding, materializeInputList, readBinding, type OutputCatalog } from './ports.js';
import { runJavaScript } from './runJs.js';
import type { TemplateContext } from './template.js';
import type { AgentStateType } from './state.js';

export const MODEL_SUFFIX = '__model';
export const TOOLS_SUFFIX = '__tools';

export const modelNodeName = (canvasId: string): string => `${canvasId}${MODEL_SUFFIX}`;
export const toolsNodeName = (canvasId: string): string => `${canvasId}${TOOLS_SUFFIX}`;

export interface NodeDeps {
  config: RuntimeConfig;
  model: BaseChatModel;
  tools: Map<ToolName, StructuredToolInterface>;
  /**
   * 图里没有 prompt 节点时，由 start 节点把入口变量渲染成一条 HumanMessage。
   * 否则用户画一条 start→llm→end 的图会遇到"模型收不到本轮输入"的困惑。
   */
  appendInputMessage: boolean;
  /** 编译期建好的「节点输出 → 取值路径」，输入引用靠它解析 */
  outputs?: OutputCatalog;
}

export type NodeRunner = (
  state: AgentStateType,
  config?: RunnableConfig,
) => Promise<Partial<AgentStateType>>;

export function hasTools(node: GraphNode): boolean {
  return node.type === 'llm' && toToolNames(node.config.tools).length > 0;
}

export function toolsOf(node: GraphNode, deps: NodeDeps): StructuredToolInterface[] {
  return toToolNames(node.config.tools)
    .map((name) => deps.tools.get(name))
    .filter((t): t is StructuredToolInterface => t !== undefined);
}

/**
 * start：把入口变量收敛成"已声明变量"的白名单集合。
 * 这样 prompt 模板里引用未声明变量时是 undefined（渲染出空串 + warning），而不是把
 * 用户随手塞进来的东西带进模型上下文。
 */
export function createStartRunner(node: GraphNode, deps: NodeDeps): NodeRunner {
  return async (state, config) => {
    const declared = Array.isArray(node.config.inputVariables) ? node.config.inputVariables : [];
    const normalized: Record<string, unknown> = {};
    for (const raw of declared) {
      if (!raw || typeof raw !== 'object') continue;
      const name = (raw as { name?: unknown }).name;
      if (typeof name !== 'string' || name.length === 0) continue;
      if (state.input[name] !== undefined) {
        normalized[name] = state.input[name];
      }
    }
    await emitNodeLog(
      node.id,
      { nodeType: 'start', level: 'info', message: '读取入口变量', input: state.input, output: normalized },
      config,
    );
    const update: Partial<AgentStateType> = { input: normalized };
    if (deps.appendInputMessage) {
      const text = renderInputText(normalized);
      if (text) update.messages = [new HumanMessage(text)];
    }
    return update;
  };
}

/** 入口变量渲染成给人/模型看的文本：单变量取原值，多变量用 "k: v" 多行 */
export function renderInputText(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  if (entries.length === 1) {
    const value = entries[0]?.[1];
    return value === undefined || value === null ? '' : String(value);
  }
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join('\n');
}

/** prompt：模板渲染成一条消息追加进 messages */
export function createPromptRunner(node: GraphNode, deps: NodeDeps): NodeRunner {
  return async (state, config) => {
    const context = { input: state.input, scratchpad: state.scratchpad };
    const rendered = materializeBinding(node.config.template, 'string', deps.outputs ?? new Map(), context, {
      template: true,
    });
    for (const warning of rendered.warnings) {
      await emitNodeLog(node.id, { nodeType: 'prompt', level: 'warn', message: warning }, config);
    }
    const text = String(rendered.value ?? '');
    const role = asString(node.config.role, 'human');
    const outputKey = outputKeyOf(node.config.outputKey, 'prompt');
    await emitNodeLog(
      node.id,
      {
        nodeType: 'prompt',
        level: 'info',
        message: `渲染成 ${role} 消息`,
        input: { template: textOf(node.config.template) },
        output: text,
      },
      config,
    );
    const message = role === 'system' ? new SystemMessage(text) : new HumanMessage(text);
    return { messages: [message], scratchpad: { [outputKey]: text } };
  };
}

/** end：把最后一条 AI 消息落到 scratchpad[outputKey]，作为本次运行的产物 */
export function createEndRunner(node: GraphNode, deps: NodeDeps): NodeRunner {
  return async (state, config) => {
    const outputKey = outputKeyOf(node.config.outputKey, 'answer');
    const explicit = readBinding(node.config.value);
    const context = { input: state.input, scratchpad: state.scratchpad };
    if (explicit.mode === 'ref' && explicit.ref) {
      const picked = materializeBinding(node.config.value, 'any', deps.outputs ?? new Map(), context);
      await emitNodeLog(
        node.id,
        {
          nodeType: 'end',
          level: 'info',
          message: `采用上游输出 ${explicit.ref}`,
          input: { ref: explicit.ref },
          output: picked.value,
          publishesAnswer: true,
        },
        config,
      );
      return { scratchpad: { [outputKey]: picked.value } };
    }
    if (explicit.mode === 'custom' && String(explicit.value ?? '').trim()) {
      const text = String(explicit.value);
      await emitNodeLog(
        node.id,
        {
          nodeType: 'end',
          level: 'info',
          message: '采用自定义输出',
          output: text,
          publishesAnswer: true,
        },
        config,
      );
      return { scratchpad: { [outputKey]: text } };
    }
    const fromPad = state.scratchpad[outputKey];
    const hasModelOutput = state.messages.some((message) => (message as BaseMessage).getType() === 'ai');
    if (fromPad !== undefined && !hasModelOutput) {
      await emitNodeLog(
        node.id,
        {
          nodeType: 'end',
          level: 'info',
          message: `采用上游输出 scratchpad.${outputKey}`,
          input: { outputKey },
          output: fromPad,
          publishesAnswer: true,
        },
        config,
      );
      return { scratchpad: { [outputKey]: fromPad } };
    }

    let answer = '';
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i] as BaseMessage;
      if (message.getType() === 'ai') {
        answer = contentToText(message);
        break;
      }
    }
    await emitNodeLog(
      node.id,
      {
        nodeType: 'end',
        level: answer ? 'info' : 'warn',
        message: answer ? '采用最后一条模型输出' : `scratchpad.${outputKey} 为空，也没有模型输出`,
        input: { outputKey },
        output: answer,
      },
      config,
    );
    return { scratchpad: { [outputKey]: answer } };
  };
}

/**
 * LLM 节点的 model 部分：显式消费 stream 并累积。
 *
 * 为什么用 stream + concat 而不是 invoke：
 *  - 只有真正走流式，才会有 on_chat_model_stream 回调 → 才有 llm.token 事件 → 前端才能逐字渲染；
 *  - 累积出来的 AIMessageChunk.tool_calls 正是 ToolNode 与路由函数判断"要不要调工具"的依据。
 */
/**
 * 我们只依赖模型 Runnable 的两个能力：stream 与 bind。
 * 用结构类型而不是 LangChain 的深层泛型 —— 后者在 bindTools / bind 链式调用上会迅速失控，
 * 而这里真正需要被类型保护的东西只有"输入是消息数组、输出是 AIMessageChunk 异步流"。
 */
interface ChatStream {
  stream(input: BaseMessage[]): Promise<AsyncIterable<AIMessageChunk>>;
  bind?(kwargs: Record<string, unknown>): unknown;
}

export function createModelRunner(node: GraphNode, deps: NodeDeps): NodeRunner {
  // 顺序有讲究：bindTools 返回的是 RunnableBinding，它没有 bindTools，
  // 所以必须先 bindTools 再 bind({temperature})，反过来会拿不到 bindTools。
  let runnable = (
    // bindTools 在 BaseChatModel 的类型里是可选的；走到这个分支说明该节点确实绑了工具
    hasTools(node) ? deps.model.bindTools!(toolsOf(node, deps)) : deps.model
  ) as unknown as ChatStream;

  const temperature = node.config.temperature;
  if (typeof temperature === 'number' && Number.isFinite(temperature) && typeof runnable.bind === 'function') {
    runnable = runnable.bind({ temperature }) as ChatStream;
  }
  const bound = runnable;

  return async (state, config) => {
    const boundContext = { input: state.input, scratchpad: state.scratchpad };
    const system = materializeBinding(node.config.system, 'string', deps.outputs ?? new Map(), boundContext, {
      template: true,
    });
    for (const warning of system.warnings) {
      await emitNodeLog(node.id, { nodeType: 'llm', level: 'warn', message: warning }, config);
    }
    const trimmed = trimToCharBudget(state.messages, deps.config.maxContextChars);
    const systemText = String(system.value ?? '').trim();
    const context = systemText ? [new SystemMessage(systemText), ...trimmed] : trimmed;
    await emitNodeLog(
      node.id,
      {
        nodeType: 'llm',
        level: 'info',
        message: `调用模型，上下文 ${context.length} 条消息`,
        input: { messageCount: context.length },
      },
      config,
    );
    let accumulated: AIMessageChunk | null = null;
    for await (const chunk of await bound.stream(context)) {
      accumulated = accumulated === null ? chunk : accumulated.concat(chunk);
    }
    const toolCalls = (accumulated?.tool_calls ?? []).map((call) => ({
      name: call.name,
      args: call.args,
      id: call.id,
    }));
    const message = new AIMessage({
      content: accumulated?.content ?? '',
      tool_calls: toolCalls,
      ...(accumulated?.usage_metadata ? { usage_metadata: accumulated.usage_metadata } : {}),
    });
    const text = contentToText(message);
    const outputKey = outputKeyOf(node.config.outputKey, 'answer');
    await emitNodeLog(
      node.id,
      {
        nodeType: 'llm',
        level: 'info',
        message: toolCalls.length > 0 ? `模型请求 ${toolCalls.length} 个工具` : '模型返回文本',
        output: toolCalls.length > 0 ? { text, toolCalls } : text,
      },
      config,
    );
    return {
      messages: [message],
      ...(text ? { scratchpad: { [outputKey]: text } } : {}),
    };
  };
}

/**
 * HTTP：解析输入绑定和模板，发一次请求，把响应写到 scratchpad[outputKey]。
 * 后续节点用 scratchpad.<outputKey> 或 inputs 绑定把它当成自己的输入。
 */
export function createHttpRunner(node: GraphNode, deps: NodeDeps): NodeRunner {
  return async (state, config) => {
    const base: TemplateContext = { input: state.input, scratchpad: state.scratchpad };
    const namedInputs = typeof node.config.inputs === 'string' ? resolveBindings(node.config.inputs, base) : {};
    const context: TemplateContext = { ...base, inputs: namedInputs };
    const catalog = deps.outputs ?? new Map();
    const method = asString(node.config.method, 'GET').toUpperCase();
    const urlRendered = materializeBinding(node.config.url, 'string', catalog, context, { template: true });
    const headerRendered = materializeBinding(node.config.headers, 'string', catalog, context, { template: true });
    const bodyRendered = materializeBinding(node.config.body, 'string', catalog, context, { template: true });
    for (const warning of [...urlRendered.warnings, ...headerRendered.warnings, ...bodyRendered.warnings]) {
      await emitNodeLog(node.id, { nodeType: 'http', level: 'warn', message: warning }, config);
    }
    const headerText = String(headerRendered.value ?? '');
    const bodyText = String(bodyRendered.value ?? '');
    const headers = parseHeaders(headerText);
    const outputKey = outputKeyOf(node.config.outputKey, 'http');
    const timeoutMs = clamp(asNumber(node.config.timeoutMs, deps.config.toolTimeoutMs), 100, 60_000);
    const requestInput = {
      method,
      url: String(urlRendered.value ?? '').trim(),
      headers: redactHeaders(headers),
      body: bodyText,
      inputs: namedInputs,
    };
    await emitNodeLog(
      node.id,
      { nodeType: 'http', level: 'info', message: `准备 ${method} ${requestInput.url}`, input: requestInput },
      config,
    );
    if ((method === 'GET' || method === 'DELETE') && bodyText.trim()) {
      await emitNodeLog(
        node.id,
        { nodeType: 'http', level: 'warn', message: `${method} 不发送请求体`, input: { body: bodyText } },
        config,
      );
    }

    try {
      const result = await httpRequest({
        method,
        url: requestInput.url,
        headers,
        body: bodyText,
        allowlist: deps.config.toolHttpAllowlist,
        timeoutMs,
        maxChars: Math.max(deps.config.toolResultMaxChars, 4000),
      });
      const output = {
        status: result.status,
        ok: result.ok,
        url: result.url,
        headers: redactHeaders(result.headers),
        body: result.body,
        json: result.json,
      };
      await emitNodeLog(
        node.id,
        {
          nodeType: 'http',
          level: result.ok ? 'info' : 'error',
          message: `收到 HTTP ${result.status}${result.truncated ? '（响应已截断）' : ''}`,
          output,
        },
        config,
      );
      if (!result.ok) {
        throw new NodeRunError('TOOL_ERROR', `HTTP ${result.status} ${requestInput.url}`);
      }
      return { scratchpad: { [outputKey]: output } };
    } catch (error) {
      if (error instanceof NodeRunError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = /timeout|timed out|aborted|超时/i.test(message)
        ? new NodeRunError('TIMEOUT', `HTTP 请求失败: ${message}`)
        : new NodeRunError('TOOL_ERROR', `HTTP 请求失败: ${message}`);
      await emitNodeLog(
        node.id,
        { nodeType: 'http', level: 'error', message: wrapped.message, input: requestInput },
        config,
      );
      throw wrapped;
    }
  };
}

/**
 * 代码：只执行 JavaScript。inputs / input / scratchpad 都可读，
 * return 的值写入 scratchpad[outputKey]，供下游节点绑定。
 */
export function createCodeRunner(node: GraphNode, deps: NodeDeps): NodeRunner {
  return async (state, config) => {
    const context = { input: state.input, scratchpad: state.scratchpad };
    const catalog = deps.outputs ?? new Map();
    const inputs = materializeInputList(node.config.inputs, catalog, context);
    const source = String(
      materializeBinding(node.config.source, 'string', catalog, { ...context, inputs }, { template: false }).value ?? '',
    );
    const outputKey = outputKeyOf(node.config.outputKey, 'code');
    const timeoutMs = clamp(asNumber(node.config.timeoutMs, 1000), 50, 5000);
    const seen = { inputs, input: state.input, scratchpad: state.scratchpad };
    await emitNodeLog(
      node.id,
      { nodeType: 'code', level: 'info', message: '开始执行 JavaScript', input: seen },
      config,
    );
    try {
      const result = runJavaScript(source, seen, timeoutMs);
      for (const line of result.logs) {
        await emitNodeLog(node.id, { nodeType: 'code', level: line.level, message: line.message }, config);
      }
      const output = toJsonValue(result.value);
      await emitNodeLog(
        node.id,
        { nodeType: 'code', level: 'info', message: `写入 scratchpad.${outputKey}`, output },
        config,
      );
      return { scratchpad: { [outputKey]: output } };
    } catch (error) {
      const wrapped = error instanceof NodeRunError
        ? error
        : new NodeRunError('INTERNAL', error instanceof Error ? error.message : String(error));
      await emitNodeLog(
        node.id,
        { nodeType: 'code', level: 'error', message: wrapped.message, input: seen },
        config,
      );
      throw wrapped;
    }
  };
}

function parseHeaders(raw: string): Record<string, string> {
  const text = raw.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new NodeRunError('INVALID_INPUT', 'headers 必须是 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NodeRunError('INVALID_INPUT', 'headers 必须是 JSON 对象');
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new NodeRunError('INVALID_INPUT', `请求头 ${key} 的值必须是字符串`);
    }
    headers[key] = String(value);
  }
  return headers;
}

function textOf(raw: unknown): string {
  const binding = readBinding(raw);
  return binding.mode === 'ref' ? binding.ref : stringifyOutput(binding.value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 上下文裁剪：按字符预算保留最近的消息。
 *
 * 刻意手写而不是用 trimMessages —— 后者依赖模型的 tokenizer，MVP 阶段用
 * "4 字符 ≈ 1 token" 的确定性预算，测试才能稳定断言"超限一定触发裁剪"。
 * Phase 2 会换成基于真实 tokenizer 的版本。
 */
export function trimToCharBudget(messages: BaseMessage[], maxChars: number): BaseMessage[] {
  if (maxChars <= 0) return messages;
  let total = 0;
  const kept: BaseMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as BaseMessage;
    const size = contentToText(message).length + 8;
    if (total + size > maxChars && kept.length > 0) {
      break;
    }
    total += size;
    kept.unshift(message);
  }
  return kept;
}

/** 供 UI/日志用的节点显示名 */
export function labelOf(node: GraphNode): string {
  return node.label || `${node.type}#${node.id}`;
}
