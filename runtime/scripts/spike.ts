/**
 * M1 Spike：用最小的例子确认【实际装出来的版本】的 API 形态，不靠记忆。
 * 运行： npm run spike
 *
 * 这个脚本刻意按"将来真正要写的实现"来写，因此它同时是设计验证：
 *  1) 自定义 BaseChatModel 只实现 _generate / _streamResponseChunks 是否够用（不覆写 invoke/stream）
 *  2) streamEvents(v2) 的真实事件名与 data 形状
 *  3) tool_call_chunks 经过 concat 累积后能否还原出 tool_calls（决定 ToolNode 能否工作）
 *  4) prebuilt 的 toolsCondition 是否硬编码了节点名 "tools"（决定我们能否自己写路由）
 *  5) 节点名不允许含 ":"（已确认），改用 "__" 作为画布节点与内部节点的分隔符
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import type { Runnable } from '@langchain/core/runnables';

const report: string[] = [];
const ok = (label: string, value: unknown) => report.push(`  ${label}: ${value}`);

/** 真实实现里的做法：工具调用用 AIMessageChunk 的 tool_call_chunks 表达 */
class ScriptedChatModel extends BaseChatModel {
  tools: any[];
  pendingText = '答案是 42，这是一段刻意分片输出的最终回答。';

  constructor(fields: any = {}) {
    super(fields);
    this.tools = fields.tools ?? [];
  }

  _llmType() {
    return 'scripted-spike';
  }

  override bindTools(tools: any[]): Runnable<any, any> {
    return new ScriptedChatModel({ tools }) as any;
  }

  private decide(messages: BaseMessage[]): { kind: 'tool' | 'text'; text: string } {
    const sawToolResult = messages.some((m) => m instanceof ToolMessage);
    if (this.tools.length > 0 && !sawToolResult) {
      return { kind: 'tool', text: '' };
    }
    return { kind: 'text', text: this.pendingText };
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const d = this.decide(messages);
    if (d.kind === 'tool') {
      const message = new AIMessage({
        content: '',
        tool_calls: [{ name: this.tools[0].name, args: { expression: '6*7' }, id: 'call_gen_1' }],
      });
      return { generations: [{ text: '', message }] };
    }
    const message = new AIMessage(d.text);
    return { generations: [{ text: d.text, message }] };
  }

  // 关键事实：BaseChatModel._streamIterator 只发 handleChatModelStart / handleLLMEnd，
  // 不会自己发 token 回调 —— 必须由 _streamResponseChunks 用 runManager.handleLLMNewToken 上报，
  // 否则 streamEvents 里根本没有 on_chat_model_stream，前端也就没有 token 级流式。
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options?: any,
    runManager?: any,
  ): AsyncGenerator<ChatGenerationChunk> {
    const d = this.decide(messages);
    if (d.kind === 'tool') {
      // 必须是 ChatGenerationChunk 实例：_streamIterator 会在第二个 chunk 上调用 .concat()
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              name: this.tools[0].name,
              args: JSON.stringify({ expression: '6*7' }),
              id: 'call_chunk_1',
              index: 0,
              type: 'tool_call_chunk',
            },
          ],
        }),
      });
      return;
    }
    for (const piece of d.text.split('，')) {
      await runManager?.handleLLMNewToken(piece);
      yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
    }
  }
}

async function main() {
  report.push('=== 1. 模块导出检查 ===');
  const lg = (await import('@langchain/langgraph')) as Record<string, unknown>;
  const prebuilt = (await import('@langchain/langgraph/prebuilt')) as Record<string, unknown>;
  const StateGraph = lg.StateGraph as any;
  const Annotation = lg.Annotation as any;
  const START = lg.START as any;
  const END = lg.END as any;
  const messagesStateReducer = lg.messagesStateReducer as any;
  const ToolNode = prebuilt.ToolNode as any;
  const toolsCondition = prebuilt.toolsCondition as any;

  ok('messagesStateReducer', typeof messagesStateReducer);
  ok('ToolNode / toolsCondition', `${typeof ToolNode} / ${typeof toolsCondition}`);
  ok('MemorySaver / Command / GraphRecursionError',
    `${typeof lg.MemorySaver} / ${typeof lg.Command} / ${typeof lg.GraphRecursionError}`);

  report.push('');
  report.push('=== 2. toolsCondition 是否硬编码节点名 ===');
  report.push(toolsCondition.toString().split('\n').slice(0, 12).map((l: string) => '    ' + l).join('\n'));

  report.push('');
  report.push('=== 3. 自定义模型 + 工具循环 ===');
  const calc = tool(async (input: { expression: string }) => `计算 ${input.expression} = 42`, {
    name: 'calculator',
    description: '计算数学表达式',
    schema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    } as any,
  });

  const model = new ScriptedChatModel({});
  const bound = model.bindTools([calc]) as any;
  ok('bindTools 返回', bound.constructor.name);

  const AgentState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: messagesStateReducer,
      default: () => [],
    }),
  });

  // 画布节点 id 假设为 "n3"；内部节点用 "__" 分隔（":" 被 LangGraph 禁止）
  const MODEL = 'n3__model';
  const TOOLS = 'n3__tools';
  const routerLog: string[] = [];

  const graph = new StateGraph(AgentState)
    .addNode(MODEL, async (state: any) => {
      let acc: AIMessageChunk | null = null;
      for await (const chunk of await bound.stream(state.messages)) {
        acc = acc ? acc.concat(chunk) : chunk;
      }
      const toolCalls = (acc as any)?.tool_calls ?? [];
      ok('累积后 tool_calls', JSON.stringify(toolCalls));
      return { messages: [new AIMessage({ content: acc?.content ?? '', tool_calls: toolCalls })] };
    })
    .addNode(TOOLS, new ToolNode([calc]))
    .addEdge(START, MODEL)
    .addConditionalEdges(
      MODEL,
      (state: any) => {
        const last = state.messages[state.messages.length - 1] as AIMessage;
        const next = (last?.tool_calls?.length ?? 0) > 0 ? TOOLS : END;
        routerLog.push(`${JSON.stringify(last?.tool_calls ?? [])} -> ${next}`);
        return next;
      },
      [TOOLS, END],
    )
    .addEdge(TOOLS, MODEL)
    .compile();

  report.push('');
  report.push('=== 4. streamEvents(v2) 事件形状（每种只打第一条） ===');
  const seen = new Map<string, string>();
  const stream = graph.streamEvents(
    { messages: [new AIMessage({ content: '帮我算 6*7' })] },
    { version: 'v2', recursionLimit: 25 },
  );
  for await (const ev of stream as any) {
    const name = ev.event as string;
    if (!seen.has(name)) {
      let shape = '';
      try {
        shape = JSON.stringify(ev.data)?.slice(0, 260) ?? '';
      } catch {
        shape = '<unserializable>';
      }
      seen.set(name, shape);
      report.push(`  [${name}]`);
      report.push(`      name=${ev.name}  langgraph_node=${ev.metadata?.langgraph_node ?? '-'}`);
      report.push(`      data=${shape}`);
    }
  }

  report.push('');
  report.push('=== 5. 事实汇总 ===');
  report.push('  出现过的事件名: ' + [...seen.keys()].sort().join(', '));
  report.push('  路由决策: ' + routerLog.join(' | '));

  console.log(report.join('\n'));
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e);
  console.error(report.join('\n'));
  process.exit(1);
});
