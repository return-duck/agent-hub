/**
 * 节点能力的唯一入口。
 *
 * 配置表单完全由 manifest 的 configSchema 生成，前端不认识任何具体节点类型 ——
 * 新增一种节点只需改 contracts/node-manifest.json 并加一个 runtime 执行器，
 * web 一行都不用改（这是"低代码平台"的架构底线）。
 */
import { nodeManifest } from './generated/manifest-data.js';
import type { NodeTypeSpec, ToolName, VariableDecl } from './generated/manifest.js';

export const manifest = nodeManifest;

export function nodeSpec(type: string): NodeTypeSpec | undefined {
  return (nodeManifest.nodeTypes as readonly NodeTypeSpec[]).find((spec) => spec.type === type);
}

export function toolNames(): ToolName[] {
  return [...(nodeManifest.toolNames as readonly ToolName[])];
}

/** 从 configSchema 的 default 值生成一个节点的初始配置 */
export function defaultConfig(type: string): Record<string, unknown> {
  const spec = nodeSpec(type);
  const config: Record<string, unknown> = {};
  const properties = spec?.configSchema.properties ?? {};
  for (const [key, property] of Object.entries(properties)) {
    if (property.default !== undefined) {
      config[key] = structuredClone(property.default);
    } else if (property.type === 'array') {
      config[key] = [];
    } else if (property.type === 'string') {
      config[key] = '';
    }
  }
  return config;
}

export function inputVariablesOf(config: Record<string, unknown> | undefined): VariableDecl[] {
  const raw = config?.['inputVariables'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is VariableDecl => Boolean(item) && typeof item === 'object');
}

export function readConfig(nodeData: { config?: unknown } | undefined): Record<string, unknown> {
  const config = nodeData?.config;
  return config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}
