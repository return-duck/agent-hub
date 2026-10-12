/**
 * 测试用的画布图工厂。
 *
 * 默认产出一张合法的最小图：start → prompt → llm → end。
 * 各用例只覆盖自己关心的那部分，避免每个测试都抄一遍 40 行 JSON。
 */
import type { GraphSpec } from '../../src/domain/graph.js';

export interface NodeOverride {
  id: string;
  type?: string;
  config?: Record<string, unknown>;
  label?: string;
}

export function makeGraph(options: {
  nodes?: NodeOverride[];
  edges?: Array<{ id?: string; source: string; target: string }>;
  schemaVersion?: number;
} = {}): Record<string, unknown> {
  const nodes = options.nodes ?? [
    { id: 'n1', type: 'start', config: { inputVariables: [{ name: 'topic', type: 'string', required: true }] } },
    { id: 'n2', type: 'prompt', config: { role: 'human', template: '请帮我算一下：{{input.topic}}' } },
    { id: 'n3', type: 'llm', config: { temperature: 0.2, tools: ['calculator'], maxSteps: 6, outputKey: 'answer' } },
    { id: 'n4', type: 'end', config: { outputKey: 'answer' } },
  ];
  const edges = options.edges ?? [
    { source: 'n1', target: 'n2' },
    { source: 'n2', target: 'n3' },
    { source: 'n3', target: 'n4' },
  ];

  return {
    schemaVersion: options.schemaVersion ?? 1,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? guessType(node.id),
      position: { x: 0, y: 0 },
      data: { label: node.label ?? node.id, config: node.config ?? {} },
    })),
    edges: edges.map((edge, index) => ({
      id: edge.id ?? `e${index + 1}`,
      source: edge.source,
      target: edge.target,
    })),
  };
}

function guessType(id: string): string {
  if (id.startsWith('n1') || id.startsWith('s')) return 'start';
  if (id.startsWith('n2') || id.startsWith('p')) return 'prompt';
  if (id.startsWith('n3') || id.startsWith('l')) return 'llm';
  return 'end';
}

export function asGraph(raw: Record<string, unknown>): GraphSpec {
  return raw as unknown as GraphSpec;
}
