import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

/**
 * 契约测试：用【真实录制】的事件流去验证 contracts/events.schema.json。
 *
 * 这是整套契约机制里唯一能真正防漂移的一环：
 *  - runtime 改字段 → 录制文件对不上 → 这里红；
 *  - schema 改枚举 → 录制文件对不上 → 这里红；
 *  - Java 侧有同样一份契约测试读同一个文件 → 三端被同一份数据钉住。
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const schema = JSON.parse(readFileSync(resolve(ROOT, 'contracts/events.schema.json'), 'utf8'));
const fixturePath = resolve(ROOT, 'contracts/fixtures/events.jsonl');
const fixtureLines = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

describe('事件契约', () => {
  it('录制的事件流每一行都符合 events.schema.json', () => {
    expect(fixtureLines.length).toBeGreaterThan(10);

    const failures: string[] = [];
    for (const line of fixtureLines) {
      const parsed = JSON.parse(line) as { type?: string };
      if (!validate(parsed)) {
        failures.push(`${parsed.type}: ${ajv.errorsText(validate.errors)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('schema 声明了 10 个判别式分支，且每个分支的 type 都是 const', () => {
    const branches = schema.oneOf as Array<{ $ref: string }>;
    expect(branches).toHaveLength(10);

    const constTypes = branches.map((branch) => {
      const name = branch.$ref.split('/').pop() as string;
      const def = schema.$defs[name] as { properties: { type: { const: string } } };
      return def.properties.type.const;
    });
    expect(new Set(constTypes).size).toBe(10);
    expect(constTypes).toContain('run.error');
  });

  it('录制文件覆盖了除 run.error 之外的全部事件类型', () => {
    const seen = new Set(fixtureLines.map((line) => (JSON.parse(line) as { type: string }).type));
    const declared = (schema.oneOf as Array<{ $ref: string }>).map((branch) => {
      const name = branch.$ref.split('/').pop() as string;
      return (schema.$defs[name] as { properties: { type: { const: string } } }).properties.type.const;
    });

    const missing = declared.filter((type) => type !== 'run.error' && !seen.has(type));
    expect(missing).toEqual([]);
  });

  it('每个事件都有 type / runId / ts，且 seq 由 server 补（runtime 不产出）', () => {
    for (const line of fixtureLines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(typeof event['type']).toBe('string');
      expect(typeof event['runId']).toBe('string');
      expect(typeof event['ts']).toBe('string');
      // seq 是 server 作为唯一写入者分配的，runtime 侧不该出现
      expect(event['seq']).toBeUndefined();
    }
  });
});
