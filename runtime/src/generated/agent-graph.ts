/* eslint-disable */
/**
 * 自动生成，请勿手工修改。
 * 由 scripts/codegen.mjs 从 contracts/agent-graph.schema.json 生成。
 * 重新生成：npm run codegen
 */

/**
 * 画布持久化结构。刻意与 React Flow 的 nodes/edges 形状保持一致，前后端零转换层。
 */
export interface AgentGraph {
  schemaVersion: 1;
  nodes: Node[];
  edges: Edge[];
}
export interface Node {
  id: string;
  /**
   * 节点类型，必须出现在 node-manifest.json 中
   */
  type: "start" | "prompt" | "llm" | "end";
  position: {
    x: number;
    y: number;
  };
  data: {
    label?: string;
    /**
     * 节点配置，形状由 node-manifest.json 中该类型的 configSchema 决定
     */
    config: {};
  };
}
export interface Edge {
  id: string;
  source: string;
  target: string;
}
