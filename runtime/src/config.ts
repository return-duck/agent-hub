/**
 * 运行时配置。刻意手写一个极小的 .env 读取器（不引第三方依赖），
 * 这样 `tsx` / `node` / 测试三种启动方式行为一致。
 *
 * 模型策略（平台级统一，Agent 定义里不出现 provider 细节）：
 *   - 默认 provider = deepseek，所有 agent 共用同一个平台配置的模型；
 *   - 没有 key 时自动降级到内置脚本化模型，保证"零凭证也能跑通全链路与 CI"；
 *   - provider 只影响 runtime 内部，画布图与前端完全不需要知道用的是谁。
 *
 * 安全约定：API key 只存在于 runtime 进程，server 只传模型名，日志里永不打印 key。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ModelProvider = 'deepseek' | 'openai' | 'scripted';
export type ModelMode = 'scripted' | 'live';

export interface RuntimeConfig {
  host: string;
  port: number;
  model: {
    provider: ModelProvider;
    name: string;
    baseUrl: string | undefined;
    apiKey: string | undefined;
    temperature: number;
    /** 透传给 provider 的额外参数（JSON），用于库还没跟上的新参数 */
    extraParams: Record<string, unknown>;
    /** 流式请求是否索要 usage（DeepSeek/OpenAI 都支持 stream_options.include_usage） */
    streamUsage: boolean;
  };
  /** 每次模型调用前允许的最大上下文字符预算（约 4 字符 = 1 token） */
  maxContextChars: number;
  toolTimeoutMs: number;
  toolResultMaxChars: number;
  toolHttpAllowlist: string[];
}

/**
 * 各 provider 的默认配置。
 *
 * 注意：DeepSeek 的模型名会轮换 —— `deepseek-chat` / `deepseek-reasoner` 已是旧名，
 * 以 @langchain/deepseek 自带的能力档案（profiles.js）为准：
 *   deepseek-chat / deepseek-reasoner / deepseek-v4-pro / deepseek-v4-flash
 * 四个都声明 toolCalling: true。此外启动时会调 /models 核对账号实际可用的名字。
 * 所以启动时会调用 /models 核对一次，对不上就打印可用列表（见 models/preflight.ts）。
 * 这也是为什么这里把默认模型名做成可覆盖的配置，而不是散落在代码里。
 */
const PROVIDER_DEFAULTS: Record<
  Exclude<ModelProvider, 'scripted'>,
  { model: string; baseUrl: string; keyEnv: string }
> = {
  deepseek: {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  openai: {
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
  },
};

function loadDotEnv(file: string): void {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseExtraParams(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 解析失败不致命：调用方会把它当作"没有额外参数"
  }
  return {};
}

export function loadConfig(rootDir = process.cwd()): RuntimeConfig {
  loadDotEnv(resolve(rootDir, '.env'));

  const rawProvider = (process.env.MODEL_PROVIDER ?? 'deepseek').toLowerCase();
  const provider: ModelProvider =
    rawProvider === 'scripted' || rawProvider === 'openai' || rawProvider === 'deepseek'
      ? rawProvider
      : 'deepseek';

  const defaults = provider === 'scripted' ? null : PROVIDER_DEFAULTS[provider];
  const apiKey = defaults ? process.env[defaults.keyEnv]?.trim() || undefined : undefined;

  return {
    host: process.env.RUNTIME_HOST ?? '127.0.0.1',
    port: Number(process.env.RUNTIME_PORT ?? 8090),
    model: {
      provider,
      // 显式配置的 MODEL_NAME 优先；否则用该 provider 的默认模型
      name: process.env.MODEL_NAME?.trim() || defaults?.model || 'scripted-deterministic-v1',
      baseUrl: process.env.MODEL_BASE_URL?.trim() || defaults?.baseUrl,
      apiKey,
      temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
      extraParams: parseExtraParams(process.env.MODEL_EXTRA_PARAMS),
      streamUsage: (process.env.MODEL_STREAM_USAGE ?? 'true') !== 'false',
    },
    maxContextChars: Number(process.env.MAX_CONTEXT_CHARS ?? 12000),
    toolTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS ?? 10000),
    toolResultMaxChars: Number(process.env.TOOL_RESULT_MAX_CHARS ?? 2000),
    toolHttpAllowlist: (process.env.TOOL_HTTP_ALLOWLIST ?? 'example.com,api.github.com,httpbin.org,localhost')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** 实际生效的模型模式：声明了真实 provider 且拿到 key 才算 live，否则降级到脚本化模型。 */
export function resolveModelMode(config: RuntimeConfig): ModelMode {
  if (config.model.provider !== 'scripted' && config.model.apiKey) return 'live';
  return 'scripted';
}

/** 降级原因（用于启动日志与 /healthz，让"为什么不是真模型"一目了然） */
export function fallbackReason(config: RuntimeConfig): string | undefined {
  if (config.model.provider === 'scripted') return undefined;
  if (resolveModelMode(config) === 'live') return undefined;
  const keyEnv = PROVIDER_DEFAULTS[config.model.provider].keyEnv;
  return `MODEL_PROVIDER=${config.model.provider} 但未设置 ${keyEnv}，已降级为内置脚本化模型`;
}

/** 该 provider 期望的环境变量名（供启动提示使用） */
export function apiKeyEnvName(config: RuntimeConfig): string {
  if (config.model.provider === 'scripted') return '（脚本化模型无需 key）';
  return PROVIDER_DEFAULTS[config.model.provider].keyEnv;
}
