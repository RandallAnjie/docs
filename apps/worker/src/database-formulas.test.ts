import { describe, expect, it } from 'vitest';

import { evaluateDatabaseFormula } from './database-formulas';

describe('evaluateDatabaseFormula', () => {
  it('evaluates property expressions without executing JavaScript', () => {
    expect(
      evaluateDatabaseFormula('if(prop("完成"), prop("工时") * 2, prop("工时") + 1)', {
        完成: true,
        工时: 3,
      }),
    ).toEqual({ value: 6, error: null });
  });

  it('supports list and method-style helpers', () => {
    expect(
      evaluateDatabaseFormula('prop("标签").unique().join(" / ")', { 标签: ['A', 'A', 'B'] }),
    ).toEqual({ value: 'A / B', error: null });
  });

  it('supports deterministic date calculations', () => {
    expect(
      evaluateDatabaseFormula(
        'dateBetween(dateAdd(prop("开始"), 2, "days"), prop("开始"), "days")',
        {
          开始: '2026-08-15T00:00:00.000Z',
        },
      ),
    ).toEqual({ value: 2, error: null });
  });

  it('fails closed for unsupported syntax', () => {
    const result = evaluateDatabaseFormula('globalThis.fetch("https://example.com")', {});
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/未知标识符|不支持/);
  });
});
