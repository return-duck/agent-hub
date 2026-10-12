/**
 * 工具注册表。
 *
 * 工具入参用【JSON Schema】描述（LangChain 的 tool() 直接接受 JSON Schema），
 * 与节点 manifest 的 configSchema 是同一种语言 —— 平台里所有"形状"只有一种表达方式。
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { RuntimeConfig } from '../config.js';
import type { ToolName } from '../generated/manifest.js';
import { evaluateExpression } from './calculator.js';
import { httpGet } from './httpGet.js';

/**
 * 工具类别。调用轨迹按类别分开记录（工具 / MCP / 技能）。
 *
 * 目前只有本地工具这一类的生产者。MCP 与技能尚未实施。
 * 但轨迹与协议已经把它们作为一等类别：将来接入 @langchain/mcp-adapters 或技能包时，
 * 只要在这里登记名字，轨迹页就会自动按类别归类，不需要改协议或数据库。
 */
export type ToolKind = 'tool' | 'mcp' | 'skill';

const TOOL_KINDS: Record<string, ToolKind> = {
  calculator: 'tool',
  http_get: 'tool',
};

export function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'tool';
}

export const CALCULATOR_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description: '要计算的数学表达式，仅支持数字与 + - * / % ^ 和括号，例如 (12+8)*3',
    },
  },
  required: ['expression'],
} as const;

export const HTTP_GET_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: '要抓取的 http/https URL' },
  },
  required: ['url'],
} as const;

export function createTool(name: ToolName, config: RuntimeConfig): StructuredToolInterface {
  if (name === 'calculator') {
    return tool(
      async (input: { expression: string }) => {
        const value = evaluateExpression(input.expression);
        return `${input.expression} = ${value}`;
      },
      {
        name: 'calculator',
        description: '计算数学表达式。当你需要做算术时使用它，不要自己心算。',
        schema: CALCULATOR_INPUT_SCHEMA as unknown as Record<string, unknown>,
      },
    );
  }

  return tool(
    async (input: { url: string }) => {
      const result = await httpGet(input.url, {
        allowlist: config.toolHttpAllowlist,
        timeoutMs: config.toolTimeoutMs,
        maxChars: config.toolResultMaxChars,
      });
      return result.text;
    },
    {
      name: 'http_get',
      description: '抓取一个 http/https 页面或接口的文本内容（受域名白名单限制）。',
      schema: HTTP_GET_INPUT_SCHEMA as unknown as Record<string, unknown>,
    },
  );
}

export function createTools(names: ToolName[], config: RuntimeConfig): StructuredToolInterface[] {
  return names.map((name) => createTool(name, config));
}
