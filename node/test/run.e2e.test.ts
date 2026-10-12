import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { executeRun, type RunOutcome } from '../src/executor/run.js';
import type { OutboundEvent } from '../src/protocol/events.js';
import { makeGraph } from './helpers/graph.js';

/** 显式构造配置，避免测试受本机 .env / MODEL_PROVIDER 影响 */
const testConfig: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  model: { provider: 'scripted', name: 'test-model', baseUrl: undefined, apiKey: undefined, temperature: 0 },
  maxContextChars: 12000,
  toolTimeoutMs: 5000,
  toolResultMaxChars: 2000,
  toolHttpAllowlist: ['example.com'],
};

async function collect(
  graph: unknown,
  input: Record<string, unknown> = { topic: '(12+8)*3' },
  history: Array<{ role: string; content: string }> = [],
): Promise<{ events: OutboundEvent[]; outcome: RunOutcome }> {
  const generator = executeRun(
    { runId: 'test-run', conversationId: 'test-conv', graph, graphSchemaVersion: 1, input, history },
    testConfig,
  );
  const events: OutboundEvent[] = [];
  let step = await generator.next();
  while (!step.done) {
    events.push(step.value);
    step = await generator.next();
  }
  return { events, outcome: step.value };
}

const types = (events: OutboundEvent[]): string[] => events.map((e) => e.type);

describe('端到端：带工具调用的 agent（start → prompt → llm+calculator → end）', () => {
  it('产出完整且顺序正确的协议事件流', async () => {
    const { events, outcome } = await collect(makeGraph());

    expect(types(events)[0]).toBe('run.started');
    expect(types(events).at(-1)).toBe('run.finished');
    expect(outcome.status).toBe('SUCCEEDED');

    // 四个画布节点都必须宣告过
    const startedNodes = events.filter((e) => e.type === 'node.started').map((e) => e.nodeId);
    expect(new Set(startedNodes)).toEqual(new Set(['n1', 'n2', 'n3', 'n4']));
  });

  it('不变量：每个 node.started 都有配对的 node.finished', async () => {
    const { events } = await collect(makeGraph());
    const started = events.filter((e) => e.type === 'node.started').map((e) => e.nodeId);
    const finished = events.filter((e) => e.type === 'node.finished').map((e) => e.nodeId);
    expect(finished.sort()).toEqual(started.sort());
  });

  it('真的发生了一次工具调用，并且算出正确结果', async () => {
    const { events, outcome } = await collect(makeGraph(), { topic: '(12+8)*3' });

    const startedTools = events.filter((e) => e.type === 'tool.started');
    const finishedTools = events.filter((e) => e.type === 'tool.finished');
    expect(startedTools).toHaveLength(1);
    expect(finishedTools).toHaveLength(1);

    expect(startedTools[0]?.payload).toMatchObject({
      toolName: 'calculator',
      args: { expression: '(12+8)*3' },
    });
    expect(finishedTools[0]?.payload).toMatchObject({ isError: false, result: '(12+8)*3 = 60' });

    // 工具调用的 callId 必须成对
    expect((startedTools[0]?.payload as { callId: string }).callId).toBe(
      (finishedTools[0]?.payload as { callId: string }).callId,
    );

    expect(outcome.totals.toolCalls).toBe(1);
    // 工具轮 + 总结轮 = 两次模型调用，这正是"画布是 DAG、运行时是循环"的证据
    expect(outcome.totals.llmCalls).toBe(2);
  });

  it('token 级流式：llm.token 的拼接结果等于最终答案', async () => {
    const { events, outcome } = await collect(makeGraph());
    const deltas = events
      .filter((e) => e.type === 'llm.token')
      .map((e) => (e.payload as { delta: string }).delta);

    expect(deltas.length).toBeGreaterThan(5);
    expect(deltas.join('')).toBe(outcome.answer);
    expect(outcome.answer).toContain('(12+8)*3 = 60');
  });

  it('run.started 如实标注模型模式（没有 key 就是 scripted）', async () => {
    const { events } = await collect(makeGraph());
    const started = events.find((e) => e.type === 'run.started');
    expect(started?.payload).toMatchObject({ model: { provider: 'scripted', mode: 'scripted' } });
  });

  it('最终答案落进 run.finished，并带上用量统计', async () => {
    const { events } = await collect(makeGraph());
    const finished = events.find((e) => e.type === 'run.finished');
    expect(finished?.payload).toMatchObject({ status: 'SUCCEEDED' });
    const payload = finished?.payload as {
      answer: string;
      totals: { inputTokens: number; outputTokens: number; toolCalls: number; steps: number };
    };
    expect(payload.answer).toContain('(12+8)*3 = 60');
    expect(payload.totals.inputTokens).toBeGreaterThan(0);
    expect(payload.totals.outputTokens).toBeGreaterThan(0);
    expect(payload.totals.steps).toBeGreaterThanOrEqual(4);
  });

  it('多轮：把会话历史交给模型（runtime 无状态，历史由 server 全量下发）', async () => {
    const history = [
      { role: 'user', content: '上一轮我问了 1+1' },
      { role: 'assistant', content: '1+1 = 2' },
    ];
    const { outcome } = await collect(makeGraph(), { topic: '2+2' }, history);
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.answer).toBeTruthy();
  });
});

