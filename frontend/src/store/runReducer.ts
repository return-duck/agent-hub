/**
 * 运行状态 = 事件流的 fold。
 *
 * 刻意写成纯函数：`reduceRunEvent(state, event) => state`。
 * 好处有三：
 *  1) 可单测（见 test/runReducer.test.ts），不需要浏览器、不需要网络；
 *  2) 组件只负责渲染，不含状态迁移逻辑；
 *  3) 事件已经全部落库 —— 将来做"运行回放"就是把历史事件重新 reduce 一遍，不用另写一套逻辑。
 */
import type { ProtocolEvent } from '../generated/events.js';

export type NodeRunState = 'idle' | 'running' | 'ok' | 'error';
export type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{ id?: string; name?: string; args?: unknown }>;
  kind?: 'tool-turn';
  at: number;
}

export interface ToolCallView {
  callId: string;
  toolName: string;
  nodeId: string | null;
  args?: unknown;
  result?: string;
  isError?: boolean;
  truncated?: boolean;
  durationMs?: number;
  done: boolean;
}

export interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
  steps: number;
}

export interface NodeLogView {
  nodeId: string | null;
  nodeType: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  input?: unknown;
  output?: unknown;
}

export interface RunState {
  status: RunStatus;
  events: ProtocolEvent[];
  messages: ChatMessage[];
  /** 正在流式输出但还没定稿的文本 */
  streamingText: string;
  nodeState: Record<string, NodeRunState>;
  /** 每个节点的过程日志：输入、步骤、输出 */
  logs: NodeLogView[];
  tools: ToolCallView[];
  totals: RunTotals | null;
  error: { code: string; message: string; retryable?: boolean } | null;
  durationMs: number | null;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number } | null;
  /** 本次 run 里是否有模型没返回 usage（前端据此决定要不要提示"估算"） */
  usageEstimated: boolean;
}

export const initialRunState: RunState = {
  status: 'idle',
  events: [],
  messages: [],
  streamingText: '',
  nodeState: {},
  logs: [],
  tools: [],
  totals: null,
  error: null,
  durationMs: null,
  usage: null,
  usageEstimated: false,
};

let messageCounter = 0;
export function nextMessageId(prefix = 'm'): string {
  messageCounter += 1;
  return `${prefix}-${Date.now()}-${messageCounter}`;
}

export function reduceRunEvent(state: RunState, event: ProtocolEvent): RunState {
  const events = [...state.events, event];

  switch (event.type) {
    case 'run.started':
      return { ...state, events, status: 'running' };

    case 'node.started':
      return {
        ...state,
        events,
        nodeState: { ...state.nodeState, [event.nodeId]: 'running' },
      };

    case 'node.finished': {
      const status = event.payload.status === 'error' ? 'error' : 'ok';
      return {
        ...state,
        events,
        nodeState: { ...state.nodeState, [event.nodeId]: status },
      };
    }

    case 'node.log': {
      const level = event.payload.level === 'warn' || event.payload.level === 'error'
        ? event.payload.level
        : 'info';
      const log: NodeLogView = {
        nodeId: event.nodeId,
        nodeType: event.payload.nodeType,
        level,
        message: event.payload.message,
        ...(event.payload.input !== undefined ? { input: event.payload.input } : {}),
        ...(event.payload.output !== undefined ? { output: event.payload.output } : {}),
      };
      const answer = event.payload.publishesAnswer ? renderLogOutput(event.payload.output) : '';
      return {
        ...state,
        events,
        logs: [...state.logs, log],
        ...(answer
          ? {
              messages: [
                ...state.messages,
                { id: nextMessageId('a'), role: 'assistant' as const, content: answer, at: Date.now() },
              ],
            }
          : {}),
      };
    }

    case 'llm.token':
      return { ...state, events, streamingText: state.streamingText + event.payload.delta };

    case 'llm.completed': {
      const previous = state.usage ?? { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
      return {
        ...state,
        events,
        usage: {
          inputTokens: previous.inputTokens + (event.payload.inputTokens ?? 0),
          outputTokens: previous.outputTokens + (event.payload.outputTokens ?? 0),
          llmCalls: previous.llmCalls + 1,
        },
        usageEstimated: state.usageEstimated || event.payload.estimated === true,
      };
    }

    case 'tool.started':
      return {
        ...state,
        events,
        tools: [
          ...state.tools,
          {
            callId: event.payload.callId,
            toolName: event.payload.toolName,
            nodeId: event.nodeId,
            args: event.payload.args,
            done: false,
          },
        ],
      };

    case 'tool.finished':
      return {
        ...state,
        events,
        tools: state.tools.map((tool) =>
          tool.callId === event.payload.callId
            ? {
                ...tool,
                result: event.payload.result,
                isError: event.payload.isError,
                truncated: event.payload.truncated,
                durationMs: event.payload.durationMs,
                done: true,
              }
            : tool,
        ),
      };

    case 'message.completed': {
      const { role, content, toolCalls } = event.payload;
      const isToolTurn = Boolean(toolCalls && toolCalls.length > 0);
      // 工具调用轮：作为一张"调用了工具"的卡片落进消息流，而不是文本气泡
      const message: ChatMessage = {
        id: nextMessageId(isToolTurn ? 'tool' : 'a'),
        role,
        content,
        ...(isToolTurn ? { toolCalls, kind: 'tool-turn' as const } : {}),
        at: Date.now(),
      };
      return {
        ...state,
        events,
        messages: [...state.messages, message],
        // 定稿后用事件里的权威内容，清掉流式缓冲
        streamingText: isToolTurn ? state.streamingText : '',
      };
    }

    case 'run.error':
      return {
        ...state,
        events,
        error: {
          code: event.payload.code,
          message: event.payload.message,
          retryable: event.payload.retryable,
        },
        // 出错时把已流出的内容定稿，避免它凭空消失
        ...(state.streamingText
          ? {
              messages: [
                ...state.messages,
                {
                  id: nextMessageId('partial'),
                  role: 'assistant' as const,
                  content: state.streamingText,
                  at: Date.now(),
                },
              ],
              streamingText: '',
            }
          : {}),
      };

    case 'run.finished':
      return {
        ...state,
        events,
        // 中断不是失败：单独立一个状态，界面才能给出「改一下重发 / 重试」的入口
        status: event.payload.status === 'SUCCEEDED'
          ? 'succeeded'
          : event.payload.status === 'CANCELLED'
            ? 'cancelled'
            : 'failed',
        totals: normalizeTotals(event.payload.totals),
        durationMs: event.payload.durationMs,
        ...(state.streamingText
          ? {
              messages: [
                ...state.messages,
                {
                  id: nextMessageId('final'),
                  role: 'assistant' as const,
                  content: state.streamingText,
                  at: Date.now(),
                },
              ],
              streamingText: '',
            }
          : {}),
      };

    default:
      return { ...state, events };
  }
}

export function appendUserMessage(state: RunState, content: string): RunState {
  return {
    ...state,
    messages: [...state.messages, { id: nextMessageId('u'), role: 'user', content, at: Date.now() }],
  };
}

/** 契约里的 totals 字段都是可选的（事件可以被裁剪），UI 侧统一补 0 */
function renderLogOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeTotals(
  totals: Partial<RunTotals> | undefined | null,
): RunTotals | null {
  if (!totals) return null;
  return {
    inputTokens: totals.inputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
    llmCalls: totals.llmCalls ?? 0,
    toolCalls: totals.toolCalls ?? 0,
    steps: totals.steps ?? 0,
  };
}
