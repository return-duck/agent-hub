/**
 * 模型工厂：把"用哪个模型"收敛到一个地方，Agent 定义里不出现 provider 细节。
 *
 * 降级策略是刻意的：声明了 openai 但没给 key 时，不报错、不静默失败，
 * 而是降级到脚本化模型并在 /healthz 与 run.started 事件里如实标注 mode=scripted，
 * 前端据此显示横幅。这样"能不能跑起来"永远不取决于有没有 key。
 *
 * 工具不在这里绑定：不同 LLM 节点可以绑不同工具，绑定动作发生在编译每个节点时
 * （见 compiler/nodes.ts），这样"一个模型实例 + 按节点 bindTools"才是正确的作用域。
 */
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { resolveModelMode, type ModelMode, type RuntimeConfig } from '../config.js';
import { ScriptedChatModel } from './scripted.js';

export interface ModelBundle {
  model: BaseChatModel;
  provider: string;
  name: string;
  mode: ModelMode;
  /** 降级原因，非空时会在启动日志与 /healthz 里暴露 */
  fallbackReason?: string;
}

export function createModelBundle(config: RuntimeConfig): ModelBundle {
  const mode = resolveModelMode(config);

  if (mode === 'live') {
    const model = new ChatOpenAI({
      model: config.model.name,
      temperature: config.model.temperature,
      apiKey: config.model.apiKey,
      ...(config.model.baseUrl ? { configuration: { baseURL: config.model.baseUrl } } : {}),
    });
    return { model, provider: config.model.provider, name: config.model.name, mode };
  }

  const fallbackReason =
    config.model.provider === 'openai' && !config.model.apiKey
      ? 'MODEL_PROVIDER=openai 但未设置 OPENAI_API_KEY，已降级为内置脚本化模型'
      : undefined;

  return {
    model: new ScriptedChatModel(),
    provider: 'scripted',
    name: config.model.name,
    mode: 'scripted',
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}
