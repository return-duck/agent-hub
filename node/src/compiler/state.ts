/**
 * LangGraph 的统一 State。
 *
 * messages 用官方的 messagesStateReducer（追加 + 按 id 去重更新），
 * 这是工具消息回填能正确覆盖同 id 消息的前提。
 * scratchpad 用浅合并（节点间传值），input 用覆盖（入口数据不参与累积）。
 */
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  input: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  scratchpad: Annotation<Record<string, unknown>>({
    reducer: (previous, next) => ({ ...previous, ...next }),
    default: () => ({}),
  }),
});

export type AgentStateType = typeof AgentState.State;
