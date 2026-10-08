import { describe, expect, it } from 'vitest';
import { loadConfig, resolveModelMode, fallbackReason, apiKeyEnvName, type RuntimeConfig } from '../src/config.js';
import { createModelBundle } from '../src/models/factory.js';

/**
 * 模型工厂与 provider 解析。
 *
 * 这里能测的是"配置 → 用哪个模型类"的映射与降级行为；
 * 真实调用（网络）不在单测范围内，由 scripts/e2e.sh 与手工验证覆盖。
 * 注意 ChatDeepSeek 的构造函数在没有 key 时会抛错 —— 所以"没 key 时必须走脚本化模型"
 * 这条不只是产品策略，也是不崩的前提，值得钉住。
 */

function configWith(model: Partial<RuntimeConfig['model']>): RuntimeConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    model: {
      provider: 'deepseek',
      name: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: undefined,
      temperature: 0.2,
      extraParams: {},
      streamUsage: true,
      ...model,
    },
    maxContextChars: 12000,
    toolTimeoutMs: 5000,
    toolResultMaxChars: 2000,
    toolHttpAllowlist: ['example.com'],
  };
}

describe('provider 解析', () => {
  it('默认 provider 是 deepseek（平台统一，不需要显式配置）', () => {
    const previous = process.env['MODEL_PROVIDER'];
    delete process.env['MODEL_PROVIDER'];
    try {
      // 用一个不存在的目录，避免读到开发者本机的 runtime/.env
      const config = loadConfig('/nonexistent-agent-stack-dir');
      expect(config.model.provider).toBe('deepseek');
      expect(config.model.name).toBe('deepseek-flash');
      expect(config.model.baseUrl).toBe('https://api.deepseek.com');
    } finally {
      if (previous !== undefined) process.env['MODEL_PROVIDER'] = previous;
    }
  });

  it('无 key → 降级为脚本化模型，并给出可读原因', () => {
    const config = configWith({ apiKey: undefined });
    expect(resolveModelMode(config)).toBe('scripted');
    expect(fallbackReason(config)).toContain('DEEPSEEK_API_KEY');

    const bundle = createModelBundle(config);
    expect(bundle.mode).toBe('scripted');
    expect(bundle.model._llmType()).toBe('scripted');
    expect(bundle.fallbackReason).toContain('DEEPSEEK_API_KEY');
  });

  it('有 key → 使用 ChatDeepSeek 且模式为 live', () => {
    const config = configWith({ apiKey: 'sk-fake-key-for-unit-test' });
    expect(resolveModelMode(config)).toBe('live');

    const bundle = createModelBundle(config);
    expect(bundle.mode).toBe('live');
    expect(bundle.provider).toBe('deepseek');
    // 断言具体的模型类，确保没退回成 ChatOpenAI（DeepSeek 有 reasoning_content 等特化处理）
    expect(bundle.model._llmType()).toBe('deepseek');
    expect(bundle.fallbackReason).toBeUndefined();
  });

  it('provider=scripted 时不读 key，也不产生降级原因', () => {
    const config = configWith({ provider: 'scripted', apiKey: undefined });
    const bundle = createModelBundle(config);
    expect(bundle.mode).toBe('scripted');
    expect(bundle.name).toBe('scripted-deterministic-v1');
    expect(bundle.fallbackReason).toBeUndefined();
  });

  it('openai 作为逃生通道仍然可用（并读 OPENAI_API_KEY）', () => {
    const config = configWith({ provider: 'openai', apiKey: 'sk-fake', baseUrl: 'https://example.invalid/v1' });
    const bundle = createModelBundle(config);
    expect(bundle.mode).toBe('live');
    expect(bundle.provider).toBe('openai');
    expect(bundle.model._llmType()).toBe('openai');
    expect(apiKeyEnvName(config)).toBe('OPENAI_API_KEY');
  });

  it('声明了 openai 但没给 key 时同样降级，且提示的是 OPENAI_API_KEY', () => {
    const config = configWith({ provider: 'openai', apiKey: undefined });
    expect(apiKeyEnvName(config)).toBe('OPENAI_API_KEY');
    expect(fallbackReason(config)).toContain('OPENAI_API_KEY');
  });

  it('关键：没有 key 时绝不能去构造 ChatDeepSeek（它的构造函数会直接抛错）', () => {
    const config = configWith({ apiKey: undefined });
    expect(() => createModelBundle(config)).not.toThrow();
  });
});

describe('额外参数透传', () => {
  it('MODEL_EXTRA_PARAMS 解析成对象；非法 JSON 退化为空对象而不是崩溃', () => {
    const previous = process.env['MODEL_EXTRA_PARAMS'];

    process.env['MODEL_EXTRA_PARAMS'] = '{"thinking":{"type":"enabled"}}';
    expect(loadConfig('/nonexistent-agent-stack-dir').model.extraParams).toEqual({
      thinking: { type: 'enabled' },
    });

    process.env['MODEL_EXTRA_PARAMS'] = '{不是合法JSON';
    expect(loadConfig('/nonexistent-agent-stack-dir').model.extraParams).toEqual({});

    if (previous === undefined) delete process.env['MODEL_EXTRA_PARAMS'];
    else process.env['MODEL_EXTRA_PARAMS'] = previous;
  });
});
