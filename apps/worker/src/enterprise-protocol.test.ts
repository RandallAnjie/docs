import { describe, expect, it } from 'vitest';

import { scimListResponse, scimUserResource } from './enterprise-protocol';

describe('enterprise protocols', () => {
  it('emits SCIM user resources', () => {
    expect(
      scimUserResource({ id: 'u1', email: 'a@b.c', displayName: 'Ada', active: true }).userName,
    ).toBe('a@b.c');
    expect(scimListResponse([]).totalResults).toBe(0);
  });
});
