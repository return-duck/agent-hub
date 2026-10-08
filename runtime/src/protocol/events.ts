/**
 * 协议事件构造器。
 *
 * runtime 只产出【语义】事件，不分配 seq —— seq 由 server 作为唯一写入者分配，
 * 这样 (run_id, seq) 的单调性只需在一处保证，SSE 续传的判重也就有了唯一依据。
 */
import type { ProtocolEvent } from '../generated/events.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 出站事件：契约事件去掉由 server 分配的 seq */
export type OutboundEvent = DistributiveOmit<ProtocolEvent, 'seq'>;

const now = (): string => new Date().toISOString();

export const events = {
  runStarted(
    runId: string,
    model: { provider: string; name: string; mode: 'scripted' | 'live' },
    graphSchemaVersion: number,
    input: Record<string, unknown>,
  ): OutboundEvent {
    return {
      type: 'run.started',
      runId,
      nodeId: null,
      ts: now(),
      payload: { model, graphSchemaVersion, input },
    };
  },

  nodeStarted(runId: string, nodeId: string, nodeType: string, label: string): OutboundEvent {
    return { type: 'node.started', runId, nodeId, ts: now(), payload: { nodeType, label } };
  },

  nodeFinished(
    runId: string,
    nodeId: string,
    nodeType: string,
    durationMs: number,
    status: 'ok' | 'error',
  ): OutboundEvent {
    return { type: 'node.finished', runId, nodeId, ts: now(), payload: { nodeType, durationMs, status } };
  },

  llmToken(runId: string, nodeId: string, delta: string): OutboundEvent {
    return { type: 'llm.token', runId, nodeId, ts: now(), payload: { delta } };
  },

  llmCompleted(
    runId: string,
    nodeId: string,
    info: {
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      messageCount?: number;
      finishReason?: string;
      durationMs?: number;
      /** token 数是否为估算（模型未返回 usage）—— 前端据此决定要不要提示"估算" */
      estimated?: boolean;
    },
  ): OutboundEvent {
    return { type: 'llm.completed', runId, nodeId, ts: now(), payload: { ...info } };
  },

  toolStarted(runId: string, nodeId: string, toolName: string, callId: string, args: unknown): OutboundEvent {
    return { type: 'tool.started', runId, nodeId, ts: now(), payload: { toolName, callId, args } };
  },

  toolFinished(
    runId: string,
    nodeId: string,
    info: {
      toolName: string;
      callId: string;
      durationMs: number;
      result: string;
      isError: boolean;
      truncated: boolean;
    },
  ): OutboundEvent {
    return { type: 'tool.finished', runId, nodeId, ts: now(), payload: { ...info } };
  },

  messageCompleted(
    runId: string,
    nodeId: string | null,
    role: 'system' | 'user' | 'assistant' | 'tool',
    content: string,
    toolCalls?: Array<{ id?: string; name?: string; args?: unknown }>,
  ): OutboundEvent {
    return {
      type: 'message.completed',
      runId,
      nodeId,
      ts: now(),
      payload: toolCalls && toolCalls.length > 0 ? { role, content, toolCalls } : { role, content },
    };
  },

  runError(
    runId: string,
    nodeId: string | null,
    code:
      | 'INVALID_GRAPH'
      | 'INVALID_INPUT'
      | 'MODEL_ERROR'
      | 'TOOL_ERROR'
      | 'STEP_LIMIT'
      | 'RUNTIME_UNAVAILABLE'
      | 'TIMEOUT'
      | 'INTERNAL',
    message: string,
    retryable: boolean,
  ): OutboundEvent {
    return { type: 'run.error', runId, nodeId, ts: now(), payload: { code, message, retryable } };
  },

  runFinished(
    runId: string,
    info: {
      status: 'SUCCEEDED' | 'FAILED';
      durationMs: number;
      answer?: string | null;
      totals?: {
        inputTokens: number;
        outputTokens: number;
        llmCalls: number;
        toolCalls: number;
        steps: number;
      };
    },
  ): OutboundEvent {
    return {
      type: 'run.finished',
      runId,
      nodeId: null,
      ts: now(),
      payload: { ...info, answer: info.answer ?? null },
    };
  },
};

export function serialize(event: OutboundEvent): string {
  return JSON.stringify(event);
}
