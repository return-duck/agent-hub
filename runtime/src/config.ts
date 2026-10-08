/**
 * 运行时配置。刻意手写一个极小的 .env 读取器（不引第三方依赖），
 * 这样 `tsx` / `node` / 测试三种启动方式行为一致。
 *
 * 安全约定：API key 只存在于 runtime 进程，server 只传 provider 名称，
 * 日志与协议事件里永远不出现 key。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ModelProvider = 'scripted' | 'openai';
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
  };
  /** 每次模型调用前允许的最大上下文字符预算（约 4 字符 = 1 token） */
  maxContextChars: number;
  toolTimeoutMs: number;
  toolResultMaxChars: number;
  toolHttpAllowlist: string[];
}

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

export function loadConfig(rootDir = process.cwd()): RuntimeConfig {
  loadDotEnv(resolve(rootDir, '.env'));

  const provider = (process.env.MODEL_PROVIDER ?? 'scripted').toLowerCase() === 'openai' ? 'openai' : 'scripted';
  const apiKey = process.env.OPENAI_API_KEY?.trim() || undefined;

  return {
    host: process.env.RUNTIME_HOST ?? '127.0.0.1',
    port: Number(process.env.RUNTIME_PORT ?? 8090),
    model: {
      provider,
      name: process.env.MODEL_NAME ?? (provider === 'openai' ? 'gpt-4o-mini' : 'scripted-deterministic-v1'),
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
      apiKey,
      temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
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

/** 实际生效的模型模式：有 key 才是 live，否则自动降级到脚本化模型。 */
export function resolveModelMode(config: RuntimeConfig): ModelMode {
  if (config.model.provider === 'openai' && config.model.apiKey) return 'live';
  return 'scripted';
}
