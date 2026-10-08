import { describe, expect, it } from 'vitest';
import { parseGraph } from '../src/domain/parse.js';
import { CompileError, InputError, planGraph, validateInput } from '../src/compiler/validate.js';
import { makeGraph } from './helpers/graph.js';

/** 收集校验失败的 code 集合，断言时只看关心的那几个，避免顺序耦合 */
function codesOf(raw: Record<string, unknown>): string[] {
  try {
    planGraph(parseGraph(raw));
    return [];
  } catch (error) {
    if (error instanceof CompileError) return error.problems.map((p) => p.code);
    throw error;
  }
}

describe('图校验（编译器的 11 条结构规则）', () => {
  it('合法图通过，并产出从 start 到 end 的线性执行顺序', () => {
    const plan = planGraph(parseGraph(makeGraph()));
    expect(plan.order.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(plan.order[0]?.type).toBe('start');
    expect(plan.order[plan.order.length - 1]?.type).toBe('end');
  });

  it('拒绝不支持的 schemaVersion', () => {
    expect(codesOf(makeGraph({ schemaVersion: 2 }))).toContain('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('拒绝空图', () => {
    expect(codesOf({ schemaVersion: 1, nodes: [], edges: [] })).toContain('EMPTY_GRAPH');
  });

  it('拒绝重复的节点 id', () => {
    const codes = codesOf(
      makeGraph({
        nodes: [
          { id: 'n1', type: 'start', config: { inputVariables: [] } },
          { id: 'n1', type: 'end', config: {} },
        ],
        edges: [],
      }),
    );
    expect(codes).toContain('DUPLICATE_NODE_ID');
  });

  it('拒绝未知节点类型（类型集合来自 manifest，由解析层拦截）', () => {
    expect(() =>
      parseGraph(
        makeGraph({
          nodes: [
            { id: 'n1', type: 'start', config: { inputVariables: [] } },
            { id: 'n2', type: 'condition', config: {} },
            { id: 'n4', type: 'end', config: {} },
          ],
          edges: [
            { source: 'n1', target: 'n2' },
            { source: 'n2', target: 'n4' },
          ],
        }),
      ),
    ).toThrow(/类型非法/);
  });

  it('拒绝不符合 manifest configSchema 的节点配置', () => {
    const codes = codesOf(
      makeGraph({
        nodes: [
          { id: 'n1', type: 'start', config: { inputVariables: [] } },
          { id: 'n2', type: 'prompt', config: { template: '' } },
          { id: 'n4', type: 'end', config: {} },
        ],
        edges: [
          { source: 'n1', target: 'n2' },
          { source: 'n2', target: 'n4' },
        ],
      }),
    );
    expect(codes).toContain('INVALID_NODE_CONFIG');
  });

  it('要求恰好一个 start 和一个 end', () => {
    expect(
      codesOf(
        makeGraph({
          nodes: [
            { id: 'n1', type: 'start', config: { inputVariables: [] } },
            { id: 's2', type: 'start', config: { inputVariables: [] } },
            { id: 'n4', type: 'end', config: {} },
          ],
          edges: [
            { source: 'n1', target: 'n4' },
            { source: 's2', target: 'n4' },
          ],
        }),
      ),
    ).toContain('START_COUNT');

    expect(
      codesOf(
        makeGraph({
          nodes: [
            { id: 'n1', type: 'start', config: { inputVariables: [] } },
            { id: 'n2', type: 'prompt', config: { template: 'x' } },
          ],
          edges: [{ source: 'n1', target: 'n2' }],
        }),
      ),
    ).toContain('END_COUNT');
  });

  it('拒绝指向不存在节点的连线', () => {
    const codes = codesOf(
      makeGraph({
        edges: [
          { source: 'n1', target: 'ghost' },
          { source: 'n2', target: 'n3' },
          { source: 'n3', target: 'n4' },
        ],
      }),
    );
    expect(codes).toContain('EDGE_UNKNOWN_TARGET');
  });

  it('拒绝 start 有入边、end 有出边', () => {
    expect(
      codesOf(
        makeGraph({
          edges: [
            { source: 'n2', target: 'n1' },
            { source: 'n1', target: 'n3' },
            { source: 'n3', target: 'n4' },
          ],
        }),
      ),
    ).toContain('START_HAS_INCOMING');
  });

  it('MVP 只支持线性链：分叉与断链都会被拒绝（出边数必须恰好为 1）', () => {
    // n2 有两个出边 → 分叉
    expect(
      codesOf(
        makeGraph({
          edges: [
            { source: 'n1', target: 'n2' },
            { source: 'n2', target: 'n3' },
            { source: 'n2', target: 'n4' },
            { source: 'n3', target: 'n4' },
          ],
        }),
      ),
    ).toContain('EDGE_DEGREE');
  });

  it('检测环', () => {
    const codes = codesOf(
      makeGraph({
        nodes: [
          { id: 'n1', type: 'start', config: { inputVariables: [] } },
          { id: 'n2', type: 'prompt', config: { template: 'a' } },
          { id: 'n4', type: 'prompt', config: { template: 'b' } },
          { id: 'n9', type: 'end', config: {} },
        ],
        edges: [
          { source: 'n1', target: 'n2' },
          { source: 'n2', target: 'n4' },
          { source: 'n4', target: 'n2' },
        ],
      }),
    );
    expect(codes).toContain('CYCLE_DETECTED');
    expect(codes).toContain('UNREACHABLE_NODE');
  });

  it('拒绝未在 manifest 中声明的工具', () => {
    const codes = codesOf(
      makeGraph({
        nodes: [
          { id: 'n1', type: 'start', config: { inputVariables: [] } },
          { id: 'n3', type: 'llm', config: { tools: ['browser'] } },
          { id: 'n4', type: 'end', config: {} },
        ],
        edges: [
          { source: 'n1', target: 'n3' },
          { source: 'n3', target: 'n4' },
        ],
      }),
    );
    expect(codes).toContain('INVALID_NODE_CONFIG');
  });
});

describe('入口变量校验', () => {
  it('缺少必填变量时抛 InputError 并点名变量', () => {
    const plan = planGraph(parseGraph(makeGraph()));
    expect(() => validateInput(plan, {})).toThrow(InputError);
    expect(() => validateInput(plan, {})).toThrow(/topic/);
    expect(() => validateInput(plan, { topic: '' })).toThrow(/topic/);
  });

  it('必填变量齐全时通过', () => {
    const plan = planGraph(parseGraph(makeGraph()));
    expect(() => validateInput(plan, { topic: 'hi' })).not.toThrow();
  });

  it('required=false 的变量可以缺失', () => {
    const plan = planGraph(
      parseGraph(
        makeGraph({
          nodes: [
            {
              id: 'n1',
              type: 'start',
              config: { inputVariables: [{ name: 'opt', type: 'string', required: false }] },
            },
            { id: 'n2', type: 'prompt', config: { template: 'x' } },
            { id: 'n4', type: 'end', config: {} },
          ],
          edges: [
            { source: 'n1', target: 'n2' },
            { source: 'n2', target: 'n4' },
          ],
        }),
      ),
    );
    expect(() => validateInput(plan, {})).not.toThrow();
  });
});

describe('图解析', () => {
  it('拒绝缺少 id 的节点', () => {
    expect(() =>
      parseGraph({ schemaVersion: 1, nodes: [{ type: 'start', data: { config: {} } }], edges: [] }),
    ).toThrow(/缺少 id/);
  });

  it('拒绝含有编译期保留分隔符 "__" 的节点 id', () => {
    expect(() =>
      parseGraph({
        schemaVersion: 1,
        nodes: [{ id: 'n1__model', type: 'start', data: { config: {} } }],
        edges: [],
      }),
    ).toThrow(/__/);
  });

  it('为缺失 id 的连线补一个稳定 id', () => {
    const graph = parseGraph({
      schemaVersion: 1,
      nodes: [
        { id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { config: { inputVariables: [] } } },
        { id: 'n4', type: 'end', position: { x: 0, y: 0 }, data: { config: {} } },
      ],
      edges: [{ source: 'n1', target: 'n4' }],
    });
    expect(graph.edges[0]?.id).toBe('edge-0');
  });
});
