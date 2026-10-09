/**
 * 服务端 API 客户端。
 *
 * 浏览器【只】与 server 通信：单一 origin、单一 CORS 点、单一鉴权点，
 * 而且 run 的执行与落库完全不依赖浏览器是否在场（关掉页面 run 照样跑完）。
 */
/**
 * API 基址由 config/base.ts 推导（/api、/studio/api 等），
 * 这样同一份产物能同时支持根路径、/studio/ 子路径，以及 /a/<slug> 这类公开对话深路径。
 */
import { apiBase } from '../config/base.js';
import { clearSession, getToken } from '../store/session.js';
import type { AgentGraph } from '../generated/agent-graph.js';
import type { ProtocolEvent } from '../generated/events.js';

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  graphSchemaVersion: number;
  nodeCount: number;
  published: boolean;
  publicSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/** 会话摘要；fromVisitor 表示这条会话来自公开分享页的访客。 */
export interface ConversationSummary {
  id: string;
  title: string | null;
  fromVisitor: boolean;
  messageCount: number;
  createdAt: string;
}

/** 公开分享页能看到的 agent 信息（不含 graph） */
export interface PublicAgent {
  slug: string;
  name: string;
  description: string | null;
  publishedAt: string | null;
}

/** 一条调用轨迹。kind 决定用什么标签展示。 */
export interface TraceSpan {
  id: string;
  spanSeq: number;
  kind: 'node' | 'model' | 'tool' | 'mcp' | 'skill';
  name: string;
  nodeId: string | null;
  status: 'ok' | 'error' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  attributes: Record<string, unknown> | null;
  error: string | null;
}

/** 轨迹页左侧的运行条目 */
export interface RunSummary {
  id: string;
  status: RunView['status'];
  retryOfRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  answerPreview: string | null;
  spanCount: number;
}

export interface PublishResult {
  slug: string;
  publicPath: string | null;
  published: boolean;
}

