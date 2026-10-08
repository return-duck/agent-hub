/**
 * 计算器工具的核心：手写 shunting-yard 求值器。
 *
 * 为什么不用 eval / new Function：工具入参来自模型输出，等价于不可信输入，
 * 用 eval 等于把 RCE 风险交给模型。这里只支持数字与 + - * / % ^ ，
 * 任何其它字符直接报错，错误会被 ToolNode 包成 ToolMessage 回灌给模型自我修正。
 */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const BINARY_PRECEDENCE: Record<string, number> = {
  '+': 2,
  '-': 2,
  '*': 3,
  '/': 3,
  '%': 3,
  '^': 4,
};

const UNARY = 'u-';

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let previous: Token | undefined;

  while (i < input.length) {
    const ch = input[i] as string;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      const raw = input.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`非法数字: ${raw}`);
      }
      const token: Token = { kind: 'num', value };
      tokens.push(token);
      previous = token;
      i = j;
      continue;
    }

    if (ch === '(') {
      const token: Token = { kind: 'lparen' };
      tokens.push(token);
      previous = token;
      i += 1;
      continue;
    }

    if (ch === ')') {
      const token: Token = { kind: 'rparen' };
      tokens.push(token);
      previous = token;
      i += 1;
      continue;
    }

    if (ch === '-' && (!previous || previous.kind === 'op' || previous.kind === 'lparen')) {
      const token: Token = { kind: 'op', value: UNARY };
      tokens.push(token);
      previous = token;
      i += 1;
      continue;
    }

    if (ch in BINARY_PRECEDENCE) {
      const token: Token = { kind: 'op', value: ch };
      tokens.push(token);
      previous = token;
      i += 1;
      continue;
    }

    throw new Error(`不支持的字符: ${ch}`);
  }

  return tokens;
}

function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const operators: Token[] = [];

  const precedenceOf = (token: Token): number =>
    token.kind === 'op' ? (token.value === UNARY ? 5 : (BINARY_PRECEDENCE[token.value] as number)) : 0;

  for (const token of tokens) {
    if (token.kind === 'num') {
      output.push(token);
    } else if (token.kind === 'op') {
      while (operators.length > 0) {
        const top = operators[operators.length - 1] as Token;
        if (top.kind !== 'op') break;
        // ^ 与一元负号是右结合的
        const rightAssociative = token.value === '^' || token.value === UNARY;
        if (rightAssociative ? precedenceOf(top) > precedenceOf(token) : precedenceOf(top) >= precedenceOf(token)) {
          output.push(operators.pop() as Token);
        } else {
          break;
        }
      }
      operators.push(token);
    } else if (token.kind === 'lparen') {
      operators.push(token);
    } else {
      let matched = false;
      while (operators.length > 0) {
        const top = operators.pop() as Token;
        if (top.kind === 'lparen') {
          matched = true;
          break;
        }
        output.push(top);
      }
      if (!matched) throw new Error('括号不匹配');
    }
  }

  while (operators.length > 0) {
    const top = operators.pop() as Token;
    if (top.kind === 'lparen') throw new Error('括号不匹配');
    output.push(top);
  }

  return output;
}

export function evaluateExpression(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error('表达式为空');

  const rpn = toRpn(tokenize(trimmed));
  const stack: number[] = [];

  for (const token of rpn) {
    if (token.kind === 'num') {
      stack.push(token.value);
      continue;
    }
    if (token.kind !== 'op') throw new Error('表达式非法');

    if (token.value === UNARY) {
      const operand = stack.pop();
      if (operand === undefined) throw new Error('表达式非法：缺少操作数');
      stack.push(-operand);
      continue;
    }

    const right = stack.pop();
    const left = stack.pop();
    if (left === undefined || right === undefined) throw new Error('表达式非法：缺少操作数');

    switch (token.value) {
      case '+':
        stack.push(left + right);
        break;
      case '-':
        stack.push(left - right);
        break;
      case '*':
        stack.push(left * right);
        break;
      case '/':
        if (right === 0) throw new Error('除数为 0');
        stack.push(left / right);
        break;
      case '%':
        if (right === 0) throw new Error('取模的除数为 0');
        stack.push(left % right);
        break;
      case '^':
        stack.push(left ** right);
        break;
      default:
        throw new Error(`不支持的运算符: ${token.value}`);
    }
  }

  if (stack.length !== 1) throw new Error('表达式非法：操作数数量不匹配');
  const result = stack[0] as number;
  if (!Number.isFinite(result)) throw new Error('计算结果不是有限数');
  return result;
}
