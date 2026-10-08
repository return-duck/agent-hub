/* eslint-disable */
/**
 * 自动生成，请勿手工修改。
 * 由 scripts/codegen.mjs 从 contracts/node-manifest.json 生成。
 * 重新生成：npm run codegen
 */

export type NodeCategory = "input" | "prompt" | "model" | "output";
export type NodeTypeName = "start" | "prompt" | "llm" | "end";
export type ToolName = "calculator" | "http_get";
export type ConfigWidget =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "multiselect"
  | "variableList";

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
  type: "string" | "number" | "boolean";
  required?: boolean;
  description?: string;
}

/** 各节点类型的配置形状（与 node-manifest.json 的 configSchema 对应） */
export interface StartConfig {
  inputVariables?: VariableDecl[];
}
export interface PromptConfig {
  role?: "system" | "human";
  template: string;
}
export interface LlmConfig {
  system?: string;
  temperature?: number;
  tools?: ToolName[];
  maxSteps?: number;
  outputKey?: string;
}
export interface EndConfig {
  outputKey?: string;
}

export interface NodeTypeSpec {
  type: NodeTypeName;
  displayName: string;
  category: NodeCategory;
  description?: string;
  maxIncoming: number;
  maxOutgoing: number;
  configSchema: NodeConfigSchema;
  uiSchema?: Record<string, { widget?: ConfigWidget; placeholder?: string }>;
}

export interface NodeManifest {
  version: number;
  toolNames: ToolName[];
  nodeTypes: NodeTypeSpec[];
}
