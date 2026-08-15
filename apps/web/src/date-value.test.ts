import { describe, expect, it } from 'vitest';

import { fromDateParts, parseDateCell } from './date-value';

describe('database date values', () => {
  it('round-trips a date range with time', () => {
    const cell = fromDateParts('2026-08-15T09:00', '2026-08-16T18:00', true);
    expect(cell?.includeTime).toBe(true);
    expect(parseDateCell(cell)?.end).toContain('2026-08-16');
  });
});
