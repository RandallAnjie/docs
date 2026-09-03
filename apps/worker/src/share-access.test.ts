import { describe, expect, it } from 'vitest';

import { isShareLinkRole, publicShareDisplayName, publicShareTicketRole } from './share-access';

describe('public share access', () => {
  it('issues an editor ticket only for unlocked editor links', () => {
    expect(publicShareTicketRole('editor', false)).toBe('editor');
    expect(publicShareTicketRole('editor', true)).toBe('viewer');
    expect(publicShareTicketRole('viewer', false)).toBe('viewer');
    expect(publicShareTicketRole('commenter', false)).toBe('viewer');
  });

  it('labels anonymous collaborators without pretending they are members', () => {
    expect(publicShareDisplayName('editor')).toBe('外部访客');
    expect(publicShareDisplayName('viewer')).toBe('外部只读');
    expect(isShareLinkRole('editor')).toBe(true);
    expect(isShareLinkRole('admin')).toBe(false);
  });
});
