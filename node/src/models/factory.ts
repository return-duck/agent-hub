/**
 * 模型工厂：把"用哪个模型"收敛到一个地方。
 *
 * 平台级统一：所有 agent 共用这里配置的**同一个** DeepSeek 模型 ——
 * Agent 定义（画布图）里不出现 provider / model / key 的任何痕迹，
 * 换模型只改 runtime 的环境变量，图和代码都不用动。
 *
 * 降级策略是刻意的：声明了真实 provider 但没给 key 时不报错、不静默失败，
 * 而是降级到脚本化模型，并在 /healthz 与 run.started 事件里如实标注 mode=scripted，
 * 前端据此显示横幅。这样"能不能跑起来"永远不取决于有没有 key。
 *
 * 工具不在这里绑定：不同 LLM 节点可以绑不同工具，绑定动作发生在编译每个节点时
 * （见 compiler/nodes.ts），这样"一个模型实例 + 按节点 bindTools"才是正确的作用域。
 */
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  fallbackReason,
  resolveModelMode,
  type ModelMode,
  type RuntimeConfig,
} from '../config.js';
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
    const { provider, name, temperature, apiKey, baseUrl, extraParams, streamUsage } = config.model;
    const common = {
      model: name,
      temperature,
      apiKey,
      // streamUsage 打开后 DeepSeek 会返回真实 token 用量，前端就不用显示"估算"
      streamUsage,
      ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
      ...(Object.keys(extraParams).length > 0 ? { modelKwargs: extraParams } : {}),
    };

    if (provider === 'deepseek') {
      // ChatDeepSeek 继承自 ChatOpenAICompletions：
      // token 级流式回调（on_chat_model_stream）与 bindTools 都由基类负责
      // （基类在 _streamResponseChunks 里显式调用 runManager.handleLLMNewToken），
      // 它另外处理了 reasoning_content，并自带 baseURL 默认值。
      return { model: new ChatDeepSeek(common), provider, name, mode };
    }

    // provider === 'openai'：保留的逃生通道，用于任何 OpenAI 兼容网关
    return { model: new ChatOpenAI(common), provider, name, mode };
  }

  const reason = fallbackReason(config);
  return {
    model: new ScriptedChatModel(),
    provider: 'scripted',
    name: 'scripted-deterministic-v1',
    mode: 'scripted',
    ...(reason ? { fallbackReason: reason } : {}),
  };
}
