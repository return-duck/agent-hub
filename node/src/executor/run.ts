/**
 * 一次 run 的执行入口：编译 → 流式执行 → 映射成协议事件。
 *
 * 这里体现的核心主张：**执行循环完整地留在 LangGraph 内**。
 * 我们只做三件事：把画布图编译成图、把 LangChain 的事件流翻译成协议事件、把终态收敛掉。
 * Java 侧不参与单步推理，因此 interrupt / checkpointer / streamEvents 这些"循环级"
 * 能力才有存在的空间（Phase 2 直接在这层接上）。
 */
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import type { RuntimeConfig } from '../config.js';
import { compileGraph } from '../compiler/compile.js';
import { NodeRunError, stringifyOutput } from '../compiler/nodeLog.js';
import { CompileError, InputError, planGraph, validateInput } from '../compiler/validate.js';
import { parseGraph } from '../domain/parse.js';
import type { GraphSpec } from '../domain/graph.js';
import { EventMapper } from '../events/mapper.js';
import { createModelBundle } from '../models/factory.js';
import { events, type OutboundEvent } from '../protocol/events.js';
import { createTools } from '../tools/index.js';
import type { ToolName } from '../generated/manifest.js';

export interface RunRequest {
  runId?: string;
  conversationId?: string;
  graph?: unknown;
  graphSchemaVersion?: number;
  input?: Record<string, unknown>;
  history?: Array<{ role?: string; content?: string }>;
}

export type ErrorCode =
  | 'INVALID_GRAPH'
  | 'INVALID_INPUT'
  | 'MODEL_ERROR'
  | 'TOOL_ERROR'
  | 'STEP_LIMIT'
  | 'RUNTIME_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface RunOutcome {
  status: 'SUCCEEDED' | 'FAILED';
  answer: string | null;
  totals: EventMapper['totals'];
  error?: { code: ErrorCode; message: string };
}

export async function* executeRun(
  request: RunRequest,
  config: RuntimeConfig,
  signal?: AbortSignal,
): AsyncGenerator<OutboundEvent, RunOutcome, void> {
  const runId = request.runId ?? 'local-run';
  const input = request.input ?? {};
  const startedAt = Date.now();
  const bundle = createModelBundle(config);

  yield events.runStarted(
    runId,
    { provider: bundle.provider, name: bundle.name, mode: bundle.mode },
    request.graphSchemaVersion ?? 1,
    input,
  );

  let graph: GraphSpec;
  try {
    graph = parseGraph(request.graph);
  } catch (error) {
    return yield* fail(runId, startedAt, 'INVALID_GRAPH', describe(error), false);
  }

  let plan;
  try {
    plan = planGraph(graph);
    validateInput(plan, input);
  } catch (error) {
    if (error instanceof CompileError) {
      const detail = error.problems.map((p) => `${p.code}${p.nodeId ? '@' + p.nodeId : ''}: ${p.message}`).join('; ');
      return yield* fail(runId, startedAt, 'INVALID_GRAPH', detail, false);
    }
    return yield* fail(runId, startedAt, 'INVALID_INPUT', describe(error), false);
  }

  const toolNames = collectToolNames(plan.order);
  const tools = createTools(toolNames, config);
  const compiled = compileGraph(plan, {
    config,
    model: bundle.model,
    tools: new Map(toolNames.map((name, index) => [name, tools[index] as never])),
    appendInputMessage: !plan.order.some(
      (node) =>
        node.type === 'prompt' ||
        (node.type === 'llm' && typeof node.config.prompt === 'string' && node.config.prompt.trim().length > 0),
    ),
  });

  const mapper = new EventMapper({
    runId,
    nodeIndex: compiled.nodeIndex,
    modelName: `${bundle.provider}/${bundle.name}`,
    toolResultMaxChars: config.toolResultMaxChars,
  });

  const initialState = {
    messages: toMessages(request.history ?? []),
    input,
    scratchpad: {},
  };

  let answer: string | null = null;
  let failure: { code: ErrorCode; message: string } | null = null;

  try {
    for await (const raw of compiled.streamEvents(initialState, { signal })) {
      for (const event of mapper.map(raw as never)) {
        if (
          event.type === 'message.completed' &&
          event.payload.role === 'assistant' &&
          event.payload.content
        ) {
          answer = event.payload.content;
        }
        if (event.type === 'node.log' && event.payload.publishesAnswer) {
          answer = stringifyOutput(event.payload.output);
        }
        yield event;
      }
    }
  } catch (error) {
    failure = classify(error);
  }

  for (const event of mapper.finishOpenNodes(failure ? 'error' : 'ok')) {
    yield event;
  }

  if (failure) {
    yield events.runError(runId, null, failure.code, failure.message, failure.code !== 'INVALID_GRAPH');
    yield events.runFinished(runId, {
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      answer: null,
      totals: { ...mapper.totals },
    });
    return { status: 'FAILED', answer: null, totals: mapper.totals, error: failure };
  }

  yield events.runFinished(runId, {
    status: 'SUCCEEDED',
    durationMs: Date.now() - startedAt,
    answer,
    totals: { ...mapper.totals },
  });
  return { status: 'SUCCEEDED', answer, totals: mapper.totals };
}

function* fail(
  runId: string,
  startedAt: number,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): Generator<OutboundEvent, RunOutcome, void> {
  yield events.runError(runId, null, code, message, retryable);
  yield events.runFinished(runId, {
    status: 'FAILED',
    durationMs: Date.now() - startedAt,
    answer: null,
    totals: { inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0, steps: 0 },
  });
  return {
    status: 'FAILED',
    answer: null,
    totals: { inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0, steps: 0 },
    error: { code, message },
  };
}

function collectToolNames(order: GraphSpec['nodes']): ToolName[] {
  const names = new Set<ToolName>();
  for (const node of order) {
    if (node.type !== 'llm') continue;
    const tools = node.config.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (tool === 'calculator' || tool === 'http_get') names.add(tool);
    }
  }
  return [...names];
}

function toMessages(history: Array<{ role?: string; content?: string }>): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (const item of history) {
    const content = item.content ?? '';
    if (!content) continue;
    if (item.role === 'user') {
      messages.push(new HumanMessage(content));
    } else if (item.role === 'assistant') {
      messages.push(new AIMessage(content));
    }
  }
  return messages;
}

function classify(error: unknown): { code: ErrorCode; message: string } {
  const nodeError = findNodeRunError(error);
  if (nodeError) {
    return { code: nodeError.code, message: nodeError.message };
  }
  if (error instanceof GraphRecursionError) {
    return { code: 'STEP_LIMIT', message: `工具循环超过超级步上限：${describe(error)}` };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'TIMEOUT', message: '运行被取消或超时' };
  }
  const message = describe(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('api key') || lowered.includes('401') || lowered.includes('model')) {
    return { code: 'MODEL_ERROR', message };
  }
  if (lowered.includes('tool') || lowered.includes('toolnode')) {
    return { code: 'TOOL_ERROR', message };
  }
  return { code: 'INTERNAL', message };
}

function findNodeRunError(error: unknown, depth = 0): NodeRunError | null {
  if (depth > 6 || error === null || typeof error !== 'object') return null;
  if (error instanceof NodeRunError) return error;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? null : findNodeRunError(cause, depth + 1);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error ?? {});
}
