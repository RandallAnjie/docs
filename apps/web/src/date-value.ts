import type { JsonValue } from '@rdocs/shared';

export type DateCellValue = {
  end: string | null;
  includeTime: boolean;
  start: string;
  timezone: string | null;
};

/**
 * Date-only values are stored as UTC midnight ISO strings, so a "T" alone does
 * not mean the value has a time of day.
 */
export function isoHasTime(value: string): boolean {
  return value.includes('T') && !/T00:00(?::00(?:\.0+)?)?Z$/.test(value);
}

export function parseDateCell(value: JsonValue | undefined): DateCellValue | null {
  if (typeof value === 'string') {
    const start = new Date(value);
    return Number.isNaN(start.getTime())
      ? null
      : { start: start.toISOString(), end: null, includeTime: isoHasTime(value), timezone: null };
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  if (typeof value.start !== 'string') return null;
  const start = new Date(value.start);
  if (Number.isNaN(start.getTime())) return null;
  const end =
    typeof value.end === 'string' && !Number.isNaN(new Date(value.end).getTime())
      ? new Date(value.end).toISOString()
      : null;
  return {
    start: start.toISOString(),
    end,
    includeTime:
      typeof value.includeTime === 'boolean' ? value.includeTime : isoHasTime(value.start),
    timezone: typeof value.timezone === 'string' ? value.timezone : null,
  };
}

export function datePart(iso: string, includeTime: boolean): string {
  return includeTime ? iso.slice(0, 16) : iso.slice(0, 10);
}

export function fromDateParts(
  start: string,
  end: string,
  includeTime: boolean,
): DateCellValue | null {
  if (!start) return null;
  const startIso = new Date(includeTime ? start : `${start}T00:00:00.000Z`).toISOString();
  const endIso = end ? new Date(includeTime ? end : `${end}T00:00:00.000Z`).toISOString() : null;
  if (Number.isNaN(new Date(startIso).getTime())) return null;
  return { start: startIso, end: endIso, includeTime, timezone: null };
}
