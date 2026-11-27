import type { DatabasePropertySummary, DatabaseRowSummary, JsonValue } from '@rdocs/shared';

import { isoHasTime } from './date-value';

export type DatabaseFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'on_or_before'
  | 'on_or_after'
  | 'is_empty'
  | 'is_not_empty';

export interface DatabaseViewFilter {
  propertyId: string;
  operator: DatabaseFilterOperator;
  value: JsonValue;
}

export interface DatabaseViewSort {
  propertyId: string;
  direction: 'ascending' | 'descending';
}

export type DatabaseAggregation =
  | 'none'
  | 'count_all'
  | 'count_values'
  | 'count_unique'
  | 'sum'
  | 'average'
  | 'min'
  | 'max'
  | 'percent_checked';

export const FILTER_OPERATOR_LABELS: Record<DatabaseFilterOperator, string> = {
  equals: '等于',
  not_equals: '不等于',
  contains: '包含',
  not_contains: '不包含',
  greater_than: '大于',
  less_than: '小于',
  on_or_before: '不晚于',
  on_or_after: '不早于',
  is_empty: '为空',
  is_not_empty: '不为空',
};

export const AGGREGATION_LABELS: Record<DatabaseAggregation, string> = {
  none: '计算',
  count_all: '计数',
  count_values: '已填',
  count_unique: '唯一值',
  sum: '求和',
  average: '平均',
  min: '最小',
  max: '最大',
  percent_checked: '完成率',
};

export interface OptionSwatch {
  background: string;
  color: string;
  /** Dot color for status pills. */
  dot: string;
}

/** Tag colors in the order options are colored: blue, green, yellow, orange, purple, pink, red, brown, gray. */
const OPTION_PALETTE: readonly OptionSwatch[] = [
  { background: 'rgb(211 229 239)', color: 'rgb(24 51 71)', dot: 'rgb(91 151 189)' },
  { background: 'rgb(219 237 219)', color: 'rgb(28 56 41)', dot: 'rgb(108 155 125)' },
  { background: 'rgb(253 236 200)', color: 'rgb(64 44 27)', dot: 'rgb(203 148 52)' },
  { background: 'rgb(250 222 201)', color: 'rgb(73 41 14)', dot: 'rgb(217 115 13)' },
  { background: 'rgb(232 222 238)', color: 'rgb(65 36 84)', dot: 'rgb(154 109 215)' },
  { background: 'rgb(245 224 233)', color: 'rgb(76 35 55)', dot: 'rgb(193 76 138)' },
  { background: 'rgb(255 226 221)', color: 'rgb(93 23 21)', dot: 'rgb(205 60 58)' },
  { background: 'rgb(238 224 218)', color: 'rgb(68 42 30)', dot: 'rgb(140 46 0)' },
  { background: 'rgb(227 226 224)', color: 'rgb(50 48 44)', dot: 'rgb(145 145 142)' },
];

const BLUE = 0;
const GREEN = 1;
const YELLOW = 2;
const ORANGE = 3;
const RED = 6;
const GRAY = 8;

/** Common status and priority words get the color people expect. */
const SEMANTIC_TONES: ReadonlyArray<readonly [RegExp, number]> = [
  [/(已|完)成|^完结$|^done$|^completed?$|已关闭|已上线|已通过|已验收/i, GREEN],
  [/受阻|阻塞|blocked|失败|逾期|^紧急$|^urgent$|^p0$/i, RED],
  [/进行中|处理中|开发中|测试中|审核中|in.?progress|doing/i, BLUE],
  [/暂停|搁置|on.?hold|待确认/i, YELLOW],
  [/未开始|待办|^todo$|not.?started|^规划中$|草稿|^backlog$/i, GRAY],
  [/^高$|^high$|^p1$/i, ORANGE],
  [/^中$|^medium$|^p2$/i, YELLOW],
  [/^低$|^low$|^p3$/i, GRAY],
];

