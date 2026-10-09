import { create } from 'zustand';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import type { AgentGraph } from '../generated/agent-graph.js';
import { api, ApiError, subscribeToRun, type AgentSummary, type Capabilities, type RunSubscription } from '../api/client.js';
import { defaultConfig, nodeSpec } from '../manifest.js';
import {
  appendUserMessage,
  initialRunState,
  reduceRunEvent,
  type RunState,
} from './runReducer.js';

export type AgentNodeData = {
  label: string;
  config: Record<string, unknown>;
};
export type AgentNode = Node<AgentNodeData, string>;

const STARTER_GRAPH: AgentGraph = {
  schemaVersion: 1,
  nodes: [
    node('n1', 'start', 40, 140, { inputVariables: [{ name: 'topic', type: 'string', required: true }] }),
    node('n2', 'prompt', 300, 140, { role: 'human', template: '请帮我算一下：{{input.topic}}' }),
    node('n3', 'llm', 560, 140, {
      system: '你是一个严谨的助手。需要做算术时，调用 calculator 工具，不要自己心算。',
      temperature: 0.2,
      tools: ['calculator'],
      maxSteps: 6,
      outputKey: 'answer',
    }),
    node('n4', 'end', 820, 140, { outputKey: 'answer' }),
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2' },
    { id: 'e2', source: 'n2', target: 'n3' },
    { id: 'e3', source: 'n3', target: 'n4' },
  ],
};

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  config: Record<string, unknown>,
): AgentGraph['nodes'][number] {
  return {
    id,
    type: type as AgentGraph['nodes'][number]['type'],
    position: { x, y },
    data: { label: labelOf(type), config },
  };
}

function labelOf(type: string): string {
  return nodeSpec(type)?.displayName ?? type;
}

