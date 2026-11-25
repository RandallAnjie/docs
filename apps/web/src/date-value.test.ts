import { describe, expect, it } from 'vitest';

import { fromDateParts, parseDateCell } from './date-value';

describe('database date values', () => {
  it('round-trips a date range with time', () => {
    const cell = fromDateParts('2026-08-15T09:00', '2026-08-16T18:00', true);
    expect(cell?.includeTime).toBe(true);
    expect(parseDateCell(cell)?.end).toContain('2026-08-16');
  });
});

describe('date-only values', () => {
  it('stay date-only after the server stores them as UTC midnight', () => {
    expect(parseDateCell('2026-11-24T00:00:00.000Z')?.includeTime).toBe(false);
    expect(
      parseDateCell({ start: '2026-11-24T00:00:00.000Z', end: null, includeTime: false }),
    ).toMatchObject({ includeTime: false });
    expect(parseDateCell({ start: '2026-11-24T00:00:00.000Z' })?.includeTime).toBe(false);
    expect(parseDateCell({ start: '2026-11-24T09:30:00.000Z' })?.includeTime).toBe(true);
    expect(
      parseDateCell({ start: '2026-11-24T00:00:00.000Z', includeTime: true })?.includeTime,
    ).toBe(true);
  });
});
