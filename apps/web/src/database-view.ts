import type { DatabasePropertySummary, DatabaseRowSummary, JsonValue } from '@rdocs/shared';

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
  count_all: '计数',
  count_values: '已填',
  count_unique: '唯一值',
  sum: '求和',
  average: '平均',
  min: '最小',
  max: '最大',
  percent_checked: '完成率',
};

const OPTION_SWATCHES = [
  { background: '#eeebe4', color: '#5c5850' },
  { background: '#e4eee6', color: '#3d5c42' },
  { background: '#e4ebf4', color: '#3d5270' },
  { background: '#f3e6e1', color: '#8a4b38' },
  { background: '#f3ead8', color: '#7a5c24' },
  { background: '#ece6f2', color: '#5a4570' },
  { background: '#e6f0ef', color: '#2f5c58' },
  { background: '#f0e6ea', color: '#704050' },
] as const;

export function optionSwatch(name: string): { background: string; color: string } {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return OPTION_SWATCHES[hash % OPTION_SWATCHES.length] ?? OPTION_SWATCHES[0];
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

function filterMatches(row: DatabaseRowSummary, filter: DatabaseViewFilter): boolean {
  const value = row.values[filter.propertyId];
  const text = valueText(value).toLocaleLowerCase();
  const expected = valueText(filter.value).toLocaleLowerCase();
  switch (filter.operator) {
    case 'equals':
      return (
        JSON.stringify(value ?? null) === JSON.stringify(filter.value ?? null) || text === expected
      );
    case 'not_equals':
      return (
        JSON.stringify(value ?? null) !== JSON.stringify(filter.value ?? null) && text !== expected
      );
    case 'contains':
      return text.includes(expected);
    case 'not_contains':
      return !text.includes(expected);
    case 'greater_than':
      return comparable(value) > comparable(filter.value);
    case 'less_than':
      return comparable(value) < comparable(filter.value);
    case 'on_or_before':
      return Boolean(text && expected && text.slice(0, 10) <= expected.slice(0, 10));
    case 'on_or_after':
      return Boolean(text && expected && text.slice(0, 10) >= expected.slice(0, 10));
    case 'is_empty':
      return isEmpty(value);
    case 'is_not_empty':
      return !isEmpty(value);
  }
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
): DatabaseRowSummary[] {
  const propertyIds = new Set(properties.map((property) => property.id));
  const filters = viewFilters(config).filter((filter) => propertyIds.has(filter.propertyId));
  const sorts = viewSorts(config).filter((sort) => propertyIds.has(sort.propertyId));
  const matchAny = config.filterMode === 'or';
  const filtered = filters.length
    ? rows.filter((row) =>
        matchAny
          ? filters.some((filter) => filterMatches(row, filter))
          : filters.every((filter) => filterMatches(row, filter)),
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
