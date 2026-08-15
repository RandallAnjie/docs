import { describe, expect, it } from 'vitest';

import { isPageId, MAX_ATTACHMENT_BYTES } from './index';

describe('isPageId', () => {
  it('accepts UUID v4 page ids', () => {
    expect(isPageId('6863a1ea-2cc1-4a74-9019-8449a04d2246')).toBe(true);
  });

  it('rejects path traversal and arbitrary strings', () => {
    expect(isPageId('../etc/passwd')).toBe(false);
    expect(isPageId('not-a-page')).toBe(false);
  });
});

describe('attachment limits', () => {
  it('allows 1 GB uploads', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(1024 * 1024 * 1024);
  });
});
