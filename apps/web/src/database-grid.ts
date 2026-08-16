import type { DatabasePropertySummary, DatabaseRowSummary } from '@rdocs/shared';

export const DATABASE_ROW_HEIGHT = 36;
export const DATABASE_VIEW_STORAGE_PREFIX = 'rdocs:database-view:';

export interface DatabaseGridCell {
  rowId: string;
  propertyId: string;
}

export function databaseViewStorageKey(databaseId: string): string {
  return `${DATABASE_VIEW_STORAGE_PREFIX}${databaseId}`;
}

export function readStoredDatabaseViewId(
  databaseId: string,
  viewIds: readonly string[],
  storage?: Pick<Storage, 'getItem'> | null,
): string {
  try {
    const stored = storage?.getItem(databaseViewStorageKey(databaseId));
    if (stored && viewIds.includes(stored)) return stored;
  } catch {
    // Private mode.
  }
  return viewIds[0] ?? '';
}

export function writeStoredDatabaseViewId(
  databaseId: string,
  viewId: string,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  try {
    storage?.setItem(databaseViewStorageKey(databaseId), viewId);
  } catch {
    // Private mode.
  }
}

export function visibleRowWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = DATABASE_ROW_HEIGHT,
): { start: number; end: number; padTop: number; padBottom: number } {
  if (rowCount <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const overscan = 8;
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const visible = Math.ceil(Math.max(rowHeight, viewportHeight) / rowHeight) + overscan * 2;
  const end = Math.min(rowCount, start + visible);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, rowCount - end) * rowHeight,
  };
}

export function shouldVirtualizeDatabaseRows(rowCount: number, grouped: boolean): boolean {
  return !grouped && rowCount > 40;
}

export function moveDatabaseGridCell(
  rows: readonly Pick<DatabaseRowSummary, 'id'>[],
  properties: readonly Pick<DatabasePropertySummary, 'id'>[],
  current: DatabaseGridCell,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab' | 'Home' | 'End',
  shift = false,
): DatabaseGridCell {
  if (!rows.length || !properties.length) return current;
  const rowIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === current.rowId),
  );
  const propertyIndex = Math.max(
    0,
    properties.findIndex((property) => property.id === current.propertyId),
  );
  let nextRow = rowIndex;
  let nextProperty = propertyIndex;
  if (key === 'ArrowUp') nextRow = Math.max(0, rowIndex - 1);
  if (key === 'ArrowDown') nextRow = Math.min(rows.length - 1, rowIndex + 1);
  if (key === 'ArrowLeft' || (key === 'Tab' && shift)) {
    if (propertyIndex > 0) nextProperty = propertyIndex - 1;
    else if (rowIndex > 0) {
      nextRow = rowIndex - 1;
      nextProperty = properties.length - 1;
    }
  }
  if (key === 'ArrowRight' || (key === 'Tab' && !shift)) {
    if (propertyIndex < properties.length - 1) nextProperty = propertyIndex + 1;
    else if (rowIndex < rows.length - 1) {
      nextRow = rowIndex + 1;
      nextProperty = 0;
    }
  }
  if (key === 'Home') nextProperty = 0;
  if (key === 'End') nextProperty = properties.length - 1;
  return {
    rowId: rows[nextRow]?.id ?? current.rowId,
    propertyId: properties[nextProperty]?.id ?? current.propertyId,
  };
}
