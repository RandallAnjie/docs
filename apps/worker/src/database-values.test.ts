import { describe, expect, it } from 'vitest';

import { normalizeDatabaseCellValue } from './database-values';

describe('normalizeDatabaseCellValue', () => {
  it('normalizes dates and unique multi-select values', () => {
    expect(normalizeDatabaseCellValue('date', '2026-08-15')).toEqual({
      ok: true,
      value: { start: '2026-08-15T00:00:00.000Z' },
      error: null,
    });
    expect(normalizeDatabaseCellValue('multi_select', ['A', 'A', 'B']).value).toEqual(['A', 'B']);
  });

  it('rejects unsafe URLs and direct formula writes', () => {
    expect(normalizeDatabaseCellValue('url', 'javascript:alert(1)').ok).toBe(false);
    expect(normalizeDatabaseCellValue('formula', 42).ok).toBe(false);
  });

  it('validates location bounds', () => {
    expect(
      normalizeDatabaseCellValue('place', {
        name: 'Shanghai',
        latitude: 31.2304,
        longitude: 121.4737,
      }).ok,
    ).toBe(true);
    expect(
      normalizeDatabaseCellValue('place', { name: 'Invalid', latitude: 100, longitude: 0 }).ok,
    ).toBe(false);
  });
});
