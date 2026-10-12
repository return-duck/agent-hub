import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { executeRun, type RunOutcome } from '../src/executor/run.js';
import type { OutboundEvent } from '../src/protocol/events.js';
import { makeGraph } from './helpers/graph.js';

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
  input: Record<string, unknown>,
): Promise<{ events: OutboundEvent[]; outcome: RunOutcome }> {
  const generator = executeRun(
    { runId: 'chain-run', conversationId: 'chain-conv', graph, graphSchemaVersion: 1, input },
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

const chain = makeGraph({
  nodes: [
    { id: 'n1', type: 'start', config: { inputVariables: [{ name: 'query', type: 'string', required: true }] } },
    {
      id: 'n2',
      type: 'http',
      config: {
        method: 'POST',
        url: 'https://example.com/search',
        headers: '{"content-type":"application/json","authorization":"secret"}',
        body: '{"q":"{{inputs.query}}"}',
        inputs: 'query=input.query',
        outputKey: 'page',
      },
    },
    {
      id: 'n3',
      type: 'code',
      config: {
        source: [
          "console.log('read', scratchpad.page.status);",
          'return { query: inputs.query, status: scratchpad.page.status, echoed: scratchpad.page.json.q };',
        ].join('\n'),
        inputs: 'query=input.query',
        outputKey: 'summary',
      },
    },
    { id: 'n4', type: 'end', config: { outputKey: 'summary' } },
  ],
  edges: [
    { source: 'n1', target: 'n2' },
    { source: 'n2', target: 'n3' },
    { source: 'n3', target: 'n4' },
  ],
});

describe('HTTP 节点输出接到代码节点输入', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('串联执行，日志里能看到每个节点的输入和输出，结束节点采用上游输出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{"q":"hello"}');
        expect(new Headers(init.headers).get('authorization')).toBe('secret');
        return new Response(JSON.stringify({ q: 'hello' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { events, outcome } = await collect(chain, { query: 'hello' });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.answer).toContain('"query":"hello"');
    expect(outcome.answer).toContain('"status":200');

    const logs = events.filter((event) => event.type === 'node.log');
    const byNode = (id: string) => logs.filter((event) => event.nodeId === id);
    expect(byNode('n1').length).toBeGreaterThan(0);
    expect(byNode('n2').some((event) => event.payload.message.startsWith('准备 POST'))).toBe(true);
    const httpOut = byNode('n2').find((event) => event.payload.output !== undefined);
    expect(httpOut?.payload.output).toMatchObject({ status: 200 });
    const httpIn = byNode('n2').find((event) => event.payload.input !== undefined);
    expect(JSON.stringify(httpIn?.payload.input)).not.toContain('secret');
    expect(JSON.stringify(httpIn?.payload.input)).toContain('***');

    const codeLogs = byNode('n3');
    expect(codeLogs.some((event) => event.payload.message.includes('read'))).toBe(true);
    expect(codeLogs.some((event) => event.payload.message.includes('scratchpad.summary'))).toBe(true);

    const endLog = byNode('n4').find((event) => event.payload.publishesAnswer);
    expect(endLog?.payload.output).toMatchObject({ query: 'hello', status: 200, echoed: 'hello' });

    const started = events.filter((event) => event.type === 'node.started').map((event) => event.nodeId);
    const finished = events.filter((event) => event.type === 'node.finished').map((event) => event.nodeId);
    expect(finished.sort()).toEqual(started.sort());
  });

  it('域名不在白名单时失败，并且错误写进节点日志', async () => {
    const blocked = makeGraph({
      nodes: [
        { id: 'n1', type: 'start', config: { inputVariables: [] } },
        { id: 'n2', type: 'http', config: { url: 'https://evil.example/steal', outputKey: 'page' } },
        { id: 'n4', type: 'end', config: { outputKey: 'page' } },
      ],
      edges: [
        { source: 'n1', target: 'n2' },
        { source: 'n2', target: 'n4' },
      ],
    });
    const { events, outcome } = await collect(blocked, {});
    expect(outcome.status).toBe('FAILED');
    expect(outcome.error?.code).toBe('TOOL_ERROR');
    expect(outcome.error?.message).toContain('不在白名单');
    expect(events.some((event) => event.type === 'node.log' && event.payload.level === 'error')).toBe(true);
  });

  it('代码抛错时运行失败，日志里留着失败原因', async () => {
    const broken = makeGraph({
      nodes: [
        { id: 'n1', type: 'start', config: { inputVariables: [] } },
        { id: 'n2', type: 'code', config: { source: 'throw new Error("坏了");', outputKey: 'summary' } },
        { id: 'n4', type: 'end', config: { outputKey: 'summary' } },
      ],
      edges: [
        { source: 'n1', target: 'n2' },
        { source: 'n2', target: 'n4' },
      ],
    });
    const { events, outcome } = await collect(broken, {});
    expect(outcome.status).toBe('FAILED');
    expect(outcome.error?.message).toContain('坏了');
    expect(
      events.some((event) => event.type === 'node.log' && event.nodeId === 'n2' && event.payload.level === 'error'),
    ).toBe(true);
  });

  it('用下拉引用把上游输出按类型接进代码节点', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok-body', { status: 200, headers: { 'content-type': 'text/plain' } })),
    );
    const wired = makeGraph({
      nodes: [
        { id: 'n1', type: 'start', config: { inputVariables: [{ name: 'query', type: 'string', required: true }] } },
        {
          id: 'n2',
          type: 'http',
          config: {
            method: 'GET',
            url: { mode: 'custom', value: 'https://example.com/search', ref: '' },
            outputKey: 'page',
          },
        },
        {
          id: 'n3',
          type: 'code',
          config: {
            source: { mode: 'custom', value: 'return { query: inputs.query, status: inputs.status };', ref: '' },
            inputs: [
              { name: 'query', type: 'string', mode: 'ref', ref: 'n1.query', value: '' },
              { name: 'status', type: 'number', mode: 'ref', ref: 'n2.status', value: '' },
            ],
            outputType: 'object',
            outputKey: 'summary',
          },
        },
        {
          id: 'n4',
          type: 'end',
          config: { value: { mode: 'ref', ref: 'n3.result', value: '' }, outputKey: 'answer' },
        },
      ],
      edges: [
        { source: 'n1', target: 'n2' },
        { source: 'n2', target: 'n3' },
        { source: 'n3', target: 'n4' },
      ],
    });
    const { outcome } = await collect(wired, { query: 'hello' });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.answer).toContain('"query":"hello"');
    expect(outcome.answer).toContain('"status":200');
  });
});