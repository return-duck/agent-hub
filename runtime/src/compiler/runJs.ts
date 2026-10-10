/**
 * 代码节点的 JavaScript 执行器。只支持同步 JS。
 *
 * 沙箱是 node:vm 加源码拒绝清单：不提供 require / process / fetch，
 * 并拒绝 constructor、prototype 这类能逃出 vm 的写法。
 * 这是工作流里的数据变换，不是多租户隔离边界。
 */
import vm from 'node:vm';
import { NodeRunError } from './nodeLog.js';

const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bconstructor\b/, label: 'constructor' },
  { pattern: /\b__proto__\b/, label: '__proto__' },
  { pattern: /\bprototype\b/, label: 'prototype' },
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\brequire\b/, label: 'require' },
  { pattern: /\bimport\b/, label: 'import' },
  { pattern: /\beval\b/, label: 'eval' },
  { pattern: /\bFunction\b/, label: 'Function' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  { pattern: /\bglobal\b/, label: 'global' },
  { pattern: /\bmodule\b/, label: 'module' },
  { pattern: /\bexports\b/, label: 'exports' },
  { pattern: /\bWebAssembly\b/, label: 'WebAssembly' },
  { pattern: /\bfetch\b/, label: 'fetch' },
  { pattern: /\bProxy\b/, label: 'Proxy' },
  { pattern: /\bReflect\b/, label: 'Reflect' },
];

export interface JsEnv {
  inputs: Record<string, unknown>;
  input: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
}

export interface JsRunResult {
  value: unknown;
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
}

export function runJavaScript(source: string, env: JsEnv, timeoutMs: number): JsRunResult {
  const blocked = FORBIDDEN.find((rule) => rule.pattern.test(source));
  if (blocked) {
    throw new NodeRunError('INVALID_INPUT', `代码里不允许使用 ${blocked.label}`);
  }

  const logs: JsRunResult['logs'] = [];
  const write = (level: 'info' | 'warn' | 'error') => (...args: unknown[]) => {
    logs.push({ level, message: args.map(formatArg).join(' ') });
  };
  const sandbox = {
    inputs: env.inputs,
    input: env.input,
    scratchpad: env.scratchpad,
    console: { log: write('info'), info: write('info'), warn: write('warn'), error: write('error') },
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
  };
  const context = vm.createContext(sandbox, { name: 'code-node' });
  const script = new vm.Script(
    `"use strict";\n(function(inputs, input, scratchpad, console) {\n${source}\n})(inputs, input, scratchpad, console);`,
    { filename: 'code-node.js' },
  );

  try {
    const value = script.runInContext(context, { timeout: Math.max(1, timeoutMs) });
    return { value, logs };
  } catch (error) {
    if (error instanceof NodeRunError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/script execution timed out/i.test(message)) {
      throw new NodeRunError('TIMEOUT', `代码执行超过 ${timeoutMs} ms`);
    }
    throw new NodeRunError('INTERNAL', `代码执行失败: ${message}`);
  }
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
