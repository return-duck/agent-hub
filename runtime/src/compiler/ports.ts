/**
 * 节点输入 / 输出端口。
 *
 * 每个可绑定的输入要么引用另一个节点的输出（ref），要么是自定义字面量（custom）。
 * 引用必须类型一致，并且指向执行顺序里更早的节点。
 */
import { nodeManifest } from '../generated/manifest-data.js';
import type { GraphNode } from '../domain/graph.js';
import { resolvePath, renderTemplate, type TemplateContext } from './template.js';
import { NodeRunError } from './nodeLog.js';
import { outputKeyOf, resolveBindings } from './bindings.js';

interface PortProblem {
  code: string;
  nodeId: string | null;
  message: string;
}

export type PortType = 'string' | 'number' | 'boolean' | 'object';
export type BindingType = PortType | 'any';

export interface Binding {
  mode: 'custom' | 'ref';
  value: unknown;
  ref: string;
}

export interface OutputPort {
  ref: string;
  nodeId: string;
  name: string;
  label: string;
  type: PortType;
  /** 运行时取值路径，如 input.topic、scratchpad.http.body */
  path: string;
}

export type OutputCatalog = Map<string, OutputPort>;

interface ManifestOutput {
  name?: string;
  type?: string;
  label?: string;
}

interface ManifestNode {
  type: string;
  outputs?: readonly ManifestOutput[];
  uiSchema?: Record<string, { widget?: string; valueType?: string }>;
  configSchema?: { required?: readonly string[] };
}

const PORT_TYPES = new Set<PortType>(['string', 'number', 'boolean', 'object']);

function manifestOf(type: string): ManifestNode | undefined {
  return (nodeManifest.nodeTypes as readonly ManifestNode[]).find((spec) => spec.type === type);
}

export function readBinding(raw: unknown): Binding {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as { mode?: unknown; value?: unknown; ref?: unknown };
    const ref = typeof record.ref === 'string' ? record.ref : '';
    if (record.mode === 'ref' || (record.mode !== 'custom' && ref.length > 0 && record.mode !== undefined)) {
      return { mode: 'ref', value: record.value ?? '', ref };
    }
    if (record.mode === 'custom' || record.mode === 'ref' || 'value' in record || 'ref' in record) {
      return { mode: record.mode === 'ref' ? 'ref' : 'custom', value: record.value ?? '', ref };
    }
  }
  return { mode: 'custom', value: raw ?? '', ref: '' };
}

export function buildOutputCatalog(nodes: GraphNode[]): OutputCatalog {
  const catalog: OutputCatalog = new Map();
  for (const node of nodes) {
    for (const port of outputsOf(node)) {
      catalog.set(port.ref, port);
    }
  }
  return catalog;
}

export function outputsOf(node: GraphNode): OutputPort[] {
  if (node.type === 'start') {
    const declared = Array.isArray(node.config.inputVariables) ? node.config.inputVariables : [];
    const ports: OutputPort[] = [];
    for (const raw of declared) {
      if (!raw || typeof raw !== 'object') continue;
      const name = (raw as { name?: unknown }).name;
      const type = (raw as { type?: unknown }).type;
      if (typeof name !== 'string' || !name || !isPortType(type)) continue;
      ports.push({
        ref: `${node.id}.${name}`,
        nodeId: node.id,
        name,
        label: name,
        type,
        path: `input.${name}`,
      });
    }
    return ports;
  }

  const spec = manifestOf(node.type);
  const declared = spec?.outputs ?? [];
  const key = outputKeyOf(node.config.outputKey, defaultOutputKey(node.type));
  return declared.flatMap((output) => {
    if (!output.name || !isPortType(output.type)) return [];
    const type = node.type === 'code' ? codeOutputType(node, output.type) : output.type;
    const path = output.name === 'result' || output.name === 'text'
      ? `scratchpad.${key}`
      : `scratchpad.${key}.${output.name}`;
    return [{
      ref: `${node.id}.${output.name}`,
      nodeId: node.id,
      name: output.name,
      label: output.label || output.name,
      type,
      path,
    }];
  });
}

export interface Materialized {
  value: unknown;
  warnings: string[];
}

export function materializeBinding(
  raw: unknown,
  expected: BindingType,
  catalog: OutputCatalog,
  context: TemplateContext,
  options: { template?: boolean } = {},
): Materialized {
  const binding = readBinding(raw);
  if (binding.mode === 'ref') {
    if (!binding.ref) {
      throw new NodeRunError('INVALID_INPUT', '已选择引用上游输出，但没有指定是哪一个');
    }
    const port = catalog.get(binding.ref);
    if (!port) {
      throw new NodeRunError('INVALID_INPUT', `找不到输出 ${binding.ref}`);
    }
    if (expected !== 'any' && port.type !== expected) {
      throw new NodeRunError('INVALID_INPUT', `输出 ${binding.ref} 的类型是 ${port.type}，这里需要 ${expected}`);
    }
    const value = resolvePath(port.path, context);
    if (value === undefined) {
      throw new NodeRunError('INVALID_INPUT', `输出 ${port.label} 还没有值`);
    }
    return { value, warnings: [] };
  }

  if (expected === 'string' || expected === 'any') {
    const text = binding.value === undefined || binding.value === null ? '' : String(binding.value);
    if (options.template && expected === 'string') {
      const rendered = renderTemplate(text, context);
      return { value: rendered.text, warnings: rendered.warnings };
    }
    return { value: expected === 'any' ? binding.value ?? text : text, warnings: [] };
  }
  return { value: coerceLiteral(binding.value, expected), warnings: [] };
}

