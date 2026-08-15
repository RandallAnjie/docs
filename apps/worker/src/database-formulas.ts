import type { JsonValue } from '@rdocs/shared';

type FormulaValue = JsonValue | undefined;

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'punctuation'; value: '(' | ')' | ',' | '.' }
  | { type: 'eof' };

export interface FormulaResult {
  value: JsonValue;
  error: string | null;
}

const MAX_FORMULA_LENGTH = 2_000;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;

const PRECEDENCE: Record<string, number> = {
  or: 1,
  '||': 1,
  and: 2,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '>': 4,
  '>=': 4,
  '<': 4,
  '<=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 7,
};

function tokenize(source: string): Token[] {
  if (!source.trim()) return [{ type: 'eof' }];
  if (source.length > MAX_FORMULA_LENGTH) throw new Error('公式超过长度上限');
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const match = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
      if (!match) throw new Error('数字格式无效');
      tokens.push({ type: 'number', value: Number(match[0]) });
      index += match[0].length;
    } else if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index] ?? '';
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (current === '\\') {
          const escaped = source[index + 1] ?? '';
          const replacements: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            '\\': '\\',
            '"': '"',
            "'": "'",
          };
          value += replacements[escaped] ?? escaped;
          index += 2;
        } else {
          value += current;
          index += 1;
        }
      }
      if (!closed) throw new Error('字符串缺少结束引号');
      tokens.push({ type: 'string', value });
    } else if (/[A-Za-z_\p{L}]/u.test(character)) {
      const match = source.slice(index).match(/^[\p{L}\p{N}_]+/u);
      if (!match) throw new Error('标识符无效');
      const normalized = match[0].toLowerCase();
      if (normalized === 'and' || normalized === 'or' || normalized === 'not') {
        tokens.push({ type: 'operator', value: normalized });
      } else {
        tokens.push({ type: 'identifier', value: match[0] });
      }
      index += match[0].length;
    } else {
      const pair = source.slice(index, index + 2);
      if (['==', '!=', '>=', '<=', '&&', '||'].includes(pair)) {
        tokens.push({ type: 'operator', value: pair });
        index += 2;
      } else if ('+-*/%^><'.includes(character)) {
        tokens.push({ type: 'operator', value: character });
        index += 1;
      } else if ('(),.'.includes(character)) {
        tokens.push({ type: 'punctuation', value: character as '(' | ')' | ',' | '.' });
        index += 1;
      } else {
        throw new Error(`公式包含不支持的字符：${character}`);
      }
    }
    if (tokens.length > MAX_TOKENS) throw new Error('公式过于复杂');
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

function isEmpty(value: FormulaValue): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function asNumber(value: FormulaValue): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  return 0;
}

