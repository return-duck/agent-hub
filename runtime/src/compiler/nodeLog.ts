/**
 * 节点过程日志。
 *
 * 两处同时留下痕迹：
 *  - 进程日志（console），方便直接看 runtime 输出；
 *  - LangGraph 自定义事件 node.log，由映射器收成协议事件，前端和轨迹库都能看到
 *    这一步的输入与输出。
 */
import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
import type { RunnableConfig } from '@langchain/core/runnables';

export type NodeLogLevel = 'info' | 'warn' | 'error';

export type NodeErrorCode = 'INVALID_INPUT' | 'TOOL_ERROR' | 'TIMEOUT' | 'INTERNAL';

export interface NodeLogPayload {
  nodeType: string;
  level: NodeLogLevel;
  message: string;
  input?: unknown;
  output?: unknown;
  /** 结束节点把上游输出收成这次运行的答案时置位 */
  publishesAnswer?: boolean;
}

const MAX_TEXT = 2000;
const MAX_DEPTH = 6;

export class NodeRunError extends Error {
  readonly code: NodeErrorCode;

  constructor(code: NodeErrorCode, message: string) {
    super(message);
    this.name = 'NodeRunError';
    this.code = code;
  }
}

export function clipValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return clipText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return clipText(JSON.stringify(value));
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => clipValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = clipValue(item, depth + 1);
    }
    return out;
  }
  return clipText(String(value));
}

export function clipText(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[已截断]` : text;
}

export async function emitNodeLog(
  nodeId: string,
  payload: NodeLogPayload,
  config?: RunnableConfig,
): Promise<void> {
  const safe: NodeLogPayload = {
    nodeType: payload.nodeType,
    level: payload.level,
    message: clipText(payload.message),
    ...(payload.input !== undefined ? { input: clipValue(payload.input) } : {}),
    ...(payload.output !== undefined ? { output: clipValue(payload.output) } : {}),
    ...(payload.publishesAnswer ? { publishesAnswer: true } : {}),
  };
  const line = `[node] ${payload.nodeType}#${nodeId} ${safe.message}`;
  if (payload.level === 'error') console.error(line);
  else if (payload.level === 'warn') console.warn(line);
  else console.info(line);

  try {
    await dispatchCustomEvent('node.log', { nodeId, ...safe }, config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[node] ${payload.nodeType}#${nodeId} 日志事件投递失败: ${detail}`);
  }
}

/** 把节点输出收成可以放进 scratchpad、也可以当答案展示的 JSON 值 */
export function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new NodeRunError('INTERNAL', '节点输出无法序列化成 JSON');
    }
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof NodeRunError) throw error;
    throw new NodeRunError('INTERNAL', '节点输出无法序列化成 JSON');
  }
}

export function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
