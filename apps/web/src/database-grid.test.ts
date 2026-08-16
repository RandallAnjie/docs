import { describe, expect, it } from 'vitest';

import {
  databaseViewStorageKey,
  moveDatabaseGridCell,
  moveDatabaseGridColumn,
  readStoredDatabaseViewId,
  shouldVirtualizeDatabaseRows,
  visibleRowWindow,
  writeStoredDatabaseViewId,
} from './database-grid';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key) {
      return data.get(key) ?? null;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key) {
      data.delete(key);
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe('database grid helpers', () => {
  const rows = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  const properties = [{ id: 'p1' }, { id: 'p2' }];

  it('remembers the last view for a database', () => {
    const storage = memoryStorage();
    expect(readStoredDatabaseViewId('db1', ['a', 'b'], storage)).toBe('a');
    writeStoredDatabaseViewId('db1', 'b', storage);
    expect(storage.getItem(databaseViewStorageKey('db1'))).toBe('b');
    expect(readStoredDatabaseViewId('db1', ['a', 'b'], storage)).toBe('b');
    expect(readStoredDatabaseViewId('db1', ['a'], storage)).toBe('a');
  });

  it('windows long tables and skips small or grouped tables', () => {
    expect(shouldVirtualizeDatabaseRows(12, false)).toBe(false);
    expect(shouldVirtualizeDatabaseRows(80, true)).toBe(false);
    expect(shouldVirtualizeDatabaseRows(80, false)).toBe(true);
    expect(visibleRowWindow(80, 360, 180, 36)).toEqual({
      start: 2,
      end: 23,
      padTop: 72,
      padBottom: 2052,
    });
  });

  it('moves the focused cell like a spreadsheet', () => {
    const start = { rowId: 'r2', propertyId: 'p1' };
    expect(moveDatabaseGridCell(rows, properties, start, 'ArrowDown')).toEqual({
      rowId: 'r3',
      propertyId: 'p1',
    });
    expect(moveDatabaseGridCell(rows, properties, start, 'ArrowRight')).toEqual({
      rowId: 'r2',
      propertyId: 'p2',
    });
    expect(
      moveDatabaseGridCell(rows, properties, { rowId: 'r2', propertyId: 'p2' }, 'Tab'),
    ).toEqual({
      rowId: 'r3',
      propertyId: 'p1',
    });
    expect(
      moveDatabaseGridCell(rows, properties, { rowId: 'r2', propertyId: 'p1' }, 'Tab', true),
    ).toEqual({
      rowId: 'r1',
      propertyId: 'p2',
    });
  });

  it('moves a selected column without entering a cell', () => {
    expect(moveDatabaseGridColumn(properties, 'p2', 'ArrowLeft')).toBe('p1');
    expect(moveDatabaseGridColumn(properties, 'p1', 'ArrowLeft')).toBe('p1');
    expect(moveDatabaseGridColumn(properties, 'p1', 'ArrowRight')).toBe('p2');
    expect(moveDatabaseGridColumn(properties, 'p1', 'End')).toBe('p2');
    expect(moveDatabaseGridColumn(properties, 'p2', 'Home')).toBe('p1');
  });
});
