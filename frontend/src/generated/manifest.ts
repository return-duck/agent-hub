/* eslint-disable */
/**
 * 自动生成，请勿手工修改。
 * 由 scripts/codegen.mjs 从 contracts/node-manifest.json 生成。
 * 重新生成：npm run codegen
 */

export type NodeCategory = "input" | "prompt" | "model" | "output" | "http" | "code";
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
