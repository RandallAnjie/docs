import { describe, expect, it } from 'vitest';

import type { DatabasePropertySummary, DatabaseRowSummary } from '@rdocs/shared';

import {
  applyDatabaseView,
  databaseCalendarDays,
  databaseDateRange,
  databaseAggregationValue,
  groupDatabaseRows,
  moveDatabaseDate,
  resizeDatabaseDate,
  optionSwatch,
  orderedVisibleDatabaseProperties,
} from './database-view';

const properties = [
  { id: 'title', name: '任务', type: 'title' },
  { id: 'hours', name: '工时', type: 'number' },
  { id: 'status', name: '状态', type: 'status' },
] as DatabasePropertySummary[];

function row(id: string, values: DatabaseRowSummary['values']): DatabaseRowSummary {
  return {
    id,
    databaseId: 'database',
    pageId: `page-${id}`,
    sortKey: id,
    sequenceNumber: id.charCodeAt(0),
    values,
    createdBy: 'user',
    updatedBy: 'user',
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

const rows = [
  row('a', { title: 'API', hours: 3, status: '进行中' }),
  row('b', { title: 'UI', hours: 8, status: '完成' }),
  row('c', { title: 'Docs', hours: 2, status: '进行中' }),
];

describe('applyDatabaseView', () => {
  it('combines persisted filters and stable sorting', () => {
    const result = applyDatabaseView(rows, properties, {
      filters: [{ propertyId: 'status', operator: 'equals', value: '进行中' }],
      sorts: [{ propertyId: 'hours', direction: 'descending' }],
    });
    expect(result.map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('supports OR filters and ignores stale property references', () => {
    const result = applyDatabaseView(rows, properties, {
      filterMode: 'or',
      filters: [
        { propertyId: 'title', operator: 'contains', value: 'UI' },
        { propertyId: 'hours', operator: 'less_than', value: 3 },
        { propertyId: 'deleted', operator: 'equals', value: true },
      ],
    });
    expect(result.map((row) => row.id)).toEqual(['b', 'c']);
  });

  it('persists property visibility and order while keeping the title', () => {
    const result = orderedVisibleDatabaseProperties(properties, {
      visiblePropertyIds: ['hours'],
      propertyOrder: ['hours', 'title'],
    });
    expect(result.map((property) => property.id)).toEqual(['hours', 'title']);
  });

  it('assigns a stable color swatch to the same option name', () => {
    expect(optionSwatch('进行中')).toEqual(optionSwatch('进行中'));
    expect(optionSwatch('进行中').background).toMatch(/^#/);
    expect(optionSwatch('阻塞').background).not.toBe(optionSwatch('完成').background);
  });

  it('groups rows and calculates view aggregates', () => {
    expect(
      groupDatabaseRows(rows, 'status').map((group) => [group.label, group.rows.length]),
    ).toEqual([
      ['进行中', 2],
      ['完成', 1],
    ]);
    expect(databaseAggregationValue(rows, 'hours', 'sum')).toBe('13');
    expect(databaseAggregationValue(rows, 'hours', 'average')).toBe(String(13 / 3));
    expect(databaseAggregationValue(rows, 'status', 'count_unique')).toBe('2');
  });

  it('builds Monday-first calendar grids and moves date ranges without losing duration', () => {
    const august = databaseCalendarDays('2026-08');
    expect(august).toHaveLength(42);
    expect(august[0]).toEqual({ date: '2026-07-27', inMonth: false });
    expect(august[41]).toEqual({ date: '2026-09-06', inMonth: false });
    expect(
      moveDatabaseDate(
        {
          start: '2026-08-15T09:30:00.000Z',
          end: '2026-08-17T09:30:00.000Z',
          timezone: 'Asia/Shanghai',
        },
        '2026-08-20',
      ),
    ).toEqual({
      start: '2026-08-20T09:30:00.000Z',
      end: '2026-08-22T09:30:00.000Z',
      timezone: 'Asia/Shanghai',
    });
    expect(databaseDateRange('2026-08-15')).toEqual({
      start: '2026-08-15',
      end: '2026-08-15',
    });
    expect(
      resizeDatabaseDate(
        {
          start: '2026-08-15T09:30:00.000Z',
          end: '2026-08-17T18:00:00.000Z',
          timezone: 'Asia/Shanghai',
        },
        'end',
        '2026-08-20',
      ),
    ).toEqual({
      start: '2026-08-15T09:30:00.000Z',
      end: '2026-08-20T18:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });
  });
});

describe('database value display helpers', () => {
  it('colors common status and priority words semantically', async () => {
    const { optionSwatch } = await import('./database-view');
    expect(optionSwatch('已完成')).toEqual(optionSwatch('完成'));
    expect(optionSwatch('进行中').color).not.toBe(optionSwatch('已完成').color);
    expect(optionSwatch('受阻')).toEqual(optionSwatch('紧急'));
    expect(optionSwatch('未开始')).toEqual(optionSwatch('低'));
  });

  it('gives other options distinct colors by their position', async () => {
    const { optionSwatch } = await import('./database-view');
    const options = ['前端', '后端', '设计'];
    const colors = options.map((option) => optionSwatch(option, options).background);
    expect(new Set(colors).size).toBe(3);
  });

  it('formats dates, ranges and numbers for reading', async () => {
    const { formatDatabaseDate, formatDatabaseNumber, compactUrl } =
      await import('./database-view');
    expect(formatDatabaseDate({ start: '2026-11-20' })).toBe('2026年11月20日');
    expect(formatDatabaseDate({ start: '2026-11-20', end: '2026-11-22' })).toBe(
      '2026年11月20日 → 2026年11月22日',
    );
    expect(formatDatabaseDate(undefined)).toBe('');
    expect(formatDatabaseNumber(1234.5)).toBe('1,234.5');
    expect(formatDatabaseNumber(null)).toBe('');
    expect(compactUrl('https://docs.bigrandall.io/')).toBe('docs.bigrandall.io');
  });

  it('shows nothing for an unset aggregation', async () => {
    const { databaseAggregationValue } = await import('./database-view');
    expect(databaseAggregationValue([], 'p', 'none')).toBe('');
  });
});

describe('date-only display', () => {
  it('shows the stored calendar day regardless of the viewer time zone', async () => {
    const { formatDatabaseDate } = await import('./database-view');
    expect(
      formatDatabaseDate({ start: '2026-11-24T00:00:00.000Z', end: null, includeTime: false }),
    ).toBe('2026年11月24日');
  });
});