export function optionSwatch(name: string, options?: readonly string[]): OptionSwatch {
  for (const [pattern, tone] of SEMANTIC_TONES) {
    if (pattern.test(name.trim())) return OPTION_PALETTE[tone]!;
  }
  const index = options ? options.indexOf(name) : -1;
  if (index >= 0) return OPTION_PALETTE[index % OPTION_PALETTE.length]!;
  let hash = 0;
  for (let position = 0; position < name.length; position += 1) {
    hash = (hash * 31 + name.charCodeAt(position)) >>> 0;
  }
  return OPTION_PALETTE[hash % OPTION_PALETTE.length]!;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatOneDate(value: string, includeTime: boolean): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!includeTime && day) {
    // Date-only values are UTC midnight; read the calendar day as stored.
    return `${Number(day[1])}年${Number(day[2])}月${Number(day[3])}日`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const text = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  return includeTime ? `${text} ${pad(date.getHours())}:${pad(date.getMinutes())}` : text;
}

/** "2026年11月20日", with time when the value carries one, and "A → B" for ranges. */
export function formatDatabaseDate(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value ? formatOneDate(value, isoHasTime(value)) : '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const start = typeof value.start === 'string' ? value.start : '';
  if (!start) return '';
  const includeTime =
    typeof value.includeTime === 'boolean' ? value.includeTime : isoHasTime(start);
  const end = typeof value.end === 'string' && value.end ? value.end : '';
  const from = formatOneDate(start, includeTime);
  return end ? `${from} → ${formatOneDate(end, includeTime)}` : from;
}

export function formatDatabaseNumber(value: JsonValue | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

/** URL without the scheme and trailing slash, for compact display. */
export function compactUrl(value: string): string {
  return value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** Default table column width for a field type, before the user resizes it. */
export function defaultColumnWidth(type: string): number {
  switch (type) {
    case 'title':
      return 280;
    case 'checkbox':
      return 92;
    case 'number':
    case 'unique_id':
      return 112;
    case 'select':
    case 'status':
      return 132;
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return 156;
    case 'multi_select':
    case 'person':
    case 'relation':
      return 196;
    case 'text':
    case 'formula':
    case 'rollup':
      return 220;
    default:
      return 176;
  }
}

export interface DatabaseRowGroup {
  key: string;
  label: string;
  rows: DatabaseRowSummary[];
}

export interface DatabaseCalendarDay {
  date: string;
  inMonth: boolean;
}

function valueText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if ('start' in value && typeof value.start === 'string') return value.start;
  if ('name' in value && typeof value.name === 'string') return value.name;
  return JSON.stringify(value);
}

function isEmpty(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function comparable(value: JsonValue | undefined): number | string {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return valueText(value).toLocaleLowerCase();
}

export interface DatabaseFilterContext {
  /** The signed-in member, for "is me" person filters. */
  userId?: string | null;
  now?: number;
}

export const RELATIVE_DATE_LABELS = {
  today: '今天',
  tomorrow: '明天',
  yesterday: '昨天',
  this_week: '本周',
  last_week: '上周',
  next_week: '下周',
  this_month: '本月',
  past_7_days: '过去 7 天',
  next_7_days: '未来 7 天',
} as const;
export type RelativeDateToken = keyof typeof RELATIVE_DATE_LABELS;

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Inclusive local-day range ["YYYY-MM-DD", "YYYY-MM-DD"] for a relative date; weeks start on Monday. */
export function relativeDateRange(token: RelativeDateToken, now = Date.now()): [string, string] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = shiftDays(today, -((today.getDay() + 6) % 7));
  switch (token) {
    case 'today':
      return [localDayKey(today), localDayKey(today)];
    case 'tomorrow':
      return [localDayKey(shiftDays(today, 1)), localDayKey(shiftDays(today, 1))];
    case 'yesterday':
      return [localDayKey(shiftDays(today, -1)), localDayKey(shiftDays(today, -1))];
    case 'this_week':
      return [localDayKey(monday), localDayKey(shiftDays(monday, 6))];
    case 'last_week':
      return [localDayKey(shiftDays(monday, -7)), localDayKey(shiftDays(monday, -1))];
    case 'next_week':
      return [localDayKey(shiftDays(monday, 7)), localDayKey(shiftDays(monday, 13))];
    case 'this_month': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return [localDayKey(first), localDayKey(last)];
    }
    case 'past_7_days':
      return [localDayKey(shiftDays(today, -6)), localDayKey(today)];
    case 'next_7_days':
      return [localDayKey(today), localDayKey(shiftDays(today, 6))];
  }
}

