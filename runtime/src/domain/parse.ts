/**
 * 画布图的解析（编译器的最外层）。
 *
 * 与 validate.ts 的分工：这里只回答"能不能读成一张图"（形状问题），
 * 语义规则（单入口、可达性、无环、端口）全部在 validate.ts。分开的好处是
 * 错误分类清晰：读不出来 = INVALID_GRAPH 的形状错误，读出来但不合法 = 结构错误。
 */
import type { GraphEdge, GraphNode, GraphSpec } from './graph.js';
import type { NodeTypeName } from '../generated/manifest.js';
import { nodeManifest } from '../generated/manifest-data.js';

export class GraphParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphParseError';
  }
}

/**
 * 允许的节点类型直接来自 manifest —— 它是节点能力的唯一真源。
 * 这样新增一种节点类型只需要改 contracts/node-manifest.json + 加一个执行器，
 * 不存在"某处还写死着 4 种类型"的漏改点。
 */
const NODE_TYPES: ReadonlySet<string> = new Set(nodeManifest.nodeTypes.map((spec) => spec.type));

export function parseGraph(raw: unknown): GraphSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GraphParseError('graph 必须是对象');
  }
  const obj = raw as Record<string, unknown>;

  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;
  const nodesRaw = obj.nodes;
  const edgesRaw = obj.edges;

  if (!Array.isArray(nodesRaw)) throw new GraphParseError('graph.nodes 必须是数组');
  if (!Array.isArray(edgesRaw)) throw new GraphParseError('graph.edges 必须是数组');
  // 刻意不在这里判空：「空图」是语义问题，交给 validate 报出更具体的 EMPTY_GRAPH

  const nodes: GraphNode[] = nodesRaw.map((rawNode, index) => {
    if (!rawNode || typeof rawNode !== 'object') {
      throw new GraphParseError(`第 ${index} 个节点不是对象`);
    }
    const node = rawNode as Record<string, unknown>;
    const id = node.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new GraphParseError(`第 ${index} 个节点缺少 id`);
    }
    const type = node.type;
    if (typeof type !== 'string' || !NODE_TYPES.has(type)) {
      throw new GraphParseError(`节点 ${id} 的类型非法: ${String(type)}`);
    }
    if (id.includes('__')) {
      // "__" 是编译期用来拼接内部节点名的分隔符（LangGraph 禁止节点名含 ":"）
      throw new GraphParseError(`节点 id 不能包含 "__"（编译期保留分隔符）: ${id}`);
    }
    const data = (node.data ?? {}) as Record<string, unknown>;
    const config = data.config;
    const position = (node.position ?? { x: 0, y: 0 }) as Record<string, unknown>;
    const label = typeof data.label === 'string' ? data.label : '';

    return {
      id,
      type: type as NodeTypeName,
      label: label || `${type}#${id}`,
      position: {
        x: typeof position.x === 'number' ? position.x : 0,
        y: typeof position.y === 'number' ? position.y : 0,
      },
      config: config && typeof config === 'object' && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {},
    };
  });

  const edges: GraphEdge[] = edgesRaw.map((rawEdge, index) => {
    if (!rawEdge || typeof rawEdge !== 'object') {
      throw new GraphParseError(`第 ${index} 条连线不是对象`);
    }
    const edge = rawEdge as Record<string, unknown>;
    const source = edge.source;
    const target = edge.target;
    if (typeof source !== 'string' || typeof target !== 'string') {
      throw new GraphParseError(`第 ${index} 条连线缺少 source/target`);
    }
    const id = typeof edge.id === 'string' && edge.id.length > 0 ? edge.id : `edge-${index}`;
    return { id, source, target };
  });

  return { schemaVersion, nodes, edges };
}
