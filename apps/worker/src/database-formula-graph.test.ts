import { describe, expect, it } from 'vitest';

import type { DatabasePropertySummary } from '@rdocs/shared';

import { evaluateDatabaseFormulaProperties } from './database-formula-graph';

function property(
  id: string,
  name: string,
  type: DatabasePropertySummary['type'],
  expression?: string,
): DatabasePropertySummary {
  return {
    id,
    databaseId: 'database',
    name,
    type,
    config: expression === undefined ? {} : { expression },
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('evaluateDatabaseFormulaProperties', () => {
  it('evaluates formula dependencies independent of column order', () => {
    const properties = [
      property('total', '含税', 'formula', 'prop("小计") * 1.1'),
      property('subtotal', '小计', 'formula', 'prop("单价") * prop("数量")'),
      property('price', '单价', 'number'),
      property('quantity', '数量', 'number'),
    ];
    expect(evaluateDatabaseFormulaProperties(properties, { price: 20, quantity: 3 })).toMatchObject(
      { subtotal: 60, total: 66 },
    );
  });

  it('fails closed on circular formula references', () => {
    const result = evaluateDatabaseFormulaProperties(
      [
        property('a', 'A', 'formula', 'prop("B") + 1'),
        property('b', 'B', 'formula', 'prop("A") + 1'),
      ],
      {},
    );
    expect(result.a).toMatchObject({ error: expect.stringContaining('依赖') });
    expect(result.b).toMatchObject({ error: expect.stringContaining('依赖') });
  });
});