/** Local calendar day of a date cell; date-only values keep the stored day. */
export function cellDayKey(value: JsonValue | undefined): string {
  const start =
    typeof value === 'string'
      ? value
      : value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof value.start === 'string'
        ? value.start
        : '';
  if (!start) return '';
  const includeTime =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.includeTime === 'boolean'
      ? value.includeTime
      : !/T00:00(?::00(?:\.0+)?)?Z$/.test(start) && start.includes('T');
  if (!includeTime && /^\d{4}-\d{2}-\d{2}/.test(start)) return start.slice(0, 10);
  const date = new Date(start);
  return Number.isNaN(date.getTime()) ? start.slice(0, 10) : localDayKey(date);
}

function relativeToken(value: JsonValue): RelativeDateToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const token = value.$relative;
  return typeof token === 'string' && token in RELATIVE_DATE_LABELS
    ? (token as RelativeDateToken)
    : null;
}

function isMeToken(value: JsonValue): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.$me === true);
}

/** Text for a filter value in chips: relative dates and "me" read as words. */
export function filterValueLabel(value: JsonValue): string {
  const relative = relativeToken(value);
  if (relative) return RELATIVE_DATE_LABELS[relative];
  if (isMeToken(value)) return '我';
  if (value === true) return '已勾选';
  if (value === false) return '未勾选';
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.start === 'string'
  ) {
    return cellDayKey(value);
  }
  return valueText(value);
}

function filterMatches(
  row: DatabaseRowSummary,
  filter: DatabaseViewFilter,
  context: DatabaseFilterContext = {},
): boolean {
  const value = row.values[filter.propertyId];
  if (filter.operator === 'is_empty') return isEmpty(value);
  if (filter.operator === 'is_not_empty') return !isEmpty(value);

  if (isMeToken(filter.value)) {
    const people = Array.isArray(value)
      ? value
      : value === undefined || value === null
        ? []
        : [value];
    const includesMe = Boolean(context.userId) && people.includes(context.userId!);
    return filter.operator === 'not_equals' || filter.operator === 'not_contains'
      ? !includesMe
      : includesMe;
  }

  const relative = relativeToken(filter.value);
  const isDateFilter =
    relative !== null ||
    (filter.value !== null &&
      typeof filter.value === 'object' &&
      !Array.isArray(filter.value) &&
      typeof filter.value.start === 'string') ||
    (value !== null && typeof value === 'object' && !Array.isArray(value) && 'start' in value);
  if (isDateFilter) {
    const day = cellDayKey(value);
    if (!day) return filter.operator === 'not_equals';
    const [from, to] = relative
      ? relativeDateRange(relative, context.now)
      : [
          cellDayKey(filter.value) || valueText(filter.value).slice(0, 10),
          cellDayKey(filter.value) || valueText(filter.value).slice(0, 10),
        ];
    if (!from) return true;
    switch (filter.operator) {
      case 'equals':
      case 'contains':
        return day >= from && day <= to;
      case 'not_equals':
      case 'not_contains':
        return day < from || day > to;
      case 'on_or_before':
        return day <= to;
      case 'on_or_after':
        return day >= from;
      case 'less_than':
        return day < from;
      case 'greater_than':
        return day > to;
    }
  }

  const text = valueText(value).toLocaleLowerCase();
  const expected = valueText(filter.value).toLocaleLowerCase();
  const list = Array.isArray(value)
    ? value.map((item) => valueText(item).toLocaleLowerCase())
    : null;
  switch (filter.operator) {
    case 'equals':
      return (
        JSON.stringify(value ?? null) === JSON.stringify(filter.value ?? null) ||
        text === expected ||
        Boolean(list?.includes(expected))
      );
    case 'not_equals':
      return (
        JSON.stringify(value ?? null) !== JSON.stringify(filter.value ?? null) &&
        text !== expected &&
        !list?.includes(expected)
      );
    case 'contains':
      return list ? list.some((item) => item.includes(expected)) : text.includes(expected);
    case 'not_contains':
      return list ? !list.some((item) => item.includes(expected)) : !text.includes(expected);
    case 'greater_than':
      return comparable(value) > comparable(filter.value);
    case 'less_than':
      return comparable(value) < comparable(filter.value);
    case 'on_or_before':
      return Boolean(text && expected && text.slice(0, 10) <= expected.slice(0, 10));
    case 'on_or_after':
      return Boolean(text && expected && text.slice(0, 10) >= expected.slice(0, 10));
  }
  return true;
}

