/**
 * 消息文本归一化。
 *
 * LangChain 的 message.content 可能是 string，也可能是 ContentBlock[]（多模态/新协议），
 * 事件映射器、上下文裁剪、脚本化模型三处都需要同一套归一化逻辑，所以单独放这里。
 */
import type { BaseMessage } from '@langchain/core/messages';

export function contentToText(message: BaseMessage | undefined | null): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** 粗略 token 估算：4 字符 ≈ 1 token。没有 tokenizer 时的诚实降级，并明确标注为估算。 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
