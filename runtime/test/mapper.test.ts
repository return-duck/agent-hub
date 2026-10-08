import { describe, expect, it } from 'vitest';
import { EventMapper } from '../src/events/mapper.js';
import type { CanvasNodeInfo } from '../src/compiler/compile.js';

/**
 * 事件映射器是纯函数：输入 LangChain 事件对象，输出协议事件数组。
 * 下面这些 fixture 的形状全部来自 M1 spike 对真实 streamEvents 输出的观测
 * （见 scripts/spike.ts），不是凭想象的。
 */

const nodeIndex = new Map<string, CanvasNodeInfo>([
  ['n1', { canvasNodeId: 'n1', nodeType: 'start', label: '开始' }],
  ['n3__model', { canvasNodeId: 'n3', nodeType: 'llm', label: '大模型' }],
  ['n3__tools', { canvasNodeId: 'n3', nodeType: 'llm', label: '大模型' }],
  ['n4', { canvasNodeId: 'n4', nodeType: 'end', label: '结束' }],
]);

function makeMapper(toolResultMaxChars = 2000): EventMapper {
  return new EventMapper({ runId: 'r1', nodeIndex, modelName: 'scripted/x', toolResultMaxChars });
}

const chainStart = (name: string, langgraphNode = name): Record<string, unknown> => ({
  event: 'on_chain_start',
  name,
  run_id: `run-${name}`,
  metadata: { langgraph_node: langgraphNode },
  data: { input: {} },
});

const chainEnd = (name: string, messages?: unknown[], langgraphNode = name): Record<string, unknown> => ({
  event: 'on_chain_end',
  name,
  run_id: `run-${name}`,
  metadata: { langgraph_node: langgraphNode },
  data: { output: messages === undefined ? {} : { messages } },
});

describe('事件映射器：节点生命周期', () => {
  it('忽略根图与 __start__ 这类伪节点', () => {
    const mapper = makeMapper();
    expect(mapper.map(chainStart('LangGraph', ''))).toEqual([]);
    expect(mapper.map(chainStart('__start__'))).toEqual([]);
    expect(mapper.map(chainEnd('__start__'))).toEqual([]);
  });

  it('回归：节点内部包裹的 RunnableLambda 不能当成画布节点（会导致提前 node.finished、节点闪烁）', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));

    // 这一条曾经被误判成 n3 结束
    const viaLambda = mapper.map(
      chainEnd('RunnableLambda', [{ tool_calls: [] }], 'n3__model'),
    );
    expect(viaLambda).toEqual([]);
  });

  it('LLM 节点的 model / tools 两个内部节点只宣告一次 node.started', () => {
    const mapper = makeMapper();
    expect(mapper.map(chainStart('n3__model')).map((e) => e.type)).toEqual(['node.started']);
    expect(mapper.map(chainStart('n3__tools'))).toEqual([]);
  });

  it('模型这一轮还有 tool_calls 时，画布上的 LLM 节点不算做完', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    const end = mapper.map(
      chainEnd('n3__model', [{ tool_calls: [{ name: 'calculator', args: {}, id: 'c1' }] }]),
    );
    expect(end).toEqual([]);
  });

  it('模型这一轮没有 tool_calls 时才发 node.finished，且耗时非负', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    mapper.map(chainEnd('n3__tools'));
    const end = mapper.map(chainEnd('n3__model', [{ tool_calls: [] }]));
    expect(end).toHaveLength(1);
    expect(end[0]?.type).toBe('node.finished');
    expect(end[0]).toMatchObject({ nodeId: 'n3', payload: { status: 'ok' } });
    expect((end[0]?.payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('不变量：finishOpenNodes 会把没配对的 node.started 补齐（UI 不会永久转圈）', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n1'));
    mapper.map(chainStart('n3__model'));
    const closed = mapper.finishOpenNodes('error');
    expect(closed.map((e) => [e.type, e.nodeId])).toEqual([
      ['node.finished', 'n1'],
      ['node.finished', 'n3'],
    ]);
    expect(closed.every((e) => (e.payload as { status: string }).status === 'error')).toBe(true);
    // 清理后不会重复补
    expect(mapper.finishOpenNodes('ok')).toEqual([]);
  });
});