describe('端到端：不带工具的直连图（start → prompt → llm → end）', () => {
  const plainGraph = makeGraph({
    nodes: [
      { id: 'n1', type: 'start', config: { inputVariables: [{ name: 'topic', type: 'string', required: true }] } },
      { id: 'n2', type: 'prompt', config: { role: 'human', template: '你好，{{input.topic}}' } },
      { id: 'n3', type: 'llm', config: { tools: [], maxSteps: 4, outputKey: 'answer' } },
      { id: 'n4', type: 'end', config: { outputKey: 'answer' } },
    ],
  });

  it('没有工具时一次模型调用就跑完，且不产生任何 tool 事件', async () => {
    const { events, outcome } = await collect(plainGraph, { topic: '世界' });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
    expect(outcome.totals.llmCalls).toBe(1);
    expect(outcome.totals.toolCalls).toBe(0);
    expect(outcome.answer).toContain('世界');
  });
});

describe('端到端：失败路径也必须收敛成终态', () => {
  it('非法图 → run.error(INVALID_GRAPH) + run.finished(FAILED)，且错误里带 nodeId', async () => {
    const broken = makeGraph({
      edges: [
        { source: 'n1', target: 'n2' },
        { source: 'n2', target: 'n3' },
        { source: 'n3', target: 'n1' }, // n4 不可达 + 成环
      ],
    });
    const { events, outcome } = await collect(broken);

    expect(outcome.status).toBe('FAILED');
    const error = events.find((e) => e.type === 'run.error');
    expect(error?.payload).toMatchObject({ code: 'INVALID_GRAPH', retryable: false });
    expect((error?.payload as { message: string }).message).toContain('CYCLE_DETECTED');
    expect(types(events).at(-1)).toBe('run.finished');
    expect(events.find((e) => e.type === 'run.finished')?.payload).toMatchObject({ status: 'FAILED' });
  });

  it('缺少必填入口变量 → run.error(INVALID_INPUT)', async () => {
    const { events, outcome } = await collect(makeGraph(), {});
    expect(outcome.status).toBe('FAILED');
    expect(events.find((e) => e.type === 'run.error')?.payload).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('graph 根本不是对象时也能收敛', async () => {
    const { events, outcome } = await collect(null);
    expect(outcome.status).toBe('FAILED');
    expect(types(events)).toEqual(['run.started', 'run.error', 'run.finished']);
  });

  it('无论成功失败，run.started 永远是第一个事件（Java 侧靠它及时拿到响应头）', async () => {
    for (const graph of [makeGraph(), null]) {
      const { events } = await collect(graph as unknown);
      expect(types(events)[0]).toBe('run.started');
    }
  });
});
