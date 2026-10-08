/**
 * 图编译器（后半段）：把线性执行计划装配成 LangGraph StateGraph。
 *
 * 核心设计 —— 画布是 DAG，运行时可以带环：
 *   一个绑定了工具的 LLM 节点，在编译期被展开成两个节点 + 一条回边：
 *
 *        [n3__model] --有 tool_calls--> [n3__tools]
 *             ^                                |
 *             +--------------------------------+
 *             |  没有 tool_calls
 *             v
 *         下一个画布节点
 *
 *   好处：用户在画布上永远只需要画一条直线（不需要理解/绘制循环，
 *   也不需要平台支持"环"这种容易画错的图），而 Agent 拿到的仍然是完整的 ReAct 工具循环。
 *
 * 为什么不用 prebuilt 的 toolsCondition 当路由：
 *   它的实现里 return "tools" 是【硬编码节点名】（已在本机读源码确认），
 *   一个图里有多个 LLM 节点时必然冲突。所以路由函数自己写，只有 3 行。
 */
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { AIMessage } from '@langchain/core/messages';
import { asNumber, type GraphNode } from '../domain/graph.js';
import type { NodeTypeName } from '../generated/manifest.js';
import {
  createEndRunner,
  createModelRunner,
  createPromptRunner,
  createStartRunner,
  hasTools,
  labelOf,
  modelNodeName,
  toolsNodeName,
  toolsOf,
  type NodeDeps,
} from './nodes.js';
import { AgentState, type AgentStateType } from './state.js';
import type { CompiledPlan } from './validate.js';

export interface CanvasNodeInfo {
  canvasNodeId: string;
  nodeType: NodeTypeName;
  label: string;
}

export interface StreamEventOptions {
  signal?: AbortSignal;
}

export interface CompiledAgent {
  /** 与 graph.streamEvents(input, {version:'v2'}) 等价 */
  streamEvents(input: Partial<AgentStateType>, options?: StreamEventOptions): AsyncIterable<unknown>;
  /** 编译后的节点名 -> 画布节点信息；事件映射器靠它把内部节点还原成画布节点 */
  nodeIndex: Map<string, CanvasNodeInfo>;
  /** 超级步硬上限：工具循环失控时的熔断（细粒度的每节点步数限制属 Phase 2） */
  recursionLimit: number;
  maxSteps: number;
}

/** LLM 节点的入口节点名：绑了工具就从 model 节点进，否则节点本身就是入口 */
function entryName(node: GraphNode): string {
  return hasTools(node) ? modelNodeName(node.id) : node.id;
}

export function compileGraph(plan: CompiledPlan, deps: NodeDeps): CompiledAgent {
  // LangGraph 的泛型在 TS 里非常重，这里刻意把 builder 收敛成宽松类型，
  // 对外只暴露下面 CompiledAgent 这个干净的接口。
  const builder = new StateGraph(AgentState) as unknown as {
    addNode: (name: string, action: unknown) => unknown;
    addEdge: (from: string, to: string) => unknown;
    addConditionalEdges: (from: string, path: unknown, targets: string[]) => unknown;
    compile: () => { streamEvents: (input: unknown, options: unknown) => AsyncIterable<unknown> };
  };
  const nodeIndex = new Map<string, CanvasNodeInfo>();

  const order = plan.order;
  const register = (compiledName: string, node: GraphNode): void => {
    nodeIndex.set(compiledName, {
      canvasNodeId: node.id,
      nodeType: node.type,
      label: labelOf(node),
    });
  };

  for (const node of order) {
    switch (node.type) {
      case 'start':
        builder.addNode(node.id, createStartRunner(node, deps));
        register(node.id, node);
        break;
      case 'prompt':
        builder.addNode(node.id, createPromptRunner(node));
        register(node.id, node);
        break;
      case 'end':
        builder.addNode(node.id, createEndRunner(node));
        register(node.id, node);
        break;
      case 'llm':
        if (hasTools(node)) {
          const mName = modelNodeName(node.id);
          const tName = toolsNodeName(node.id);
          builder.addNode(mName, createModelRunner(node, deps));
          builder.addNode(tName, new ToolNode(toolsOf(node, deps)));
          register(mName, node);
          register(tName, node);
        } else {
          builder.addNode(node.id, createModelRunner(node, deps));
          register(node.id, node);
        }
        break;
      default: {
        const exhaustive: never = node.type;
        throw new Error(`未处理的节点类型: ${String(exhaustive)}`);
      }
    }
  }

  const first = order[0] as GraphNode;
  builder.addEdge(START, entryName(first));

  for (let i = 0; i < order.length; i += 1) {
    const node = order[i] as GraphNode;
    const next = order[i + 1] as GraphNode | undefined;
    const target = next ? entryName(next) : END;

    if (hasTools(node)) {
      const mName = modelNodeName(node.id);
      const tName = toolsNodeName(node.id);
      builder.addConditionalEdges(
        mName,
        (state: AgentStateType) => {
          const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
          return (last?.tool_calls?.length ?? 0) > 0 ? tName : target;
        },
        [tName, target],
      );
      // 回边：工具执行完回到模型，形成 ReAct 循环
      builder.addEdge(tName, mName);
    } else {
      builder.addEdge(node.id, target);
    }
  }

  const llmNodes = order.filter((n) => n.type === 'llm');
  const maxSteps = Math.max(1, ...llmNodes.map((n) => asNumber(n.config.maxSteps, 6)));
  const recursionLimit = 12 + order.length * 2 + maxSteps * 2;

  const compiled = builder.compile();

  return {
    nodeIndex,
    recursionLimit,
    maxSteps,
    streamEvents(input, options) {
      return compiled.streamEvents(input, {
        version: 'v2',
        recursionLimit,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
  };
}
