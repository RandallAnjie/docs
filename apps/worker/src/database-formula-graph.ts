import type { DatabasePropertySummary, JsonValue } from '@rdocs/shared';

import { evaluateDatabaseFormula } from './database-formulas';

const PROPERTY_REFERENCE = /prop\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*\)/giu;

function formulaReferences(expression: string): string[] {
  return [...expression.matchAll(PROPERTY_REFERENCE)].map((match) =>
    (match[1] ?? match[2] ?? '').replace(/\\([\\"'])/g, '$1'),
  );
}

export function evaluateDatabaseFormulaProperties(
  properties: readonly DatabasePropertySummary[],
  values: Readonly<Record<string, JsonValue>>,
  now = new Date(),
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  const valuesByName: Record<string, JsonValue> = Object.fromEntries(
    properties.map((property) => [property.name, values[property.id] ?? null]),
  );
  const formulasByName = new Map(
    properties
      .filter((property) => property.type === 'formula')
      .map((property) => [property.name, property]),
  );
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (property: DatabasePropertySummary): JsonValue => {
    if (state.get(property.id) === 'done') return result[property.id] ?? null;
    if (state.get(property.id) === 'visiting') {
      const cycle = { error: '公式存在循环依赖' };
      result[property.id] = cycle;
      valuesByName[property.name] = cycle;
      return cycle;
    }
    state.set(property.id, 'visiting');
    const expression = property.config.expression;
    if (typeof expression !== 'string') {
      const missing = { error: '公式尚未配置' };
      result[property.id] = missing;
      valuesByName[property.name] = missing;
      state.set(property.id, 'done');
      return missing;
    }
    for (const name of formulaReferences(expression)) {
      const dependency = formulasByName.get(name);
      if (!dependency) continue;
      const dependencyValue = visit(dependency);
      if (
        dependencyValue &&
        !Array.isArray(dependencyValue) &&
        typeof dependencyValue === 'object' &&
        typeof dependencyValue.error === 'string'
      ) {
        const failed = { error: `公式依赖“${name}”计算失败` };
        result[property.id] = failed;
        valuesByName[property.name] = failed;
        state.set(property.id, 'done');
        return failed;
      }
    }
    const evaluated = evaluateDatabaseFormula(expression, valuesByName, now);
    const value: JsonValue = evaluated.error ? { error: evaluated.error } : evaluated.value;
    result[property.id] = value;
    valuesByName[property.name] = value;
    state.set(property.id, 'done');
    return value;
  };

  for (const property of formulasByName.values()) visit(property);
  return result;
}