function asString(value: FormulaValue): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asBoolean(value: FormulaValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function comparable(value: FormulaValue): number | string {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return asString(value);
}

function numericList(values: FormulaValue[]): number[] {
  return values.flatMap((value) => (Array.isArray(value) ? value : [value])).map(asNumber);
}

function parseDate(value: FormulaValue): Date | null {
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function callFunction(name: string, arguments_: FormulaValue[], now: Date): FormulaValue {
  const normalized = name.toLowerCase();
  switch (normalized) {
    case 'if':
      return asBoolean(arguments_[0]) ? arguments_[1] : arguments_[2];
    case 'ifs':
      for (let index = 0; index < arguments_.length - 1; index += 2) {
        if (asBoolean(arguments_[index])) return arguments_[index + 1];
      }
      return arguments_.length % 2 === 1 ? arguments_.at(-1) : null;
    case 'empty':
      return isEmpty(arguments_[0]);
    case 'length':
      return Array.isArray(arguments_[0]) ? arguments_[0].length : asString(arguments_[0]).length;
    case 'concat':
      return arguments_.map(asString).join('');
    case 'lower':
      return asString(arguments_[0]).toLocaleLowerCase();
    case 'upper':
      return asString(arguments_[0]).toLocaleUpperCase();
    case 'trim':
      return asString(arguments_[0]).trim();
    case 'replace':
      return asString(arguments_[0]).replace(asString(arguments_[1]), asString(arguments_[2]));
    case 'contains':
    case 'includes':
      return Array.isArray(arguments_[0])
        ? arguments_[0].some((value) => JSON.stringify(value) === JSON.stringify(arguments_[1]))
        : asString(arguments_[0]).includes(asString(arguments_[1]));
    case 'startswith':
      return asString(arguments_[0]).startsWith(asString(arguments_[1]));
    case 'endswith':
      return asString(arguments_[0]).endsWith(asString(arguments_[1]));
    case 'format':
      return asString(arguments_[0]);
    case 'tonumber':
      return asNumber(arguments_[0]);
    case 'round':
      return Math.round(asNumber(arguments_[0]));
    case 'ceil':
      return Math.ceil(asNumber(arguments_[0]));
    case 'floor':
      return Math.floor(asNumber(arguments_[0]));
    case 'abs':
      return Math.abs(asNumber(arguments_[0]));
    case 'sqrt':
      return Math.sqrt(asNumber(arguments_[0]));
    case 'pow':
      return Math.pow(asNumber(arguments_[0]), asNumber(arguments_[1]));
    case 'min':
      return Math.min(...numericList(arguments_));
    case 'max':
      return Math.max(...numericList(arguments_));
    case 'sum':
      return numericList(arguments_).reduce((total, value) => total + value, 0);
    case 'average': {
      const values = numericList(arguments_);
      return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
    }
    case 'first':
      return Array.isArray(arguments_[0]) ? arguments_[0][0] : (asString(arguments_[0])[0] ?? null);
    case 'last':
      return Array.isArray(arguments_[0])
        ? (arguments_[0].at(-1) ?? null)
        : (asString(arguments_[0]).at(-1) ?? null);
    case 'at': {
      const value = arguments_[0];
      const index = asNumber(arguments_[1]);
      return Array.isArray(value) ? (value[index] ?? null) : (asString(value)[index] ?? null);
    }
    case 'join':
      return Array.isArray(arguments_[0])
        ? arguments_[0].map(asString).join(asString(arguments_[1]))
        : asString(arguments_[0]);
    case 'unique':
      return Array.isArray(arguments_[0])
        ? [...new Map(arguments_[0].map((value) => [JSON.stringify(value), value])).values()]
        : arguments_[0];
    case 'now':
      return now.toISOString();
    case 'today': {
      const today = new Date(now);
      today.setUTCHours(0, 0, 0, 0);
      return today.toISOString();
    }
    case 'timestamp':
      return parseDate(arguments_[0])?.getTime() ?? null;
    case 'fromtimestamp': {
      const date = parseDate(asNumber(arguments_[0]));
      return date?.toISOString() ?? null;
    }
    case 'dateadd': {
      const date = parseDate(arguments_[0]);
      if (!date) return null;
      const amount = asNumber(arguments_[1]);
      const unit = asString(arguments_[2]).toLowerCase();
      const multipliers: Record<string, number> = {
        millisecond: 1,
        milliseconds: 1,
        second: 1_000,
        seconds: 1_000,
        minute: 60_000,
        minutes: 60_000,
        hour: 3_600_000,
        hours: 3_600_000,
        day: 86_400_000,
        days: 86_400_000,
        week: 604_800_000,
        weeks: 604_800_000,
      };
      if (unit === 'month' || unit === 'months') date.setUTCMonth(date.getUTCMonth() + amount);
      else if (unit === 'year' || unit === 'years')
        date.setUTCFullYear(date.getUTCFullYear() + amount);
      else date.setTime(date.getTime() + amount * (multipliers[unit] ?? 0));
      return date.toISOString();
    }
    case 'datebetween': {
      const first = parseDate(arguments_[0]);
      const second = parseDate(arguments_[1]);
      if (!first || !second) return null;
      const difference = first.getTime() - second.getTime();
      const divisors: Record<string, number> = {
        milliseconds: 1,
        seconds: 1_000,
        minutes: 60_000,
        hours: 3_600_000,
        days: 86_400_000,
        weeks: 604_800_000,
      };
      return Math.trunc(difference / (divisors[asString(arguments_[2]).toLowerCase()] ?? 1));
    }
    case 'year':
      return parseDate(arguments_[0])?.getUTCFullYear() ?? null;
    case 'month':
      return (parseDate(arguments_[0])?.getUTCMonth() ?? -1) + 1;
    case 'day':
      return parseDate(arguments_[0])?.getUTCDate() ?? null;
    default:
      throw new Error(`不支持的公式函数：${name}`);
  }
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly properties: Readonly<Record<string, JsonValue>>,
    private readonly now: Date,
  ) {}

  parse(): FormulaValue {
    const result = this.expression(0, 0);
    if (this.current().type !== 'eof') throw new Error('公式末尾存在多余内容');
    return result;
  }

  private current(): Token {
    return this.tokens[this.index] ?? { type: 'eof' };
  }

  private consume(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }

  private punctuation(value: '(' | ')' | ',' | '.'): boolean {
    const token = this.current();
    if (token.type !== 'punctuation' || token.value !== value) return false;
    this.consume();
    return true;
  }

  private expression(minimumPrecedence: number, depth: number): FormulaValue {
    if (depth > MAX_DEPTH) throw new Error('公式嵌套过深');
    let left = this.unary(depth + 1);
    while (true) {
      const token = this.current();
      if (token.type !== 'operator') break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minimumPrecedence) break;
      this.consume();
      const right = this.expression(precedence + (token.value === '^' ? 0 : 1), depth + 1);
      left = this.binary(token.value, left, right);
    }
    return left;
  }

  private unary(depth: number): FormulaValue {
    const token = this.current();
    if (token.type === 'operator' && ['-', '+', 'not'].includes(token.value)) {
      this.consume();
      const value = this.unary(depth + 1);
      if (token.value === '-') return -asNumber(value);
      if (token.value === '+') return asNumber(value);
      return !asBoolean(value);
    }
    let value = this.primary(depth + 1);
    while (this.punctuation('.')) {
      const method = this.consume();
      if (method.type !== 'identifier') throw new Error('方法名无效');
      if (!this.punctuation('(')) throw new Error('方法调用缺少左括号');
      const arguments_ = this.arguments(depth + 1);
      value = callFunction(method.value, [value, ...arguments_], this.now);
    }
    return value;
  }

  private primary(depth: number): FormulaValue {
    const token = this.consume();
    if (token.type === 'number' || token.type === 'string') return token.value;
    if (token.type === 'punctuation' && token.value === '(') {
      const value = this.expression(0, depth + 1);
      if (!this.punctuation(')')) throw new Error('公式缺少右括号');
      return value;
    }
    if (token.type !== 'identifier') throw new Error('公式表达式无效');
    const normalized = token.value.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (normalized === 'null') return null;
    if (!this.punctuation('(')) throw new Error(`未知标识符：${token.value}`);
    const arguments_ = this.arguments(depth + 1);
    if (normalized === 'prop') {
      const name = arguments_[0];
      if (typeof name !== 'string') throw new Error('prop() 需要属性名');
      return this.properties[name];
    }
    return callFunction(token.value, arguments_, this.now);
  }

  private arguments(depth: number): FormulaValue[] {
    const values: FormulaValue[] = [];
    if (this.punctuation(')')) return values;
    do {
      values.push(this.expression(0, depth + 1));
    } while (this.punctuation(','));
    if (!this.punctuation(')')) throw new Error('函数调用缺少右括号');
    return values;
  }

  private binary(operator: string, left: FormulaValue, right: FormulaValue): FormulaValue {
    switch (operator) {
      case 'or':
      case '||':
        return asBoolean(left) || asBoolean(right);
      case 'and':
      case '&&':
        return asBoolean(left) && asBoolean(right);
      case '==':
        return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
      case '!=':
        return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
      case '>':
        return comparable(left) > comparable(right);
      case '>=':
        return comparable(left) >= comparable(right);
      case '<':
        return comparable(left) < comparable(right);
      case '<=':
        return comparable(left) <= comparable(right);
      case '+':
        return typeof left === 'string' || typeof right === 'string'
          ? asString(left) + asString(right)
          : asNumber(left) + asNumber(right);
      case '-':
        return asNumber(left) - asNumber(right);
      case '*':
        return asNumber(left) * asNumber(right);
      case '/':
        return asNumber(right) === 0 ? null : asNumber(left) / asNumber(right);
      case '%':
        return asNumber(right) === 0 ? null : asNumber(left) % asNumber(right);
      case '^':
        return Math.pow(asNumber(left), asNumber(right));
      default:
        throw new Error(`不支持的运算符：${operator}`);
    }
  }
}

function serializable(value: FormulaValue): JsonValue {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function evaluateDatabaseFormula(
  source: string,
  properties: Readonly<Record<string, JsonValue>>,
  now = new Date(),
): FormulaResult {
  try {
    const value = new Parser(tokenize(source), properties, now).parse();
    return { value: serializable(value), error: null };
  } catch (reason) {
    return {
      value: null,
      error: reason instanceof Error ? reason.message : '公式计算失败',
    };
  }
}