export interface AgentDetail extends AgentSummary {
  graph: AgentGraph;
  publishedAt: string | null;
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
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
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
  const token = getToken();
  const response = await fetch(apiBase() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // 令牌过期或被吊销时清掉本地登录态，让界面回到登录页而不是反复报错
  if (response.status === 401) {
    clearSession();
  }

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
  listAgents: () => request<AgentSummary[]>('/agents'),
  getAgent: (id: string) => request<AgentDetail>(`/agents/${id}`),
  createAgent: (name: string, description: string, graph: AgentGraph) =>
    request<AgentDetail>('/agents', {
      method: 'POST',
      body: JSON.stringify({ name, description, graph }),
    }),
  updateAgent: (id: string, name: string, description: string, graph: AgentGraph) =>
    request<AgentDetail>(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, description, graph }),
    }),
  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
  capabilities: () => request<Capabilities>('/capabilities'),
  startRun: (agentId: string, input: Record<string, unknown>, conversationId?: string) =>
    request<StartRunResponse>(`/agents/${agentId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input, conversationId: conversationId ?? null }),
    }),
  getRun: (runId: string) => request<RunView>(`/runs/${runId}`),
  messagesOfConversation: (conversationId: string) =>
    request<MessageView[]>(`/conversations/${conversationId}/messages`),

  // ---- 登录态 ----
  register: (email: string, displayName: string, password: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, displayName, password }),
    }),
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<AuthUser>('/auth/me'),

  // ---- 中断 / 断点重试 / 回退 ----
  cancelRun: (runId: string) => request<RunView>(`/runs/${runId}/cancel`, { method: 'POST' }),
  retryRun: (runId: string) =>
    request<StartRunResponse>(`/runs/${runId}/retry`, { method: 'POST' }),
  /** 回退到 keepSeq（含），删掉其后的消息与其 run；返回剩余消息 */
  rewindConversation: (conversationId: string, keepSeq: number) =>
    request<MessageView[]>(`/conversations/${conversationId}/rewind`, {
      method: 'POST',
      body: JSON.stringify({ keepSeq }),
    }),

  // ---- 调用轨迹 ----
  agentRuns: (agentId: string, limit = 30) =>
    request<RunSummary[]>(`/agents/${agentId}/runs?limit=${limit}`),
  runTraces: (runId: string) => request<TraceSpan[]>(`/runs/${runId}/traces`),
  conversationTraces: (conversationId: string) => request<TraceSpan[]>(`/conversations/${conversationId}/traces`),

  // ---- 发布 ----
  publishAgent: (id: string) => request<PublishResult>(`/agents/${id}/publish`, { method: 'POST' }),
  unpublishAgent: (id: string) => request<PublishResult>(`/agents/${id}/unpublish`, { method: 'POST' }),
  listConversations: (agentId: string) => request<ConversationSummary[]>(`/agents/${agentId}/conversations`),

  // ---- 公开分享页（免登录） ----
  publicAgent: (slug: string) => request<PublicAgent>(`/public/agents/${encodeURIComponent(slug)}`),
  startPublicRun: (slug: string, input: Record<string, unknown>, conversationId: string | null, visitor: string) =>
    request<StartRunResponse>(`/public/agents/${encodeURIComponent(slug)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input, conversationId, visitorId: visitor }),
    }),
  publicConversations: (slug: string, visitor: string) =>
    request<ConversationSummary[]>(
      `/public/agents/${encodeURIComponent(slug)}/conversations?visitorId=${encodeURIComponent(visitor)}`,
    ),
  cancelPublicRun: (slug: string, runId: string, visitor: string) =>
    request<RunView>(`/public/agents/${encodeURIComponent(slug)}/runs/${runId}/cancel`
      + `?visitorId=${encodeURIComponent(visitor)}`, { method: 'POST' }),
  retryPublicRun: (slug: string, runId: string, visitor: string) =>
    request<StartRunResponse>(`/public/agents/${encodeURIComponent(slug)}/runs/${runId}/retry`
      + `?visitorId=${encodeURIComponent(visitor)}`, { method: 'POST' }),
  rewindPublicConversation: (slug: string, conversationId: string, keepSeq: number, visitor: string) =>
    request<MessageView[]>(
      `/public/agents/${encodeURIComponent(slug)}/conversations/${conversationId}/rewind`,
      { method: 'POST', body: JSON.stringify({ keepSeq, visitorId: visitor }) },
    ),
  publicRunTraces: (slug: string, runId: string, visitor: string) =>
    request<TraceSpan[]>(`/public/agents/${encodeURIComponent(slug)}/runs/${runId}/traces`
      + `?visitorId=${encodeURIComponent(visitor)}`),
  publicMessages: (slug: string, conversationId: string, visitor: string) =>
    request<MessageView[]>(
      `/public/agents/${encodeURIComponent(slug)}/conversations/${conversationId}/messages`
        + `?visitorId=${encodeURIComponent(visitor)}`,
    ),
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
  return subscribe(`${apiBase()}/runs/${runId}/events`, onEvent, onConnectionIssue);
}

/** 公开分享页的事件流：URL 里要带 visitorId，服务端据此校验这条 run 属于该访客。 */
export function subscribeToPublicRun(
  slug: string,
  runId: string,
  visitor: string,
  onEvent: (event: ProtocolEvent) => void,
  onConnectionIssue: (message: string) => void,
): RunSubscription {
  const url = `${apiBase()}/public/agents/${encodeURIComponent(slug)}/runs/${runId}/events`
    + `?visitorId=${encodeURIComponent(visitor)}`;
  return subscribe(url, onEvent, onConnectionIssue);
}

function subscribe(
  url: string,
  onEvent: (event: ProtocolEvent) => void,
  onConnectionIssue: (message: string) => void,
): RunSubscription {
  const source = new EventSource(url);
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
