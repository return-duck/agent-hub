import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendUserMessage,
  initialRunState,
  reduceRunEvent,
  type RunState,
} from '../src/store/runReducer.js';
import type { ProtocolEvent } from '../src/generated/events.js';

/**
 * runReducer 是前端唯一的"业务逻辑"，其余都是渲染。
 * 因此这里把它当纯函数彻底测一遍，包括用【真实录制的事件流】回放 —— 与 runtime 的
 * 契约测试读同一个文件，三端被同一份数据钉住。
 */

const ev = (event: Partial<ProtocolEvent> & { type: string }): ProtocolEvent =>
  ({ runId: 'r1', ts: '2026-01-01T00:00:00.000Z', nodeId: null, ...event }) as ProtocolEvent;

const fold = (events: ProtocolEvent[], from: RunState = initialRunState): RunState =>
  events.reduce(reduceRunEvent, from);

describe('runReducer：状态迁移', () => {
  it('run.started 把状态推到 running', () => {
    const state = fold([
      ev({
        type: 'run.started',
        payload: { model: { provider: 'scripted', name: 'x', mode: 'scripted' } },
      }),
    ]);
    expect(state.status).toBe('running');
    expect(state.events).toHaveLength(1);
  });

  it('node.started / node.finished 驱动画布节点状态灯', () => {
    const state = fold([
      ev({ type: 'node.started', nodeId: 'n1', payload: { nodeType: 'start', label: '开始' } }),
      ev({ type: 'node.finished', nodeId: 'n1', payload: { nodeType: 'start', durationMs: 3, status: 'ok' } }),
      ev({ type: 'node.started', nodeId: 'n3', payload: { nodeType: 'llm', label: '大模型' } }),
      ev({ type: 'node.finished', nodeId: 'n3', payload: { nodeType: 'llm', durationMs: 9, status: 'error' } }),
    ]);
    expect(state.nodeState).toEqual({ n1: 'ok', n3: 'error' });
  });

  it('llm.token 逐片累积成流式文本', () => {
    const state = fold([
      ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: '你' } }),
      ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: '好' } }),
      ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: '世界' } }),
    ]);
    expect(state.streamingText).toBe('你好世界');
  });

  it('message.completed 定稿文本并清空流式缓冲', () => {
    const state = fold([
      ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: '半截' } }),
      ev({ type: 'message.completed', nodeId: 'n3', payload: { role: 'assistant', content: '完整回答' } }),
    ]);
    expect(state.streamingText).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe('完整回答');
  });

  it('工具调用轮落成一张卡片，而不是空白气泡', () => {
    const state = fold([
      ev({
        type: 'message.completed',
        nodeId: 'n3',
        payload: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'calculator', args: { expression: '1+1' } }],
        },
      }),
    ]);
    expect(state.messages[0]?.kind).toBe('tool-turn');
    expect(state.messages[0]?.content).toBe('');
  });

  it('tool.started / tool.finished 按 callId 配对', () => {
    const state = fold([
      ev({
        type: 'tool.started',
        nodeId: 'n3',
        payload: { toolName: 'calculator', callId: 'c1', args: { expression: '1+1' } },
      }),
      ev({
        type: 'tool.started',
        nodeId: 'n3',
        payload: { toolName: 'http_get', callId: 'c2', args: { url: 'https://example.com' } },
      }),
      ev({
        type: 'tool.finished',
        nodeId: 'n3',
        payload: {
          toolName: 'calculator',
          callId: 'c1',
          durationMs: 2,
          result: '1+1 = 2',
          isError: false,
          truncated: false,
        },
      }),
    ]);
    expect(state.tools).toHaveLength(2);
    expect(state.tools[0]).toMatchObject({ callId: 'c1', done: true, result: '1+1 = 2' });
    expect(state.tools[1]).toMatchObject({ callId: 'c2', done: false });
  });

  it('llm.completed 累加 token 用量', () => {
    const state = fold([
      ev({
        type: 'llm.completed',
        nodeId: 'n3',
        payload: { model: 'm', inputTokens: 10, outputTokens: 5, durationMs: 1 },
      }),
      ev({
        type: 'llm.completed',
        nodeId: 'n3',
        payload: { model: 'm', inputTokens: 20, outputTokens: 8, durationMs: 1 },
      }),
    ]);
    expect(state.usage).toEqual({ inputTokens: 30, outputTokens: 13, llmCalls: 2 });
  });

  it('run.error 保留已经流出来的部分内容，不让它凭空消失', () => {
    const state = fold([
      ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: '已经说了一半' } }),
      ev({
        type: 'run.error',
        payload: { code: 'MODEL_ERROR', message: '上游 500', retryable: true },
      }),
    ]);
    expect(state.error).toMatchObject({ code: 'MODEL_ERROR', retryable: true });
    expect(state.messages[0]?.content).toBe('已经说了一半');
    expect(state.streamingText).toBe('');
  });

  it('run.finished 收口状态并把 totals 补全', () => {
    const state = fold([
      ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: '最后一句' } }),
      ev({
        type: 'run.finished',
        payload: { status: 'SUCCEEDED', durationMs: 42, totals: { toolCalls: 1 } },
      }),
    ]);
    expect(state.status).toBe('succeeded');
    expect(state.durationMs).toBe(42);
    // 契约里 totals 各字段可选，UI 统一补 0
    expect(state.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      toolCalls: 1,
      steps: 0,
    });
    expect(state.messages.at(-1)?.content).toBe('最后一句');
  });

  it('FAILED 终态同样收敛', () => {
    const state = fold([ev({ type: 'run.finished', payload: { status: 'FAILED', durationMs: 5 } })]);
    expect(state.status).toBe('failed');
  });

  it('纯函数：不修改传入的 state', () => {
    const before = appendUserMessage(initialRunState, '你好');
    const snapshot = JSON.stringify(before);
    reduceRunEvent(before, ev({ type: 'llm.token', nodeId: 'n3', payload: { delta: 'x' } }));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('未知事件类型不会污染状态', () => {
    const state = fold([{ type: 'something.else', runId: 'r', ts: 't', nodeId: null, payload: {} } as never]);
    expect(state.status).toBe('idle');
    expect(state.events).toHaveLength(1);
  });
});

describe('runReducer：回放真实录制的事件流', () => {
  it('把 contracts/fixtures/events.jsonl 完整回放一遍，得到自洽的终态', () => {
    const fixture = resolve(import.meta.dirname, '..', '..', 'contracts', 'fixtures', 'events.jsonl');
    const events = readFileSync(fixture, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProtocolEvent);

    expect(events.length).toBeGreaterThan(10);

    const state = fold(events);

    expect(state.status).toBe('succeeded');
    expect(state.events).toHaveLength(events.length);
    // 四个画布节点最终都应该是 ok
    expect(Object.values(state.nodeState).every((s) => s === 'ok')).toBe(true);
    expect(Object.keys(state.nodeState).sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
    // 一次工具调用，成功
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ toolName: 'calculator', done: true, isError: false });
    expect(state.tools[0]?.result).toContain('= 60');
    // 流式内容全部定稿，最终答案完整
    expect(state.streamingText).toBe('');
    const last = state.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toContain('(12+8)*3 = 60');
    // 用量被累加
    expect(state.usage?.llmCalls).toBe(2);
  });
});
