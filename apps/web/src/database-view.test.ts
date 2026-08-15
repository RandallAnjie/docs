import { describe, expect, it } from 'vitest';

import type { DatabasePropertySummary, DatabaseRowSummary } from '@rdocs/shared';

import { applyDatabaseView } from './database-view';

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
});
