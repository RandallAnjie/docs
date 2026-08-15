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