/** Filter operators that make sense for a field type, in menu order. */
export function filterOperatorsFor(type: string): DatabaseFilterOperator[] {
  switch (type) {
    case 'checkbox':
      return ['equals'];
    case 'number':
    case 'unique_id':
      return ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return [
        'equals',
        'less_than',
        'greater_than',
        'on_or_before',
        'on_or_after',
        'is_empty',
        'is_not_empty',
      ];
    case 'select':
    case 'status':
      return ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
    case 'multi_select':
    case 'person':
    case 'created_by':
    case 'last_edited_by':
    case 'relation':
    case 'files':
      return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
    default:
      return ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'];
  }
}

/** Operator wording that reads naturally for dates. */
export function filterOperatorLabel(operator: DatabaseFilterOperator, type: string): string {
  if (['date', 'created_time', 'last_edited_time'].includes(type)) {
    const dateLabels: Partial<Record<DatabaseFilterOperator, string>> = {
      equals: '是',
      less_than: '早于',
      greater_than: '晚于',
      on_or_before: '不晚于',
      on_or_after: '不早于',
    };
    return dateLabels[operator] ?? FILTER_OPERATOR_LABELS[operator];
  }
  if (type === 'checkbox' && operator === 'equals') return '是';
  return FILTER_OPERATOR_LABELS[operator];
}

// ── Clipboard ─────────────────────────────────────────────────────────────

/** Parse clipboard text from a spreadsheet: tabs between cells, quoted cells may hold newlines. */
export function parseClipboardGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function parseDayText(text: string): string | null {
  const match =
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text.trim()) ??
    /^(\d{4})(\d{2})(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Turn pasted text into a value for a field, or undefined when the text does
 * not fit (that cell is skipped). Empty text clears the field.
 */
export function parseCellText(
  property: Pick<DatabasePropertySummary, 'type' | 'config'>,
  raw: string,
): JsonValue | undefined {
  const text = raw.trim();
  switch (property.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return property.type === 'title' || property.type === 'text'
        ? raw.replace(/\s+$/, '')
        : text || null;
    case 'number': {
      if (!text) return null;
      const cleaned = text.replace(/[,，\s¥￥$€%]/g, '');
      const number = Number(cleaned);
      if (!Number.isFinite(number)) return undefined;
      return text.endsWith('%') ? number / 100 : number;
    }
    case 'checkbox':
      return /^(true|yes|y|1|是|已完成|完成|✓|✔|☑|勾选|checked)$/i.test(text);
    case 'select':
    case 'status': {
      if (!text) return null;
      const options = optionNamesOf(property.config);
      return options.find((option) => option.toLowerCase() === text.toLowerCase()) ?? text;
    }
    case 'multi_select': {
      if (!text) return [];
      const options = optionNamesOf(property.config);
      return [
        ...new Set(
          text
            .split(/[,，、;；\n]/)
            .map((item) => item.trim())
            .filter(Boolean)
            .map(
              (item) =>
                options.find((option) => option.toLowerCase() === item.toLowerCase()) ?? item,
            ),
        ),
      ];
    }
    case 'date': {
      if (!text) return null;
      const [startText, endText] = text.split(/\s*(?:→|~|～|至|到)\s*/);
      const start = parseDayText(startText ?? '');
      if (!start) return undefined;
      const end = endText ? parseDayText(endText) : null;
      return {
        start: `${start}T00:00:00.000Z`,
        end: end ? `${end}T00:00:00.000Z` : null,
        includeTime: false,
      };
    }
    default:
      return undefined;
  }
}

function optionNamesOf(config: Readonly<Record<string, JsonValue>>): string[] {
  const options = config.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) =>
      typeof option === 'string'
        ? option
        : option &&
            typeof option === 'object' &&
            !Array.isArray(option) &&
            typeof option.name === 'string'
          ? option.name
          : '',
    )
    .filter(Boolean);
}

