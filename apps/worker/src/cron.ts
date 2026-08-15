import type { JsonValue } from '@rdocs/shared';

export function parseSimpleCron(expression: string, from: number): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutePart, hourPart] = parts;
  const minute = minutePart === '*' ? 0 : Number(minutePart);
  const hour = hourPart === '*' ? 0 : Number(hourPart);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const date = new Date(from);
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(minute);
  date.setUTCHours(hour);
  if (date.getTime() <= from) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

export function automationConditionMatches(
  values: Record<string, JsonValue>,
  condition: Record<string, JsonValue> | null,
): boolean {
  if (!condition || typeof condition.propertyId !== 'string') return true;
  const current = values[condition.propertyId];
  const op = condition.op;
  if (op === 'is_empty')
    return current === null || current === undefined || current === '' || current === false;
  if (op === 'not_empty')
    return !(current === null || current === undefined || current === '' || current === false);
  if (op === 'eq') return JSON.stringify(current) === JSON.stringify(condition.value ?? null);
  if (op === 'neq') return JSON.stringify(current) !== JSON.stringify(condition.value ?? null);
  if (op === 'contains') {
    return typeof current === 'string' && typeof condition.value === 'string'
      ? current.includes(condition.value)
      : Array.isArray(current) && current.includes(condition.value as never);
  }
  return true;
}
