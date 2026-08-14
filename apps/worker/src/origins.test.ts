import { describe, expect, it } from 'vitest';

import { isCollaborationOriginAllowed } from './origins';

const requestUrl =
  'https://rdocs-randall.edge.bigrandall.io/collab/6863a1ea-2cc1-4a74-9019-8449a04d2246';

describe('collaboration origins', () => {
  it('allows the domain serving the current request', () => {
    expect(
      isCollaborationOriginAllowed(
        requestUrl,
        'https://rdocs-randall.edge.bigrandall.io',
        'https://docs.bigrandall.io',
      ),
    ).toBe(true);
  });

  it('allows explicitly configured production domains', () => {
    expect(
      isCollaborationOriginAllowed(
        requestUrl,
        'https://docs.bigrandall.io',
        'https://docs.bigrandall.io',
      ),
    ).toBe(true);
  });

  it('allows multiple configured domains when the platform rewrites the request URL', () => {
    expect(
      isCollaborationOriginAllowed(
        'https://rdocs.internal/collab/6863a1ea-2cc1-4a74-9019-8449a04d2246',
        'https://rdocs-randall.edge.bigrandall.io',
        'https://docs.bigrandall.io,https://rdocs-randall.edge.bigrandall.io',
      ),
    ).toBe(true);
  });

  it('rejects missing and unrelated origins', () => {
    expect(isCollaborationOriginAllowed(requestUrl, null, 'https://docs.bigrandall.io')).toBe(
      false,
    );
    expect(
      isCollaborationOriginAllowed(
        requestUrl,
        'https://attacker.example',
        'https://docs.bigrandall.io',
      ),
    ).toBe(false);
  });
});
