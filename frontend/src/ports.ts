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

const PORT_TYPES = new Set<string>(['string', 'number', 'boolean', 'object']);

export function outputChoices(nodes: PortNode[], currentId: string, accept: BindingType): OutputChoice[] {
  const choices: OutputChoice[] = [];
  for (const node of nodes) {
    if (node.id === currentId) continue;
    const title = node.data.label || node.id;
    for (const port of outputsOf(node)) {
      if (accept !== 'any' && port.type !== accept) continue;
      choices.push({
        ref: port.ref,
        type: port.type,
        label: `${title} · ${port.label}（${port.type}）`,
      });
    }
  }
  return choices;
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
