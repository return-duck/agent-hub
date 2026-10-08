/**
 * 服务端 API 客户端。
 *
 * 浏览器【只】与 server 通信：单一 origin、单一 CORS 点、单一鉴权点，
 * 而且 run 的执行与落库完全不依赖浏览器是否在场（关掉页面 run 照样跑完）。
 */
import type { AgentGraph } from '../generated/agent-graph.js';
import type { ProtocolEvent } from '../generated/events.js';

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  graphSchemaVersion: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDetail extends AgentSummary {
  graph: AgentGraph;
}

export interface Capabilities {
  runtimeUp: boolean;
  modelMode: 'scripted' | 'live' | null;
  modelName: string | null;
  nodeTypes: string[];
}

export interface StartRunResponse {
  runId: string;
  conversationId: string;
}

export interface RunView {
  id: string;
  agentId: string;
  conversationId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  input: Record<string, unknown> | null;
  answer: string | null;
  error: { code?: string; message?: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface MessageView {
  id: string;
  runId: string | null;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: Array<{ id?: string; name?: string; args?: unknown }> | null;
  createdAt: string;
}

export interface ApiErrorDetail {
  code: string;
  nodeId: string | null;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** 把逐节点的校验问题渲染成可直接展示的多行文本 */
  get detailText(): string {
    return this.details
      .map((d) => (d.nodeId ? `· [${d.nodeId}] ${d.message}` : `· ${d.message}`))
      .join('\n');
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const problem = (body ?? {}) as { code?: string; message?: string; details?: ApiErrorDetail[] };
    throw new ApiError(
      response.status,
      problem.code ?? 'UNKNOWN',
      problem.message ?? `请求失败 (${response.status})`,
      problem.details ?? [],
    );
  }
  return body as T;
}

export const api = {
  listAgents: () => request<AgentSummary[]>('/api/agents'),
  getAgent: (id: string) => request<AgentDetail>(`/api/agents/${id}`),
  createAgent: (name: string, description: string, graph: AgentGraph) =>
    request<AgentDetail>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name, description, graph }),
    }),
  updateAgent: (id: string, name: string, description: string, graph: AgentGraph) =>
    request<AgentDetail>(`/api/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, description, graph }),
    }),
  deleteAgent: (id: string) => request<void>(`/api/agents/${id}`, { method: 'DELETE' }),
  capabilities: () => request<Capabilities>('/api/capabilities'),
  startRun: (agentId: string, input: Record<string, unknown>, conversationId?: string) =>
    request<StartRunResponse>(`/api/agents/${agentId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input, conversationId: conversationId ?? null }),
    }),
  getRun: (runId: string) => request<RunView>(`/api/runs/${runId}`),
  messagesOfConversation: (conversationId: string) =>
    request<MessageView[]>(`/api/conversations/${conversationId}/messages`),
};

const EVENT_TYPES = [
  'run.started',
  'node.started',
  'node.finished',
  'llm.token',
  'llm.completed',
  'tool.started',
  'tool.finished',
  'message.completed',
  'run.error',
  'run.finished',
] as const;

export interface RunSubscription {
  close(): void;
}

/**
 * 订阅一次 run 的事件流。
 *
 * 两个必须注意的点：
 *  1) 事件名是 SSE 的 event 字段，EventSource.onmessage 收不到，必须逐类型 addEventListener；
 *  2) run 结束后服务端会主动关闭连接，而 EventSource 默认会"自动重连" ——
 *     不主动 close() 就会变成无限重连。所以收到 run.finished 必须自己收口。
 *  3) 断线续传是免费的：服务端把事件 id 设为 seq，浏览器重连时自动带 Last-Event-ID。
 */
export function subscribeToRun(
  runId: string,
  onEvent: (event: ProtocolEvent) => void,
  onConnectionIssue: (message: string) => void,
): RunSubscription {
  const source = new EventSource(`/api/runs/${runId}/events`);
  let closed = false;

  const close = (): void => {
    if (!closed) {
      closed = true;
      source.close();
    }
  };

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as ProtocolEvent;
        onEvent(event);
        if (event.type === 'run.finished') {
          close();
        }
      } catch (error) {
        onConnectionIssue(`事件解析失败: ${String(error)}`);
      }
    });
  }

  source.onerror = () => {
    if (closed) return;
    // readyState=CLOSED 表示浏览器已放弃重连（例如服务端 404）
    if (source.readyState === EventSource.CLOSED) {
      onConnectionIssue('事件流已断开');
      close();
    } else {
      onConnectionIssue('事件流断开，正在按 Last-Event-ID 续传…');
    }
  };

  return { close };
}
