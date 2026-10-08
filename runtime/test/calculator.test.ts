import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../src/tools/calculator.js';

describe('calculator 求值器', () => {
  it('算出基本四则运算', () => {
    expect(evaluateExpression('1+1')).toBe(2);
    expect(evaluateExpression('(12+8)*3')).toBe(60);
    expect(evaluateExpression('7/2')).toBe(3.5);
    expect(evaluateExpression('10 % 3')).toBe(1);
  });

  it('遵守优先级与括号', () => {
    expect(evaluateExpression('2+3*4')).toBe(14);
    expect(evaluateExpression('(2+3)*4')).toBe(20);
    expect(evaluateExpression('2*(3+(4-1))')).toBe(12);
  });

  it('支持一元负号与右结合的乘方', () => {
    expect(evaluateExpression('-5+2')).toBe(-3);
    expect(evaluateExpression('3--2')).toBe(5);
    expect(evaluateExpression('2^3^2')).toBe(512);
  });

  it('除数为 0 时给出可读错误（会被 ToolNode 包成 ToolMessage 回灌给模型）', () => {
    expect(() => evaluateExpression('1/0')).toThrow(/除数为 0/);
    expect(() => evaluateExpression('5%0')).toThrow(/除数为 0/);
  });

  it('拒绝任何非数学字符 —— 这是不用 eval 的意义所在', () => {
    expect(() => evaluateExpression('process.exit(1)')).toThrow(/不支持的字符/);
    expect(() => evaluateExpression('1; require("fs")')).toThrow(/不支持的字符/);
    expect(() => evaluateExpression('`whoami`')).toThrow(/不支持的字符/);
    expect(() => evaluateExpression('1+')).toThrow();
  });

  it('拒绝括号不匹配与非法数字', () => {
    expect(() => evaluateExpression('(1+2')).toThrow(/括号不匹配/);
    expect(() => evaluateExpression('1+2)')).toThrow(/括号不匹配/);
    expect(() => evaluateExpression('1.2.3')).toThrow(/非法数字/);
    expect(() => evaluateExpression('   ')).toThrow(/表达式为空/);
  });
});
