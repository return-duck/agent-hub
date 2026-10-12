import { describe, expect, it } from 'vitest';
import { braceNames, referencedPaths, renderBraceTemplate, renderTemplate } from '../src/compiler/template.js';

describe('模板渲染', () => {
  const context = {
    input: { topic: '(12+8)*3', count: 3 },
    scratchpad: { http_result: { status: 200 } },
  };

  it('替换 input 与 scratchpad 引用', () => {
    expect(renderTemplate('算一下 {{input.topic}}', context).text).toBe('算一下 (12+8)*3');
    expect(renderTemplate('共 {{input.count}} 条', context).text).toBe('共 3 条');
  });

  it('容忍空格，并把对象序列化成 JSON', () => {
    expect(renderTemplate('{{ input.topic }}', context).text).toBe('(12+8)*3');
    expect(renderTemplate('结果 {{scratchpad.http_result}}', context).text).toBe('结果 {"status":200}');
  });

  it('未解析的变量替换为空串，并且一定给出 warning（不静默产出怪 prompt）', () => {
    const result = renderTemplate('值={{input.missing}}', context);
    expect(result.text).toBe('值=');
    expect(result.warnings).toEqual(['未解析的模板变量: {{input.missing}}']);
  });

  it('不把未声明的根对象当作变量解析', () => {
    const result = renderTemplate('{{env.SECRET}}', context);
    expect(result.text).toBe('');
    expect(result.warnings).toHaveLength(1);
  });

  it('大模型提示词用单层花括号替换入参，双花括号仍留给旧模板', () => {
    expect(renderBraceTemplate('给定一个主题: {topic}, 写一个故事', { topic: '海边' }).text).toBe(
      '给定一个主题: 海边, 写一个故事',
    );
    expect(renderBraceTemplate('保留 {{input.topic}}', { topic: '海边' }).text).toBe('保留 {{input.topic}}');
    expect(renderBraceTemplate('缺失 {topic}', {}).error).toContain('{topic}');
    expect(renderBraceTemplate('空 {topic}', { topic: '' }).error).toContain('为空');
    expect(renderBraceTemplate('对象 {topic}', { topic: { a: 1 } }).error).toContain('不能写成文本');
    expect(braceNames('你好 {topic}，再看 {topic}')).toEqual(['topic', 'topic']);
  });

  it('referencedPaths 供 UI 做变量可达性提示', () => {
    expect(referencedPaths('{{input.a}} 和 {{scratchpad.b}} 和 {{input.a}}').sort()).toEqual([
      'input.a',
      'scratchpad.b',
    ]);
  });
});
