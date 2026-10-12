/**
 * 画布图的领域模型。
 *
 * 关键取舍：持久化结构直接沿用 React Flow 的 nodes/edges 形状，
 * 因此这里没有"前端 DTO → 后端 DTO"的转换层，schema 只承担文档与校验职责。
 */
import type { NodeTypeName, ToolName } from '../generated/manifest.js';

export interface GraphNode {
  id: string;
  type: NodeTypeName;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphSpec {
  schemaVersion: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const SUPPORTED_SCHEMA_VERSION = 1;

export function toToolNames(raw: unknown): ToolName[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(['calculator', 'http_get']);
  return raw.filter((v): v is ToolName => typeof v === 'string' && allowed.has(v));
}

export function asNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

export function asString(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' ? raw : fallback;
}