/** 画布 → 契约：只保留契约里定义的字段，剥掉 React Flow 的运行期字段（selected/dragging/measured…） */
export function toGraphPayload(nodes: AgentNode[], edges: Edge[]): AgentGraph {
  return {
    schemaVersion: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as AgentGraph['nodes'][number]['type'],
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: { label: n.data.label, config: n.data.config },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

/** 契约 → 画布 */
export function fromGraphPayload(graph: AgentGraph): { nodes: AgentNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { label: n.data.label ?? labelOf(n.type), config: (n.data.config ?? {}) as Record<string, unknown> },
    })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

export interface StudioState {
  agents: AgentSummary[];
  capabilities: Capabilities | null;
  loading: boolean;
  notice: { kind: 'info' | 'error' | 'success'; text: string; detail?: string } | null;

  agentId: string | null;
  name: string;
  description: string;
  nodes: AgentNode[];
  edges: Edge[];
  dirty: boolean;
  published: boolean;
  publicSlug: string | null;
  selectedNodeId: string | null;

  run: RunState;
  conversationId: string | null;
  subscription: RunSubscription | null;

  bootstrap: () => Promise<void>;
  newAgent: () => void;
  selectAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;

  onNodesChange: (changes: NodeChange<AgentNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (type: string, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
  setLabel: (id: string, label: string) => void;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  clearNotice: () => void;

  save: () => Promise<string | null>;
  publishAgent: () => Promise<void>;
  unpublishAgent: () => Promise<void>;
  runWithInput: (input: Record<string, unknown>) => Promise<void>;
  resetRun: () => void;
}

export const useStudio = create<StudioState>((set, get) => ({
  agents: [],
  capabilities: null,
  loading: false,
  notice: null,

  agentId: null,
  name: '未命名 agent',
  description: '',
  nodes: fromGraphPayload(STARTER_GRAPH).nodes,
  edges: fromGraphPayload(STARTER_GRAPH).edges,
  dirty: true,
  published: false,
  publicSlug: null,
  selectedNodeId: null,

  run: initialRunState,
  conversationId: null,
  subscription: null,

  bootstrap: async () => {
    set({ loading: true });
    try {
      const [agents, capabilities] = await Promise.all([
        api.listAgents(),
        api.capabilities().catch(() => null),
      ]);
      set({ agents, capabilities, loading: false });
    } catch (error) {
      set({ loading: false, notice: { kind: 'error', text: describe(error) } });
    }
  },

  newAgent: () => {
    get().subscription?.close();
    const { nodes, edges } = fromGraphPayload(STARTER_GRAPH);
    set({
      agentId: null,
      name: '未命名 agent',
      description: '',
      nodes,
      edges,
      dirty: true,
      selectedNodeId: null,
      conversationId: null,
      run: initialRunState,
      subscription: null,
      notice: { kind: 'info', text: '已新建草稿：改好名字后点「保存」' },
    });
  },

  selectAgent: async (id) => {
    get().subscription?.close();
    set({ loading: true });
    try {
      const agent = await api.getAgent(id);
      const { nodes, edges } = fromGraphPayload(agent.graph);
      set({
        agentId: agent.id,
        name: agent.name,
        description: agent.description ?? '',
        nodes,
        edges,
        dirty: false,
        published: agent.published,
        publicSlug: agent.publicSlug,
        selectedNodeId: null,
        conversationId: null,
        run: initialRunState,
        subscription: null,
        loading: false,
        notice: null,
      });
    } catch (error) {
      set({ loading: false, notice: { kind: 'error', text: describe(error) } });
    }
  },

  removeAgent: async (id) => {
    try {
      await api.deleteAgent(id);
      const agents = await api.listAgents();
      set({ agents, notice: { kind: 'success', text: '已删除' } });
      if (get().agentId === id) {
        get().newAgent();
      }
    } catch (error) {
      set({ notice: { kind: 'error', text: describe(error) } });
    }
  },

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes), dirty: true });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges), dirty: true });
  },

  onConnect: (connection) => {
    set({ edges: addEdge({ ...connection, id: `e-${Date.now()}` }, get().edges), dirty: true });
  },

  addNode: (type, position) => {
    const spec = nodeSpec(type);
    if (!spec) return;
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    const newNode: AgentNode = {
      id,
      type,
      position,
      data: { label: spec.displayName, config: defaultConfig(type) },
    };
    set({ nodes: [...get().nodes, newNode], dirty: true, selectedNodeId: id });
  },

  removeNode: (id) => {
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      dirty: true,
      selectedNodeId: null,
    });
  },

  selectNode: (id) => set({ selectedNodeId: id }),

  updateNodeConfig: (id, patch) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n,
      ),
      dirty: true,
    });
  },

  setLabel: (id, label) => {
    set({
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)),
      dirty: true,
    });
  },

  setName: (name) => set({ name, dirty: true }),
  setDescription: (description) => set({ description, dirty: true }),
  clearNotice: () => set({ notice: null }),

  save: async () => {
    const { agentId, name, description, nodes, edges } = get();
    if (!name.trim()) {
      set({ notice: { kind: 'error', text: '请先给 agent 起个名字' } });
      return null;
    }
    try {
      const graph = toGraphPayload(nodes, edges);
      const saved = agentId
        ? await api.updateAgent(agentId, name, description, graph)
        : await api.createAgent(name, description, graph);
      const agents = await api.listAgents();
      set({
        agentId: saved.id,
        agents,
        dirty: false,
        notice: { kind: 'success', text: `已保存「${saved.name}」` },
      });
      return saved.id;
    } catch (error) {
      const detail = error instanceof ApiError && error.details.length > 0 ? error.detailText : undefined;
      set({ notice: { kind: 'error', text: describe(error), detail } });
      return null;
    }
  },

  /**
   * 发布 / 取消发布。
   *
   * 发布前先保存：否则用户改了图直接点发布，公开页跑的还是上一次存下来的版本。
   * 发布是幂等的，重复点不会让链接变来变去。
   */
  publishAgent: async () => {
    const id = await get().save();
    if (!id) return;
    set({ loading: true });
    try {
      const result = await api.publishAgent(id);
      const agents = await api.listAgents();
      set({
        published: result.published,
        publicSlug: result.slug,
        agents,
        loading: false,
        notice: { kind: 'success', text: `已发布：${result.publicPath ?? result.slug}` },
      });
    } catch (error) {
      set({ loading: false, notice: { kind: 'error', text: describe(error) } });
    }
  },

  unpublishAgent: async () => {
    const id = get().agentId;
    if (!id) return;
    set({ loading: true });
    try {
      const result = await api.unpublishAgent(id);
      const agents = await api.listAgents();
      set({
        published: false,
        publicSlug: result.slug,
        agents,
        loading: false,
        notice: { kind: 'info', text: '已取消发布，公开链接立即失效' },
      });
    } catch (error) {
      set({ loading: false, notice: { kind: 'error', text: describe(error) } });
    }
  },

  runWithInput: async (input) => {
    const state = get();
    if (!state.agentId) {
      const id = await state.save();
      if (!id) return; // 保存失败（例如图不合法）：错误已经展示给用户
      set({ agentId: id });
    } else if (state.dirty) {
      // 运行的一定是画布上当前这张图，而不是上次保存的版本
      const id = await get().save();
      if (!id) return;
    }

    const agentId = get().agentId as string;
    const withUser = appendUserMessage(initialRunState, renderInput(input));

    get().subscription?.close();
    set({ run: { ...withUser, status: 'running' }, notice: null });

    try {
      const { runId, conversationId } = await api.startRun(agentId, input, get().conversationId ?? undefined);
      set({ conversationId });
      const subscription = subscribeToRun(
        runId,
        (event) => set((current) => ({ run: reduceRunEvent(current.run, event) })),
        (message) => set({ notice: { kind: 'info', text: message } }),
      );
      set({ subscription });
    } catch (error) {
      set({
        run: { ...get().run, status: 'failed', error: { code: 'REQUEST_FAILED', message: describe(error) } },
        notice: { kind: 'error', text: describe(error) },
      });
    }
  },

  resetRun: () => {
    get().subscription?.close();
    set({ run: initialRunState, subscription: null, conversationId: null });
  },
}));

function renderInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '(空输入)';
  if (entries.length === 1) return String(entries[0]?.[1] ?? '');
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join('\n');
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.details.length > 0 ? `（${error.details.length} 个问题）` : ''}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
