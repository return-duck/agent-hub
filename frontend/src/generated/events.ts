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
  | NodeLog
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
    /**
     * token 数是否由「4 字符≈1 token」估算得出（模型未返回 usage 时为 true）
     */
    estimated?: boolean;
    /**
     * 本次模型调用实际发送的输入（按 role 前缀渲染的文本，超长会截断）
     */
    input?: string;
    /**
     * 本次模型调用返回的文本（超长会截断）
     */
    output?: string;
    /**
     * input 是否被截断
     */
    inputTruncated?: boolean;
    /**
     * output 是否被截断
     */
    outputTruncated?: boolean;
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
    /**
     * 调用类别：本地工具 / MCP 工具 / 技能。分别以不同类别记录进调用轨迹
     */
    kind?: "tool" | "mcp" | "skill";
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
    /**
     * 调用类别：本地工具 / MCP 工具 / 技能
     */
    kind?: "tool" | "mcp" | "skill";
    durationMs?: number;
    result?: string;
    isError?: boolean;
    truncated?: boolean;
  };
}
export interface NodeLog {
  seq?: number;
  type: "node.log";
  runId: string;
  nodeId: string;
  ts: string;
  payload: {
    nodeType: string;
    level: "info" | "warn" | "error";
    message: string;
    /**
     * 这一步实际使用的输入
     */
    input?: {} | unknown[] | string | number | boolean | null;
    /**
     * 这一步产出的输出
     */
    output?: {} | unknown[] | string | number | boolean | null;
    /**
     * 为 true 时，output 就是本次运行的最终答案（结束节点汇总上游输出）
     */
    publishesAnswer?: boolean;
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
    /**
     * CANCELLED 表示被用户主动中断；已产出的事件仍然有效，可据此重试
     */
    status: "SUCCEEDED" | "FAILED" | "CANCELLED";
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
