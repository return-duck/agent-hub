#!/usr/bin/env node
/**
 * 契约代码生成：contracts/ 是唯一真源，产物同时写入 runtime 与 web。
 * 产物提交进 git，CI 通过 `npm run codegen:check` 断言没有漂移。
 *
 * 为什么用「生成」而不是「共享包」：web / server / runtime 必须能各自独立
 * 安装、构建、部署（不要把三个目录耦合成一个 workspace）。
 */
import { compile } from 'json-schema-to-typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = path.join(ROOT, 'contracts');

/** 产物落地的位置：每个目录都拿到一份自包含副本 */
const TARGETS = [
  path.join(ROOT, 'node', 'src', 'generated'),
  path.join(ROOT, 'frontend', 'src', 'generated'),
];

const banner = (source) =>
  `/* eslint-disable */\n/**\n * 自动生成，请勿手工修改。\n * 由 scripts/codegen.mjs 从 ${source} 生成。\n * 重新生成：npm run codegen\n */\n\n`;

const COMPILE_OPTS = {
  additionalProperties: false,
  bannerComment: '',
  declareExternallyReferenced: true,
  enableConstEnums: false,
};

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(CONTRACTS, rel), 'utf8'));
}

/**
 * node-manifest 没有（也不适合有）JSON Schema——它的 configSchema 字段本身就是 JSON Schema。
 * 这里用一段受控模板作为唯一定义，保证两侧拿到完全一致的接口。
 */
const MANIFEST_TYPES = `export type NodeCategory = "input" | "prompt" | "model" | "output" | "http" | "code";
export type NodeTypeName = "start" | "prompt" | "llm" | "end" | "http" | "code";
export type ToolName = "calculator" | "http_get";
export type PortType = "string" | "number" | "boolean" | "object";
export type ConfigWidget =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "multiselect"
  | "variableList"
  | "binding"
  | "bindingList"
  | "paramTable"
  | "model"
  | "hidden";

export type ParamColumn = "name" | "type" | "description" | "required" | "value";
export type ParamValueMode = "none" | "ref" | "custom";

export interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  placeholder?: string;
  description?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface NodeConfigSchema {
  type: "object";
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
}

export interface VariableDecl {
  name: string;
  type: PortType;
  required?: boolean;
  description?: string;
}

export interface InputBinding {
  mode: "custom" | "ref";
  value?: unknown;
  ref?: string;
}

export interface CodeInputRow extends InputBinding {
  name: string;
  type: PortType;
  description?: string;
}

export interface OutputDecl {
  name: string;
  type: PortType;
  description?: string;
}

export interface LlmInputRow {
  name: string;
  mode?: "custom" | "ref";
  ref?: string;
  value?: unknown;
}

/** 各节点类型的配置形状（与 node-manifest.json 的 configSchema 对应） */
export interface StartConfig {
  inputVariables?: VariableDecl[];
}
export interface PromptConfig {
  role?: "system" | "human";
  template: string | InputBinding;
  outputKey?: string;
}
export interface LlmConfig {
  model?: string;
  inputs?: LlmInputRow[];
  prompt?: string;
  system?: string | InputBinding;
  temperature?: number;
  tools?: ToolName[];
  maxSteps?: number;
  outputKey?: string;
}
export interface HttpConfig {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string | InputBinding;
  headers?: string | InputBinding;
  body?: string | InputBinding;
  outputKey?: string;
  timeoutMs?: number;
}
export interface CodeConfig {
  source: string | InputBinding;
  inputs?: string | CodeInputRow[];
  outputs?: OutputDecl[];
  outputType?: PortType;
  outputKey?: string;
  timeoutMs?: number;
}
export interface EndConfig {
  value?: string | InputBinding;
  params?: CodeInputRow[];
  outputKey?: string;
}

export interface OutputPortSpec {
  name: string;
  type: PortType;
  label?: string;
}

export interface NodeTypeSpec {
  type: NodeTypeName;
  displayName: string;
  category: NodeCategory;
  description?: string;
  palette?: boolean;
  maxIncoming: number;
  maxOutgoing: number;
  outputs?: OutputPortSpec[];
  configSchema: NodeConfigSchema;
  uiSchema?: Record<
    string,
    {
      widget?: ConfigWidget;
      placeholder?: string;
      valueType?: PortType | "any";
      multiline?: boolean;
      label?: string;
      columns?: ParamColumn[];
      valueMode?: ParamValueMode;
      template?: "brace";
    }
  >;
}

export interface NodeManifest {
  version: number;
  toolNames: ToolName[];
  nodeTypes: NodeTypeSpec[];
}
`;

async function main() {
  const graphSchema = await readJson('agent-graph.schema.json');
  const eventsSchema = await readJson('events.schema.json');
  const manifest = await readJson('node-manifest.json');

  const graphTs = await compile(graphSchema, 'AgentGraph', COMPILE_OPTS);
  const eventsTs = await compile(eventsSchema, 'ProtocolEvent', COMPILE_OPTS);

  // 清单内容以 TS 常量形式再生成一份：避免 ESM 下 JSON import assertions
  // 与 tsc 是否把 .json 拷进 dist 的不确定性，且能被类型检查。
  const manifestDataTs =
    `export const nodeManifest = ${JSON.stringify(manifest, null, 2)} as const;\n`;

  for (const dir of TARGETS) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'agent-graph.ts'),
      banner('contracts/agent-graph.schema.json') + graphTs,
    );
    await writeFile(
      path.join(dir, 'events.ts'),
      banner('contracts/events.schema.json') + eventsTs,
    );
    await writeFile(
      path.join(dir, 'manifest.ts'),
      banner('contracts/node-manifest.json') + MANIFEST_TYPES,
    );
    await writeFile(
      path.join(dir, 'manifest-data.ts'),
      banner('contracts/node-manifest.json') + manifestDataTs,
    );
  }

  console.log(`[codegen] 已写入 ${TARGETS.length} 个目录：`);
  for (const t of TARGETS) console.log('  - ' + path.relative(ROOT, t));
}

main().catch((err) => {
  console.error('[codegen] 失败:', err);
  process.exit(1);
});
