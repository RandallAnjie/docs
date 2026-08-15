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

  it('understands date ranges and Notion-style date formatting helpers', () => {
    expect(
      evaluateDatabaseFormula(
        'formatDate(dateEnd(prop("周期")), "YYYY-MM-DD HH:mm") + " / W" + format(week(dateStart(prop("周期"))))',
        {
          周期: {
            start: '2026-08-15T09:30:00.000Z',
            end: '2026-08-17T18:45:00.000Z',
          },
        },
      ),
    ).toEqual({ value: '2026-08-17 18:45 / W33', error: null });
  });

  it('supports safe list, text, and extended numeric helpers', () => {
    expect(
      evaluateDatabaseFormula(
        'prop("值").sort().reverse().slice(0, 2).join(",") + ":" + replaceAll("a-b-a", "a", "x")',
        { 值: [3, 1, 2] },
      ),
    ).toEqual({ value: '3,2:x-b-x', error: null });
    expect(evaluateDatabaseFormula('sign(-4) + cbrt(27)', {})).toEqual({
      value: 2,
      error: null,
    });
  });

  it('fails closed for unsupported syntax', () => {
    const result = evaluateDatabaseFormula('globalThis.fetch("https://example.com")', {});
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/未知标识符|不支持/);
  });
});
