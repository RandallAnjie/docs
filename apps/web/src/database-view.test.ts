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
    expect(optionSwatch('进行中').background).toMatch(/^(#|rgb)/);
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

describe('database filters with context', () => {
  const row = (values: Record<string, unknown>) =>
    ({ id: 'r', pageId: 'p', databaseId: 'd', values }) as never;
  const now = new Date(2026, 10, 25, 15, 0).getTime(); // Wednesday 2026-11-25 local

  it('matches "me" in person fields', async () => {
    const { applyDatabaseView } = await import('./database-view');
    const rows = [row({ owner: ['u1'] }), row({ owner: ['u2'] })];
    const filtered = applyDatabaseView(
      rows,
      [{ id: 'owner', type: 'person' } as never],
      { filters: [{ propertyId: 'owner', operator: 'contains', value: { $me: true } }] },
      { userId: 'u1' },
    );
    expect(filtered).toHaveLength(1);
  });

  it('resolves relative date ranges with Monday-start weeks', async () => {
    const { relativeDateRange } = await import('./database-view');
    expect(relativeDateRange('today', now)).toEqual(['2026-11-25', '2026-11-25']);
    expect(relativeDateRange('this_week', now)).toEqual(['2026-11-23', '2026-11-29']);
    expect(relativeDateRange('next_7_days', now)).toEqual(['2026-11-25', '2026-12-01']);
    expect(relativeDateRange('this_month', now)).toEqual(['2026-11-01', '2026-11-30']);
  });

  it('filters overdue and this-week dates', async () => {
    const { applyDatabaseView } = await import('./database-view');
    const date = (day: string) => ({ start: `${day}T00:00:00.000Z`, includeTime: false });
    const rows = [
      row({ due: date('2026-11-20') }),
      row({ due: date('2026-11-27') }),
      row({ due: date('2026-12-10') }),
      row({}),
    ];
    const properties = [{ id: 'due', type: 'date' } as never];
    const overdue = applyDatabaseView(
      rows,
      properties,
      { filters: [{ propertyId: 'due', operator: 'less_than', value: { $relative: 'today' } }] },
      { now },
    );
    expect(overdue).toHaveLength(1);
    const thisWeek = applyDatabaseView(
      rows,
      properties,
      { filters: [{ propertyId: 'due', operator: 'equals', value: { $relative: 'this_week' } }] },
      { now },
    );
    expect(thisWeek).toHaveLength(1);
  });

  it('matches multi-select values by option', async () => {
    const { applyDatabaseView } = await import('./database-view');
    const rows = [row({ tags: ['前端', '设计'] }), row({ tags: ['后端'] })];
    const filtered = applyDatabaseView(rows, [{ id: 'tags', type: 'multi_select' } as never], {
      filters: [{ propertyId: 'tags', operator: 'contains', value: '设计' }],
    });
    expect(filtered).toHaveLength(1);
  });
});

describe('database clipboard', () => {
  it('parses tab-separated grids with quoted multi-line cells', async () => {
    const { parseClipboardGrid } = await import('./database-view');
    expect(parseClipboardGrid('a\tb\r\nc\t"d\nline"\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd\nline'],
    ]);
    expect(parseClipboardGrid('single')).toEqual([['single']]);
  });

  it('parses pasted text by field type', async () => {
    const { parseCellText } = await import('./database-view');
    const status = { type: 'status', config: { options: ['未开始', '进行中'] } } as never;
    expect(parseCellText(status, ' 进行中 ')).toBe('进行中');
    expect(parseCellText({ type: 'number', config: {} } as never, '¥1,234.5')).toBe(1234.5);
    expect(parseCellText({ type: 'number', config: {} } as never, '12%')).toBe(0.12);
    expect(parseCellText({ type: 'number', config: {} } as never, 'abc')).toBeUndefined();
    expect(parseCellText({ type: 'checkbox', config: {} } as never, '是')).toBe(true);
    expect(
      parseCellText({ type: 'multi_select', config: { options: ['前端'] } } as never, '前端，设计'),
    ).toEqual(['前端', '设计']);
    expect(parseCellText({ type: 'date', config: {} } as never, '2026年11月20日')).toEqual({
      start: '2026-11-20T00:00:00.000Z',
      end: null,
      includeTime: false,
    });
    expect(
      parseCellText({ type: 'date', config: {} } as never, '2026/11/20 → 2026/11/22'),
    ).toMatchObject({
      end: '2026-11-22T00:00:00.000Z',
    });
    expect(parseCellText({ type: 'person', config: {} } as never, 'Ada')).toBeUndefined();
  });

  it('copies dates in a form that pastes back', async () => {
    const { cellCopyText, parseCellText } = await import('./database-view');
    const value = { start: '2026-11-20T00:00:00.000Z', end: null, includeTime: false };
    const text = cellCopyText(value);
    expect(text).toBe('2026-11-20');
    expect(parseCellText({ type: 'date', config: {} } as never, text)).toEqual(value);
  });
});
