/**
 * 内置脚本化模型：确定性、零凭证，让整条链路（编译 → 工具循环 → 流式输出 → 事件落库）
 * 在没有 API key 的情况下也能跑通并被测试。
 *
 * 三个来自 M1 spike 的硬事实（都已在本文件落实，别改成"看起来更简洁"的写法）：
 *  1) BaseChatModel._streamIterator 只发 handleChatModelStart / handleLLMEnd，
 *     【不会】自己发 token 回调 —— 必须由 _streamResponseChunks 调 runManager.handleLLMNewToken，
 *     否则 streamEvents 里根本没有 on_chat_model_stream，前端就没有逐字流式。
 *  2) yield 的必须是 ChatGenerationChunk 实例：_streamIterator 会在第二个 chunk 上调用 .concat()，
 *     直接 yield 普通对象会抛 "generationChunk.concat is not a function"。
 *  3) ":" 是 LangGraph 节点名的保留字符，节点名统一用 "__" 连接。
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { contentToText, estimateTokens } from '../util/messageText.js';

const STREAM_PIECE_CHARS = 6;

type Decision =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'text'; text: string };

export interface ScriptedChatModelFields {
  tools?: StructuredToolInterface[];
  temperature?: number;
}

export class ScriptedChatModel extends BaseChatModel {
  readonly tools: StructuredToolInterface[];
  private callCounter = 0;

  constructor(fields: ScriptedChatModelFields = {}) {
    super({ temperature: fields.temperature ?? 0 } as never);
    this.tools = fields.tools ?? [];
  }

  override _llmType(): string {
    return 'scripted';
  }

  override bindTools(tools: StructuredToolInterface[]): Runnable<BaseMessage[], AIMessageChunk> {
    return new ScriptedChatModel({ tools, temperature: 0 }) as unknown as Runnable<BaseMessage[], AIMessageChunk>;
  }

  private lastHumanText(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as BaseMessage;
      if (message instanceof HumanMessage) return contentToText(message);
    }
    return '';
  }

  private decide(messages: BaseMessage[]): Decision {
    const toolResults = messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    if (this.tools.length > 0 && toolResults.length === 0) {
      const chosen = this.tools[0] as StructuredToolInterface;
      const conversation = messages.map(contentToText).join('\n');
      if (chosen.name === 'calculator') {
        return { kind: 'tool', name: chosen.name, args: { expression: pickExpression(conversation) } };
      }
      if (chosen.name === 'http_get') {
        return { kind: 'tool', name: chosen.name, args: { url: pickUrl(conversation) } };
      }
      return { kind: 'tool', name: chosen.name, args: {} };
    }
    return { kind: 'text', text: this.composeAnswer(messages, toolResults) };
  }

  private composeAnswer(messages: BaseMessage[], toolResults: ToolMessage[]): string {
    if (toolResults.length > 0) {
      const summary = toolResults.map((m) => contentToText(m)).join('；');
      return [
        `我调用了工具，得到结果：${summary}。`,
        '',
        '这是内置脚本化模型的回答 —— 它没有真实推理能力，存在的意义是让整条链路',
        '（图编译 → 工具循环 → 流式输出 → 事件落库 → 前端逐字渲染）在没有任何 API key 的',
        '情况下也能跑通、可复现、可测试。',
        '',
        '在 runtime/.env 里填入 OPENAI_API_KEY 并把 MODEL_PROVIDER 设为 openai，',
        '同一个 agent 就会改用真实模型，图与代码都不需要改动。',
      ].join('\n');
    }
    const human = this.lastHumanText(messages);
    return [
      human ? `我收到了你的输入：「${human}」。` : '我收到了本轮输入。',
      '',
      '当前使用内置脚本化模型（未配置 API key），它会：',
      '1. 当 LLM 节点绑定了工具时，先发起一次真实的工具调用（前端能看到 tool.started / tool.finished）；',
      '2. 拿到工具结果后，把最终答案切成小片流式吐出，驱动前端的逐字渲染。',
    ].join('\n');
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const decision = this.decide(messages);
    if (decision.kind === 'tool') {
      const message = new AIMessage({
        content: '',
        tool_calls: [{ name: decision.name, args: decision.args, id: this.nextCallId() }],
      });
      return { generations: [{ text: '', message }] };
    }
    const message = new AIMessage(decision.text);
    return { generations: [{ text: decision.text, message }] };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options?: unknown,
    runManager?: { handleLLMNewToken?: (token: string) => Promise<void> | void },
  ): AsyncGenerator<ChatGenerationChunk> {
    const decision = this.decide(messages);

    if (decision.kind === 'tool') {
      const callId = this.nextCallId();
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              name: decision.name,
              args: JSON.stringify(decision.args),
              id: callId,
              index: 0,
              type: 'tool_call_chunk',
            },
          ],
        }),
      });
      return;
    }

    const inputText = messages.map(contentToText).join('\n');
    const pieces = splitIntoPieces(decision.text);
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(decision.text);

    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] as string;
      const isLast = i === pieces.length - 1;
      // 事实 1：必须自己上报 token 回调，否则不会有 on_chat_model_stream
      await runManager?.handleLLMNewToken?.(piece);
      yield new ChatGenerationChunk({
        text: piece,
        // 事实 2：必须是 ChatGenerationChunk 实例
        message: new AIMessageChunk({
          content: piece,
          ...(isLast
            ? {
                usage_metadata: {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                },
              }
            : {}),
        }),
      });
    }
  }

  private nextCallId(): string {
    this.callCounter += 1;
    return `call_scripted_${this.callCounter}`;
  }
}

export function splitIntoPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += STREAM_PIECE_CHARS) {
    pieces.push(text.slice(i, i + STREAM_PIECE_CHARS));
  }
  return pieces.length > 0 ? pieces : [''];
}

/** 从对话里挑一个可计算的表达式；挑不到就用固定算式，保证脚本化模型始终确定性可跑。 */
function pickExpression(conversation: string): string {
  const candidates = conversation.match(/[(]?-?\d[\d\s.+\-*/%()^]{1,40}/g);
  if (candidates) {
    for (const candidate of candidates) {
      const trimmed = candidate.trim().replace(/[+\-*/%^.\s]+$/, '');
      if (/\d/.test(trimmed) && /[+\-*/%^]/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return '6*7';
}

function pickUrl(conversation: string): string {
  const match = conversation.match(/https?:\/\/[^\s"'<>)\]]+/);
  return match ? match[0] : 'https://example.com';
}
