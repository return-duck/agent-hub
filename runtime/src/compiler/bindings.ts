/**
 * 节点输入绑定：把上游输出（或本次运行的入口变量）收成这份节点自己的 inputs。
 *
 * 一行一条，格式 `name=input.topic` 或 `name=scratchpad.http.body`。
 * `scratchpad.<outputKey>` 就是某个上游节点写出去的输出，这样节点可以串联。
 */
import { resolvePath, type TemplateContext } from './template.js';
import { NodeRunError } from './nodeLog.js';

const NAME = /^[A-Za-z_][\w]*$/;
const PATH = /^(input|scratchpad)(\.[A-Za-z_][\w]*)*$/;

export function resolveBindings(spec: string, context: TemplateContext): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const rawLine of spec.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new NodeRunError('INVALID_INPUT', `输入绑定应为 name=input.x 或 name=scratchpad.y，收到「${line}」`);
    }
    const name = line.slice(0, eq).trim();
    const path = line.slice(eq + 1).trim();
    if (!NAME.test(name)) {
      throw new NodeRunError('INVALID_INPUT', `输入名不合法: ${name}`);
    }
    if (!PATH.test(path)) {
      throw new NodeRunError(
        'INVALID_INPUT',
        `输入来源必须是 input.* 或 scratchpad.*，收到「${path}」`,
      );
    }
    const value = resolvePath(path, context);
    if (value === undefined) {
      throw new NodeRunError('INVALID_INPUT', `输入 ${name} 引用的 ${path} 没有值`);
    }
    inputs[name] = value;
  }
  return inputs;
}

/** 空白的 outputKey 回落到默认名；非空则必须是能写进 scratchpad 的标识符 */
export function outputKeyOf(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const key = text || fallback;
  if (!NAME.test(key)) {
    throw new NodeRunError('INVALID_INPUT', `outputKey 不合法: ${key}`);
  }
  return key;
}
