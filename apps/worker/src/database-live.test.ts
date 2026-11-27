import { describe, expect, it } from 'vitest';

import { databaseIdFromMutationPath } from './database-live';

describe('databaseIdFromMutationPath', () => {
  const id = '6863a1ea-2cc1-4a74-9019-8449a04d2246';

  it('finds the database behind every write', () => {
    expect(databaseIdFromMutationPath(`/api/databases/${id}`, 'PATCH')).toBe(id);
    expect(databaseIdFromMutationPath(`/api/databases/${id}/rows`, 'POST')).toBe(id);
    expect(databaseIdFromMutationPath(`/api/databases/${id}/rows/x`, 'DELETE')).toBe(id);
    expect(databaseIdFromMutationPath(`/api/databases/${id}/views/v`, 'PATCH')).toBe(id);
  });

  it('ignores reads and the ticket request itself', () => {
    expect(databaseIdFromMutationPath(`/api/databases/${id}`, 'GET')).toBeNull();
    expect(databaseIdFromMutationPath(`/api/databases/${id}/live-ticket`, 'POST')).toBeNull();
    expect(databaseIdFromMutationPath(`/api/pages/${id}`, 'PATCH')).toBeNull();
  });
});