/** Plain text of a cell for copying; dates as YYYY-MM-DD so they paste back. */
export function cellCopyText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '是' : '';
  if (Array.isArray(value))
    return value
      .map((item) => cellCopyText(item))
      .filter(Boolean)
      .join(', ');
  if (typeof value === 'object' && typeof value.start === 'string') {
    const start = cellDayKey(value);
    const end =
      typeof value.end === 'string' && value.end ? cellDayKey({ ...value, start: value.end }) : '';
    return end ? `${start} → ${end}` : start;
  }
  return valueText(value);
}

function viewFilters(config: Readonly<Record<string, JsonValue>>): DatabaseViewFilter[] {
  if (!Array.isArray(config.filters)) return [];
  return config.filters.flatMap((candidate) => {
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') return [];
    const propertyId = candidate.propertyId;
    const operator = candidate.operator;
    if (typeof propertyId !== 'string' || typeof operator !== 'string') return [];
    if (
      ![
        'equals',
        'not_equals',
        'contains',
        'not_contains',
        'greater_than',
        'less_than',
        'on_or_before',
        'on_or_after',
        'is_empty',
        'is_not_empty',
      ].includes(operator)
    ) {
      return [];
    }
    return [
      {
        propertyId,
        operator: operator as DatabaseFilterOperator,
        value: candidate.value ?? null,
      },
    ];
  });
}

function viewSorts(config: Readonly<Record<string, JsonValue>>): DatabaseViewSort[] {
  if (!Array.isArray(config.sorts)) return [];
  return config.sorts.flatMap((candidate) => {
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') return [];
    const propertyId = candidate.propertyId;
    const direction = candidate.direction;
    return typeof propertyId === 'string' &&
      (direction === 'ascending' || direction === 'descending')
      ? [{ propertyId, direction }]
      : [];
  });
}

export function databaseViewFilters(
  config: Readonly<Record<string, JsonValue>>,
): DatabaseViewFilter[] {
  return viewFilters(config);
}

export function databaseViewSorts(config: Readonly<Record<string, JsonValue>>): DatabaseViewSort[] {
  return viewSorts(config);
}

export function applyDatabaseView(
  rows: readonly DatabaseRowSummary[],
  properties: readonly DatabasePropertySummary[],
  config: Readonly<Record<string, JsonValue>>,
  context: DatabaseFilterContext = {},
): DatabaseRowSummary[] {
  const propertyIds = new Set(properties.map((property) => property.id));
  const filters = viewFilters(config).filter((filter) => propertyIds.has(filter.propertyId));
  const sorts = viewSorts(config).filter((sort) => propertyIds.has(sort.propertyId));
  const matchAny = config.filterMode === 'or';
  const filtered = filters.length
    ? rows.filter((row) =>
        matchAny
          ? filters.some((filter) => filterMatches(row, filter, context))
          : filters.every((filter) => filterMatches(row, filter, context)),
      )
    : [...rows];
  if (!sorts.length) return filtered;
  const originalOrder = new Map(filtered.map((row, index) => [row.id, index]));
  return [...filtered].sort((left, right) => {
    for (const sort of sorts) {
      const leftValue = comparable(left.values[sort.propertyId]);
      const rightValue = comparable(right.values[sort.propertyId]);
      const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      if (comparison) return sort.direction === 'ascending' ? comparison : -comparison;
    }
    return (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0);
  });
}

export function orderedVisibleDatabaseProperties(
  properties: readonly DatabasePropertySummary[],
  config: Readonly<Record<string, JsonValue>>,
): DatabasePropertySummary[] {
  const configuredVisibility = Array.isArray(config.visiblePropertyIds)
    ? config.visiblePropertyIds.filter((id): id is string => typeof id === 'string')
    : null;
  const configuredOrder = Array.isArray(config.propertyOrder)
    ? config.propertyOrder.filter((id): id is string => typeof id === 'string')
    : [];
  const visible = properties.filter(
    (property) =>
      property.type === 'title' ||
      configuredVisibility === null ||
      configuredVisibility.includes(property.id),
  );
  const order = new Map(configuredOrder.map((id, index) => [id, index]));
  return [...visible].sort((left, right) => {
    const leftOrder = order.get(left.id);
    const rightOrder = order.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    }
    return left.sortOrder - right.sortOrder;
  });
}

