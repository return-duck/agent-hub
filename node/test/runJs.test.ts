import { describe, expect, it } from 'vitest';
import { NodeRunError } from '../src/compiler/nodeLog.js';
import { runJavaScript } from '../src/compiler/runJs.js';

const env = {
  inputs: { query: 'hello' },
  input: { topic: 'world' },
  scratchpad: { http: { status: 200, body: 'ok' } },
};

describe('JavaScript 代码节点', () => {
  it('能读取 inputs、input、scratchpad，并把 return 值交出去', () => {
    const result = runJavaScript(
      'return { query: inputs.query, topic: input.topic, status: scratchpad.http.status };',
      env,
      1000,
    );
    expect(result.value).toEqual({ query: 'hello', topic: 'world', status: 200 });
  });

  it('收集 console.log / warn / error，作为节点过程', () => {
    const result = runJavaScript(
      "console.log('step', 1); console.warn('careful'); console.error('nope'); return 1;",
      env,
      1000,
    );
    expect(result.logs).toEqual([
      { level: 'info', message: 'step 1' },
      { level: 'warn', message: 'careful' },
      { level: 'error', message: 'nope' },
    ]);
    expect(result.value).toBe(1);
  });

  it('拒绝能逃出沙箱的写法', () => {
    expect(() => runJavaScript('return this.constructor.constructor("return process")();', env, 1000)).toThrow(
      NodeRunError,
    );
    expect(() => runJavaScript('return require("fs");', env, 1000)).toThrow(/require/);
  });

  it('死循环按超时失败', () => {
    expect(() => runJavaScript('while (true) {}', env, 50)).toThrow(/超过 50 ms/);
  });
});