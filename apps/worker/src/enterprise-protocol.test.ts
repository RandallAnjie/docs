import { describe, expect, it } from 'vitest';

import {
  emailFromSamlResponse,
  samlMetadataXml,
  scimListResponse,
  scimUserResource,
} from './enterprise-protocol';

describe('enterprise protocols', () => {
  it('extracts an email from a SAML assertion payload', () => {
    const xml = '<Response><NameID>ada@example.com</NameID></Response>';
    expect(emailFromSamlResponse(btoa(xml))).toBe('ada@example.com');
  });

  it('emits ACS metadata and SCIM user resources', () => {
    expect(samlMetadataXml('https://docs.bigrandall.io')).toContain('/api/saml/acs');
    expect(
      scimUserResource({ id: 'u1', email: 'a@b.c', displayName: 'Ada', active: true }).userName,
    ).toBe('a@b.c');
    expect(scimListResponse([]).totalResults).toBe(0);
  });
});