export function groupDatabaseRows(
  rows: readonly DatabaseRowSummary[],
  propertyId: string | null,
): DatabaseRowGroup[] {
  if (!propertyId) return [{ key: 'all', label: '', rows: [...rows] }];
  const groups = new Map<string, DatabaseRowSummary[]>();
  for (const row of rows) {
    const label = valueText(row.values[propertyId]) || '空';
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return [...groups].map(([label, groupedRows]) => ({
    key: `${propertyId}:${label}`,
    label,
    rows: groupedRows,
  }));
}

export function databaseAggregationValue(
  rows: readonly DatabaseRowSummary[],
  propertyId: string,
  aggregation: DatabaseAggregation,
): string {
  if (aggregation === 'none') return '';
  const values = rows.map((row) => row.values[propertyId]);
  if (aggregation === 'count_all') return String(rows.length);
  const present = values.filter((value) => !isEmpty(value));
  if (aggregation === 'count_values') return String(present.length);
  if (aggregation === 'count_unique') {
    return String(new Set(present.map((value) => JSON.stringify(value))).size);
  }
  if (aggregation === 'percent_checked') {
    const checked = values.filter((value) => value === true).length;
    return `${rows.length ? Math.round((checked / rows.length) * 100) : 0}%`;
  }
  const numbers = present.filter((value): value is number => typeof value === 'number');
  if (!numbers.length) return '—';
  if (aggregation === 'sum') return String(numbers.reduce((total, value) => total + value, 0));
  if (aggregation === 'average') {
    return String(numbers.reduce((total, value) => total + value, 0) / numbers.length);
  }
  if (aggregation === 'min') return String(Math.min(...numbers));
  if (aggregation === 'max') return String(Math.max(...numbers));
  return '—';
}

export function databaseCalendarDays(month: string): DatabaseCalendarDay[] {
  const normalized = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  const first = new Date(`${normalized}-01T00:00:00.000Z`);
  if (Number.isNaN(first.getTime())) return [];
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    const date = day.toISOString().slice(0, 10);
    return { date, inMonth: date.startsWith(normalized) };
  });
}

export function moveDatabaseDate(value: JsonValue | undefined, date: string): JsonValue {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value ?? null;
  if (!value || typeof value === 'string' || Array.isArray(value) || typeof value !== 'object') {
    return date;
  }
  const start = typeof value.start === 'string' ? value.start : '';
  if (!start) return date;
  const originalDay = Date.parse(`${start.slice(0, 10)}T00:00:00.000Z`);
  const targetDay = Date.parse(`${date}T00:00:00.000Z`);
  const shift = targetDay - originalDay;
  const movedStart = `${date}${start.slice(10)}`;
  const end = typeof value.end === 'string' ? value.end : null;
  const movedEnd = end ? new Date(new Date(end).getTime() + shift).toISOString() : null;
  return { ...value, start: movedStart, end: movedEnd };
}

export function databaseDateRange(
  value: JsonValue | undefined,
): { start: string; end: string } | null {
  const rawStart =
    typeof value === 'string'
      ? value
      : value &&
          !Array.isArray(value) &&
          typeof value === 'object' &&
          typeof value.start === 'string'
        ? value.start
        : '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(rawStart)) return null;
  const rawEnd =
    value && !Array.isArray(value) && typeof value === 'object' && typeof value.end === 'string'
      ? value.end
      : rawStart;
  return {
    start: rawStart.slice(0, 10),
    end: /^\d{4}-\d{2}-\d{2}/.test(rawEnd) ? rawEnd.slice(0, 10) : rawStart.slice(0, 10),
  };
}

export function resizeDatabaseDate(
  value: JsonValue | undefined,
  edge: 'start' | 'end',
  date: string,
): JsonValue {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return value ?? null;
  const range = databaseDateRange(value);
  if (!range) return edge === 'start' ? date : { start: date, end: date };
  const objectValue =
    value && !Array.isArray(value) && typeof value === 'object' ? value : { start: range.start };
  const rawStart = typeof objectValue.start === 'string' ? objectValue.start : range.start;
  const rawEnd = typeof objectValue.end === 'string' ? objectValue.end : rawStart;
  if (edge === 'start') {
    const nextStart = date <= range.end ? date : range.end;
    return { ...objectValue, start: `${nextStart}${rawStart.slice(10)}`, end: rawEnd };
  }
  const nextEnd = date >= range.start ? date : range.start;
  return { ...objectValue, start: rawStart, end: `${nextEnd}${rawEnd.slice(10)}` };
}