/** 代码节点的输入列表。字符串形式是旧的 name=path 写法，仍然可用。 */
export function materializeInputList(
  raw: unknown,
  catalog: OutputCatalog,
  context: TemplateContext,
): Record<string, unknown> {
  if (typeof raw === 'string') {
    return resolveBindings(raw, context);
  }
  if (!Array.isArray(raw)) return {};
  const inputs: Record<string, unknown> = {};
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    const type = (item as { type?: unknown }).type;
    if (typeof name !== 'string' || !name) continue;
    const expected: BindingType = isPortType(type) ? type : 'string';
    inputs[name] = materializeBinding(item, expected, catalog, context, { template: expected === 'string' }).value;
  }
  return inputs;
}

export function checkPortRefs(order: GraphNode[]): PortProblem[] {
  let catalog: OutputCatalog;
  try {
    catalog = buildOutputCatalog(order);
  } catch (error) {
    if (error instanceof NodeRunError) {
      return [{ code: 'INVALID_NODE_CONFIG', nodeId: null, message: error.message }];
    }
    throw error;
  }
  const position = new Map(order.map((node, index) => [node.id, index]));
  const problems: PortProblem[] = [];

  for (const node of order) {
    const spec = manifestOf(node.type);
    const ui = spec?.uiSchema ?? {};
    const required = new Set(spec?.configSchema?.required ?? []);
    for (const [field, widget] of Object.entries(ui)) {
      if (widget.widget === 'binding') {
        const expected = (widget.valueType ?? 'string') as BindingType;
        const binding = readBinding(node.config[field]);
        if (binding.mode === 'ref') {
          problems.push(...matchRef(node.id, field, binding.ref, expected, catalog, position));
        } else if (required.has(field) && expected === 'string' && !String(binding.value ?? '').trim()) {
          problems.push({
            code: 'INVALID_NODE_CONFIG',
            nodeId: node.id,
            message: `输入 ${field} 不能为空：选择一个上游输出，或填写自定义值`,
          });
        }
      }
      if (widget.widget === 'bindingList' && Array.isArray(node.config[field])) {
        for (const item of node.config[field] as unknown[]) {
          if (!item || typeof item !== 'object') continue;
          const row = item as { name?: unknown; type?: unknown };
          const binding = readBinding(item);
          if (binding.mode !== 'ref') continue;
          const expected: BindingType = isPortType(row.type) ? row.type : 'string';
          const label = typeof row.name === 'string' && row.name ? row.name : field;
          problems.push(...matchRef(node.id, label, binding.ref, expected, catalog, position));
        }
      }
    }
  }
  return problems;
}

function matchRef(
  nodeId: string,
  field: string,
  ref: string,
  expected: BindingType,
  catalog: OutputCatalog,
  position: Map<string, number>,
): PortProblem[] {
  if (!ref) {
    return [{ code: 'INVALID_NODE_CONFIG', nodeId, message: `输入 ${field} 选择了引用，但没有指定输出` }];
  }
  const port = catalog.get(ref);
  if (!port) {
    return [{ code: 'INVALID_NODE_CONFIG', nodeId, message: `输入 ${field} 引用了不存在的输出 ${ref}` }];
  }
  const here = position.get(nodeId) ?? 0;
  const there = position.get(port.nodeId) ?? 0;
  if (there >= here) {
    return [{
      code: 'INVALID_NODE_CONFIG',
      nodeId,
      message: `输入 ${field} 只能引用更早节点的输出，${ref} 不是上游`,
    }];
  }
  if (expected !== 'any' && port.type !== expected) {
    return [{
      code: 'INVALID_NODE_CONFIG',
      nodeId,
      message: `输入 ${field} 需要 ${expected}，但 ${port.label} 的类型是 ${port.type}`,
    }];
  }
  return [];
}

function coerceLiteral(value: unknown, type: PortType): unknown {
  if (type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      throw new NodeRunError('INVALID_INPUT', `自定义输入不是数字: ${String(value)}`);
    }
    return parsed;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new NodeRunError('INVALID_INPUT', `自定义输入不是布尔值: ${String(value)}`);
  }
  if (type === 'object') {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string' && value.trim()) {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        throw new NodeRunError('INVALID_INPUT', '自定义对象输入不是合法 JSON');
      }
    }
    return {};
  }
  return value == null ? '' : String(value);
}

function codeOutputType(node: GraphNode, fallback: PortType): PortType {
  return isPortType(node.config.outputType) ? node.config.outputType : fallback;
}

function defaultOutputKey(type: string): string {
  if (type === 'prompt') return 'prompt';
  if (type === 'llm') return 'answer';
  if (type === 'http') return 'http';
  if (type === 'code') return 'code';
  return 'answer';
}

function isPortType(value: unknown): value is PortType {
  return typeof value === 'string' && PORT_TYPES.has(value as PortType);
}
