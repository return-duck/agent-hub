/**
 * 模板渲染：{{input.topic}} / {{scratchpad.http_result}}
 *
 * 刻意不支持任意表达式或函数调用 —— 低代码平台里让用户写表达式是安全与可维护性的双重陷阱。
 * 未解析的引用会被替换为空串并给出 warning，warning 会随 node.finished 的日志暴露出来，
 * 而不是静默产出奇怪的 prompt。
 */
export interface TemplateContext {
  input: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
  /** 本节点声明的输入绑定，解析后的值。模板里写成 {{inputs.name}} */
  inputs?: Record<string, unknown>;
}

const REFERENCE = /\{\{\s*([A-Za-z_][\w]*(?:\.[\w]+)*)\s*\}\}/g;
const BRACE = /(?<!\{)\{\s*([A-Za-z_][\w]*)\s*\}(?!\})/g;

export interface RenderResult {
  text: string;
  warnings: string[];
}

export function renderTemplate(template: string, context: TemplateContext): RenderResult {
  const warnings: string[] = [];
  const text = template.replace(REFERENCE, (_match, path: string) => {
    const value = resolvePath(path, context);
    if (value === undefined) {
      warnings.push(`未解析的模板变量: {{${path}}}`);
      return '';
    }
    if (value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
  return { text, warnings };
}

export function resolvePath(path: string, context: TemplateContext): unknown {
  const segments = path.split('.');
  const root = segments[0];
  let current: unknown;
  if (root === 'input') {
    current = context.input;
  } else if (root === 'scratchpad') {
    current = context.scratchpad;
  } else if (root === 'inputs') {
    current = context.inputs ?? {};
  } else {
    return undefined;
  }
  for (const segment of segments.slice(1)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 大模型提示词：`{参数名}` 只替换本节点入参表里的名字。
 * 双花括号 `{{input.x}}` 留给旧的提示词节点，这里不会命中。
 */
export function renderBraceTemplate(
  template: string,
  values: Record<string, unknown>,
): { text: string; error?: string } {
  const problems: string[] = [];
  const text = template.replace(BRACE, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      problems.push(`{${name}} 不是本节点的入参`);
      return match;
    }
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      problems.push(`{${name}} 的值为空`);
      return match;
    }
    if (typeof value === 'object') {
      problems.push(`{${name}} 不能写成文本`);
      return match;
    }
    return String(value);
  });
  if (problems.length > 0) return { text, error: problems.join('；') };
  return { text };
}

export function braceNames(template: string): string[] {
  return [...template.matchAll(BRACE)].map((match) => match[1] as string);
}

/** 抽出模板里引用到的变量路径，供 UI 做"变量可达性"提示 */
export function referencedPaths(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(REFERENCE)) {
    found.add(match[1] as string);
  }
  return [...found];
}
