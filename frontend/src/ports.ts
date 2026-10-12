import { nodeSpec } from './manifest.js';

export type PortType = 'string' | 'number' | 'boolean' | 'object';
export type BindingType = PortType | 'any';

export interface PortNode {
  id: string;
  type?: string | null;
  data: { label: string; config?: Record<string, unknown> };
}

export interface OutputChoice {
  ref: string;
  type: PortType;
  label: string;
}

export interface OutputGroup {
  nodeId: string;
  title: string;
  choices: OutputChoice[];
}

export interface PortEdge {
  source: string;
  target: string;
}

const PORT_TYPES = new Set<string>(['string', 'number', 'boolean', 'object']);

export function outputChoices(nodes: PortNode[], currentId: string, accept: BindingType): OutputChoice[] {
  return outputGroups(nodes, [], currentId, accept, false).flatMap((group) =>
    group.choices.map((choice) => ({ ...choice, label: `${group.title} · ${choice.label}` })),
  );
}

/** 参数值下拉：只展开当前节点上游，按节点分组，选项文字是字段名。 */
export function outputGroups(
  nodes: PortNode[],
  edges: PortEdge[],
  currentId: string,
  accept: BindingType,
  upstreamOnly = true,
): OutputGroup[] {
  const allowed = upstreamOnly ? upstreamIds(edges, currentId) : null;
  const groups: OutputGroup[] = [];
  for (const node of nodes) {
    if (node.id === currentId) continue;
    if (allowed && !allowed.has(node.id)) continue;
    const title = node.data.label || node.id;
    const choices: OutputChoice[] = [];
    for (const port of outputsOf(node)) {
      if (accept !== 'any' && port.type !== accept) continue;
      choices.push({ ref: port.ref, type: port.type, label: port.label });
    }
    if (choices.length > 0) groups.push({ nodeId: node.id, title, choices });
  }
  return groups;
}

function upstreamIds(edges: PortEdge[], currentId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(currentId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(incoming.get(id) ?? []));
  }
  return seen;
}

function outputsOf(node: PortNode): Array<{ ref: string; label: string; type: PortType }> {
  const config = node.data.config ?? {};
  if (node.type === 'start') {
    const declared = Array.isArray(config['inputVariables']) ? config['inputVariables'] : [];
    const ports: Array<{ ref: string; label: string; type: PortType }> = [];
    for (const raw of declared) {
      if (!raw || typeof raw !== 'object') continue;
      const name = (raw as { name?: unknown }).name;
      const type = (raw as { type?: unknown }).type;
      if (typeof name !== 'string' || !name || !isPortType(type)) continue;
      ports.push({ ref: `${node.id}.${name}`, label: name, type });
    }
    return ports;
  }

  if (node.type === 'code') {
    const declared = Array.isArray(config['outputs']) ? config['outputs'] : [];
    const ports: Array<{ ref: string; label: string; type: PortType }> = [];
    for (const raw of declared) {
      if (!raw || typeof raw !== 'object') continue;
      const name = (raw as { name?: unknown }).name;
      const type = (raw as { type?: unknown }).type;
      if (typeof name !== 'string' || !name || !isPortType(type)) continue;
      ports.push({ ref: `${node.id}.${name}`, label: name, type });
    }
    if (ports.length > 0) return ports;
  }

  const spec = nodeSpec(node.type ?? '');
  return (spec?.outputs ?? []).flatMap((output) => {
    if (!isPortType(output.type)) return [];
    const type = node.type === 'code' && isPortType(config['outputType']) ? config['outputType'] : output.type;
    return [{ ref: `${node.id}.${output.name}`, label: output.label || output.name, type }];
  });
}

function isPortType(value: unknown): value is PortType {
  return typeof value === 'string' && PORT_TYPES.has(value);
}
