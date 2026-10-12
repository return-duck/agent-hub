/**
 * 启动时的模型自检。
 *
 * 为什么需要它：DeepSeek 的模型名会轮换 —— `deepseek-chat` / `deepseek-reasoner`
 * 会随着版本变化（@langchain/deepseek 的 profiles 里就有四个不同的名字）。
 * 如果配置里写了一个已经不存在的模型名，症状是"每次运行都失败、错误来自上游 400"，
 * 排查成本很高。这里在启动时主动调一次 /models，把可用列表打出来。
 *
 * 刻意设计成**不阻塞启动**：查不通只告警，服务照常起来
 * （模型列表接口本身也可能变更或临时不可用，不能让它决定服务能否启动）。
 */
import type { RuntimeConfig } from '../config.js';
import { resolveModelMode } from '../config.js';

export interface PreflightResult {
  checked: boolean;
  available: string[];
  configuredModelAvailable: boolean | null;
  note?: string;
}

const TIMEOUT_MS = 8000;

export async function checkModelAvailability(config: RuntimeConfig): Promise<PreflightResult> {
  if (resolveModelMode(config) !== 'live' || !config.model.baseUrl) {
    return { checked: false, available: [], configuredModelAvailable: null };
  }

  const url = `${config.model.baseUrl.replace(/\/$/, '')}/models`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.model.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        checked: false,
        available: [],
        configuredModelAvailable: null,
        note: `模型列表接口返回 HTTP ${response.status}，跳过自检（不影响启动）`,
      };
    }

    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const available = (body.data ?? [])
      .map((item) => (typeof item?.id === 'string' ? item.id : undefined))
      .filter((id): id is string => Boolean(id));

    return {
      checked: true,
      available,
      configuredModelAvailable: available.length > 0 ? available.includes(config.model.name) : null,
    };
  } catch (error) {
    return {
      checked: false,
      available: [],
      configuredModelAvailable: null,
      note: `无法访问模型列表：${error instanceof Error ? error.message : String(error)}（不影响启动）`,
    };
  }
}

/** 把自检结果打印成人能看懂的启动日志 */
export function reportPreflight(config: RuntimeConfig, result: PreflightResult): void {
  if (!result.checked) {
    if (result.note) console.warn(`[runtime] ${result.note}`);
    return;
  }
  if (result.configuredModelAvailable === false) {
    console.warn(
      `[runtime] ⚠ 配置的模型 "${config.model.name}" 不在账号可用模型列表里：${result.available.join(', ')}\n` +
        '[runtime]   请把 MODEL_NAME 改成上面之一（DeepSeek 的模型名会轮换，旧名可能已下线）',
    );
    return;
  }
  console.log(`[runtime] 可用模型：${result.available.join(', ')}（当前使用 ${config.model.name}）`);
}
