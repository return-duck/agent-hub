/**
 * 节点执行器：把画布上的 4 类节点翻译成 LangGraph 状态更新函数。
 *
 * LLM 节点在这里被拆成两个节点（model / tools）由 compile.ts 串成一个环，
 * 详见 compile.ts 的注释。
 */
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { RuntimeConfig } from '../config.js';
import { asString, toToolNames, type GraphNode } from '../domain/graph.js';
import type { ToolName } from '../generated/manifest.js';
import { contentToText } from '../util/messageText.js';
import { renderTemplate } from './template.js';
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
}

export type NodeRunner = (state: AgentStateType) => Promise<Partial<AgentStateType>>;

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
  return async (state) => {
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
export function createPromptRunner(node: GraphNode): NodeRunner {
  return async (state) => {
    const template = asString(node.config.template);
    const { text } = renderTemplate(template, { input: state.input, scratchpad: state.scratchpad });
    const role = asString(node.config.role, 'human');
    const message = role === 'system' ? new SystemMessage(text) : new HumanMessage(text);
    return { messages: [message] };
  };
}

/** end：把最后一条 AI 消息落到 scratchpad[outputKey]，作为本次运行的产物 */
export function createEndRunner(node: GraphNode): NodeRunner {
  return async (state) => {
    const outputKey = asString(node.config.outputKey, 'answer');
    let answer = '';
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i] as BaseMessage;
      if (message.getType() === 'ai') {
        answer = contentToText(message);
        break;
      }
    }
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

  return async (state) => {
    const context = trimToCharBudget(state.messages, deps.config.maxContextChars);
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
    return { messages: [message] };
  };
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
