/**
 * 图校验与执行计划生成（编译器的前半段）。
 *
 * 这是"画布图 = IR"这一主张的落点：图必须通过 11 条结构规则，才能变成可执行的线性计划。
 * 校验错误带 {code, nodeId, message}，前端可以直接把问题标在对应节点上。
 *
 * 注意：这里的规则是【唯一】的权威实现。server 只做浅层校验（JSON 可解析、id 唯一、
 * 类型已知、边指向存在的节点），深层语义（单入口、可达性、无环、端口）只在这里判断，
 * 避免两端各写一份必然漂移的规则。
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { nodeManifest } from '../generated/manifest-data.js';
import { SUPPORTED_SCHEMA_VERSION, toToolNames, type GraphNode, type GraphSpec } from '../domain/graph.js';

export interface Problem {
  code: string;
  nodeId: string | null;
  message: string;
}

export class CompileError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[]) {
    super(`图校验失败（${problems.length} 个问题）: ${problems.map((p) => `${p.code}${p.nodeId ? '@' + p.nodeId : ''}`).join(', ')}`);
    this.name = 'CompileError';
    this.problems = problems;
  }
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

const configValidators = new Map<string, ValidateFunction>();
for (const spec of nodeManifest.nodeTypes) {
  configValidators.set(spec.type, ajv.compile(spec.configSchema as object));
}

export interface CompiledPlan {
  /** 从 start 出发的线性执行顺序，最后一个是 end 节点 */
  order: GraphNode[];
}

export function planGraph(graph: GraphSpec): CompiledPlan {
  const problems: Problem[] = [];

  if (graph.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    problems.push(problem('UNSUPPORTED_SCHEMA_VERSION', null,
      `不支持的 schemaVersion=${graph.schemaVersion}，当前仅支持 ${SUPPORTED_SCHEMA_VERSION}`));
    throw new CompileError(problems);
  }
  if (graph.nodes.length === 0) {
    problems.push(problem('EMPTY_GRAPH', null, '图中没有任何节点'));
    throw new CompileError(problems);
  }

  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      problems.push(problem('DUPLICATE_NODE_ID', node.id, `节点 id 重复: ${node.id}`));
    }
    byId.set(node.id, node);
  }

  for (const node of graph.nodes) {
    const validator = configValidators.get(node.type);
    if (!validator) {
      // 防御分支：parseGraph 已经依据 manifest 拒绝了未知类型，正常不会走到这里
      problems.push(problem('UNKNOWN_NODE_TYPE', node.id, `未知节点类型: ${node.type}`));
      continue;
    }
    if (!validator(node.config)) {
      for (const err of validator.errors ?? []) {
        problems.push(problem('INVALID_NODE_CONFIG', node.id,
          `节点配置不合法 (${err.instancePath || '/'}): ${err.message}`));
      }
    }
  }

  const starts = graph.nodes.filter((n) => n.type === 'start');
  const ends = graph.nodes.filter((n) => n.type === 'end');
  if (starts.length !== 1) {
    problems.push(problem('START_COUNT', null, `必须恰好有一个 start 节点，当前有 ${starts.length} 个`));
  }
  if (ends.length !== 1) {
    problems.push(problem('END_COUNT', null, `必须恰好有一个 end 节点，当前有 ${ends.length} 个`));
  }
  if (problems.length > 0) {
    throw new CompileError(problems);
  }

  const start = starts[0] as GraphNode;
  const end = ends[0] as GraphNode;

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) {
      problems.push(problem('EDGE_UNKNOWN_SOURCE', null, `连线起点不存在: ${edge.source}`));
      continue;
    }
    if (!byId.has(edge.target)) {
      problems.push(problem('EDGE_UNKNOWN_TARGET', null, `连线终点不存在: ${edge.target}`));
      continue;
    }
    (outgoing.get(edge.source) as string[]).push(edge.target);
    (incoming.get(edge.target) as string[]).push(edge.source);
  }

  if ((incoming.get(start.id) as string[]).length > 0) {
    problems.push(problem('START_HAS_INCOMING', start.id, 'start 节点不能有入边'));
  }
  if ((outgoing.get(end.id) as string[]).length > 0) {
    problems.push(problem('END_HAS_OUTGOING', end.id, 'end 节点不能有出边'));
  }
  for (const node of graph.nodes) {
    const out = outgoing.get(node.id) as string[];
    const max = node.id === end.id ? 0 : 1;
    if (out.length !== max) {
      problems.push(problem('EDGE_DEGREE', node.id,
        `节点 ${node.id}(${node.type}) 的出边数应为 ${max}，实际 ${out.length}（MVP 只支持线性链）`));
    }
  }

  // 沿唯一出边行走：能同时验证可达性与环
  const order: GraphNode[] = [];
  const visited = new Set<string>();
  let cursor: GraphNode | undefined = start;
  while (cursor) {
    if (visited.has(cursor.id)) {
      problems.push(problem('CYCLE_DETECTED', cursor.id, `图中存在环，回到节点 ${cursor.id}`));
      break;
    }
    visited.add(cursor.id);
    order.push(cursor);
    const nextId: string | undefined = (outgoing.get(cursor.id) as string[])[0];
    cursor = nextId === undefined ? undefined : byId.get(nextId);
  }

  const last = order[order.length - 1];
  if (last && last.id !== end.id) {
    problems.push(problem('NO_PATH_TO_END', last.id,
      `从 start 出发的链路终止于 ${last.id}(${last.type})，没有到达 end 节点`));
  }
  for (const node of graph.nodes) {
    if (!visited.has(node.id)) {
      problems.push(problem('UNREACHABLE_NODE', node.id, `节点 ${node.id} 从 start 不可达`));
    }
  }

  // 工具必须在清单里声明
  const declaredTools = new Set<string>(nodeManifest.toolNames as readonly string[]);
  for (const node of graph.nodes) {
    if (node.type !== 'llm') continue;
    for (const tool of toToolNames(node.config.tools)) {
      if (!declaredTools.has(tool)) {
        problems.push(problem('UNKNOWN_TOOL', node.id, `未声明的工具: ${tool}`));
      }
    }
  }

  if (problems.length > 0) {
    throw new CompileError(problems);
  }

  return { order };
}

/** 入口变量校验：start 节点声明的必填变量必须在 input 里出现 */
export function validateInput(plan: CompiledPlan, input: Record<string, unknown>): void {
  const start = plan.order[0];
  if (!start || start.type !== 'start') return;

  const declared = start.config.inputVariables;
  if (!Array.isArray(declared)) return;

  const missing: string[] = [];
  for (const raw of declared) {
    if (!raw || typeof raw !== 'object') continue;
    const decl = raw as { name?: unknown; required?: unknown };
    const name = typeof decl.name === 'string' ? decl.name : undefined;
    if (!name) continue;
    const required = decl.required !== false;
    const value = input[name];
    if (required && (value === undefined || value === null || value === '')) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new InputError(`缺少必填输入变量: ${missing.join(', ')}`);
  }
}

function problem(code: string, nodeId: string | null, message: string): Problem {
  return { code, nodeId, message };
}
