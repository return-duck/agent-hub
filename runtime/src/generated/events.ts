/* eslint-disable */
/**
 * 自动生成，请勿手工修改。
 * 由 scripts/codegen.mjs 从 contracts/events.schema.json 生成。
 * 重新生成：npm run codegen
 */

/**
 * 运行时事件协议的判别式联合。seq 由 server 作为唯一写入者分配，runtime 只产出语义事件。
 */
export type ProtocolEvent =
  | RunStarted
  | NodeStarted
  | NodeFinished
  | LlmToken
  | LlmCompleted
  | ToolStarted
  | ToolFinished
  | MessageCompleted
  | RunError
  | RunFinished;

export interface RunStarted {
  seq?: number;
  type: "run.started";
  runId: string;
  nodeId?: string | null;
  ts: string;
  payload: {
    graphSchemaVersion?: number;
    model: {
      provider: string;
      name: string;
      mode: "scripted" | "live";
    };
    input?: {};
  };
}
export interface NodeStarted {
  seq?: number;
  type: "node.started";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    nodeType?: string;
    label?: string;
  };
}
export interface NodeFinished {
  seq?: number;
  type: "node.finished";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    nodeType?: string;
    durationMs?: number;
    status?: "ok" | "error";
  };
}
export interface LlmToken {
  seq?: number;
  type: "llm.token";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    delta: string;
  };
}
export interface LlmCompleted {
  seq?: number;
  type: "llm.completed";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    messageCount?: number;
    finishReason?: string;
    durationMs?: number;
  };
}
export interface ToolStarted {
  seq?: number;
  type: "tool.started";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    toolName: string;
    callId: string;
    args?: unknown;
  };
}
export interface ToolFinished {
  seq?: number;
  type: "tool.finished";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    toolName: string;
    callId: string;
    durationMs?: number;
    result?: string;
    isError?: boolean;
    truncated?: boolean;
  };
}
export interface MessageCompleted {
  seq?: number;
  type: "message.completed";
  runId: string;
  nodeId?: string | null;
  ts: string;
  payload: {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCalls?: {
      id?: string;
      name?: string;
      args?: unknown;
    }[];
  };
}
export interface RunError {
  seq?: number;
  type: "run.error";
  runId: string;
  nodeId?: string | null;
  ts: string;
  payload: {
    code:
      | "INVALID_GRAPH"
      | "INVALID_INPUT"
      | "MODEL_ERROR"
      | "TOOL_ERROR"
      | "STEP_LIMIT"
      | "RUNTIME_UNAVAILABLE"
      | "TIMEOUT"
      | "INTERNAL";
    message: string;
    retryable: boolean;
  };
}
export interface RunFinished {
  seq?: number;
  type: "run.finished";
  runId: string;
  nodeId?: string | null;
  ts: string;
  payload: {
    status: "SUCCEEDED" | "FAILED";
    durationMs: number;
    answer?: string | null;
    totals?: {
      inputTokens?: number;
      outputTokens?: number;
      llmCalls?: number;
      toolCalls?: number;
      steps?: number;
    };
  };
}