describe('事件映射器：token 与模型调用', () => {
  const chatStream = (content: unknown): Record<string, unknown> => ({
    event: 'on_chat_model_stream',
    name: 'ScriptedChatModel',
    run_id: 'chat-1',
    metadata: { langgraph_node: 'n3__model' },
    data: { chunk: { content } },
  });

  it('把 chunk 转成 llm.token，并归一化 ContentBlock[] 形式的 content', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    expect(mapper.map(chatStream('你好'))).toMatchObject([
      { type: 'llm.token', nodeId: 'n3', payload: { delta: '你好' } },
    ]);
    expect(mapper.map(chatStream([{ type: 'text', text: '世界' }]))).toMatchObject([
      { type: 'llm.token', payload: { delta: '世界' } },
    ]);
  });

  it('跳过空 delta，避免灌入无意义事件', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    expect(mapper.map(chatStream(''))).toEqual([]);
    expect(mapper.map(chatStream([]))).toEqual([]);
  });

  it('从 usage_metadata 取真实 token 数', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    const events = mapper.map({
      event: 'on_chat_model_end',
      name: 'ScriptedChatModel',
      run_id: 'chat-1',
      metadata: { langgraph_node: 'n3__model' },
      data: {
        input: { messages: [[{ content: 'hi' }]] },
        output: {
          content: '答案',
          usage_metadata: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          response_metadata: { finish_reason: 'stop' },
        },
      },
    });
    expect(events.map((e) => e.type)).toEqual(['llm.completed', 'message.completed']);
    expect(events[0]?.payload).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      finishReason: 'stop',
    });
    expect((events[0]?.payload as { model: string }).model).not.toContain('估算');
    expect(mapper.totals).toMatchObject({ llmCalls: 1, inputTokens: 11, outputTokens: 7 });
  });

  it('没有 usage 时降级为估算，并在 model 字段里如实标注', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    const events = mapper.map({
      event: 'on_chat_model_end',
      name: 'ScriptedChatModel',
      run_id: 'chat-1',
      metadata: { langgraph_node: 'n3__model' },
      data: { input: { messages: [] }, output: { content: '一二三四五六七八' } },
    });
    expect((events[0]?.payload as { model: string }).model).toContain('估算');
    expect((events[0]?.payload as { inputTokens: number }).inputTokens).toBeGreaterThan(0);
  });

  it('工具调用轮（content 为空但有 tool_calls）也产出 message.completed 以便落库', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__model'));
    const events = mapper.map({
      event: 'on_chat_model_end',
      name: 'ScriptedChatModel',
      run_id: 'chat-1',
      metadata: { langgraph_node: 'n3__model' },
      data: {
        input: { messages: [] },
        output: { content: '', tool_calls: [{ name: 'calculator', args: { expression: '1+1' }, id: 'c1' }] },
      },
    });
    const message = events.find((e) => e.type === 'message.completed');
    expect(message?.payload).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ name: 'calculator', id: 'c1' }],
    });
  });
});

describe('事件映射器：工具调用', () => {
  const toolStart = (runId: string, input: unknown, name = 'calculator'): Record<string, unknown> => ({
    event: 'on_tool_start',
    name,
    run_id: runId,
    metadata: { langgraph_node: 'n3__tools' },
    data: { input },
  });

  const toolEnd = (
    runId: string,
    output: unknown,
    name = 'calculator',
  ): Record<string, unknown> => ({
    event: 'on_tool_end',
    name,
    run_id: runId,
    metadata: { langgraph_node: 'n3__tools' },
    data: { output },
  });

  it('tool.started / tool.finished 成对，并统计次数', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__tools'));
    const started = mapper.map(toolStart('t1', { expression: '1+1' }));
    expect(started).toMatchObject([
      { type: 'tool.started', nodeId: 'n3', payload: { toolName: 'calculator', callId: 't1', args: { expression: '1+1' } } },
    ]);

    const finished = mapper.map(toolEnd('t1', { content: '1+1 = 2', status: 'success' }));
    expect(finished).toMatchObject([
      {
        type: 'tool.finished',
        payload: { toolName: 'calculator', callId: 't1', result: '1+1 = 2', isError: false, truncated: false },
      },
    ]);
    expect(mapper.totals.toolCalls).toBe(1);
  });

  it('按内容长度截断工具结果并打上标记', () => {
    const mapper = makeMapper(10);
    mapper.map(chainStart('n3__tools'));
    mapper.map(toolStart('t1', {}));
    const events = mapper.map(toolEnd('t1', { content: 'x'.repeat(100), status: 'success' }));
    const payload = events[0]?.payload as { result: string; truncated: boolean };
    expect(payload.truncated).toBe(true);
    // 保留 maxChars 个字符，再追加截断标记
    expect(payload.result.startsWith('x'.repeat(10))).toBe(true);
    expect(payload.result.endsWith('…[已截断]')).toBe(true);
    expect(payload.result.length).toBeLessThan(100);
  });

  it('工具报错时 isError=true 且带上错误文本（不炸循环，回灌给模型）', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__tools'));
    mapper.map(toolStart('t1', {}));
    const events = mapper.map({
      event: 'on_tool_error',
      name: 'calculator',
      run_id: 't1',
      metadata: { langgraph_node: 'n3__tools' },
      data: { error: new Error('除数为 0') },
    });
    expect(events).toMatchObject([{ type: 'tool.finished', payload: { isError: true, result: '除数为 0' } }]);
  });

  it('output 里 status=error 时也算失败', () => {
    const mapper = makeMapper();
    mapper.map(chainStart('n3__tools'));
    mapper.map(toolStart('t1', {}));
    const events = mapper.map(toolEnd('t1', { content: '炸了', status: 'error' }));
    expect((events[0]?.payload as { isError: boolean }).isError).toBe(true);
  });
});
