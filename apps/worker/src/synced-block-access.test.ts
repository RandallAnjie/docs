import { describe, expect, it } from 'vitest';

import { syncedBlockTicketRole } from './synced-block-access';

const editor = { collaborationEnabled: true, isLocked: false, role: 'editor' as const };

describe('cross-page synced block access', () => {
  it('requires both source and destination pages to be editable', () => {
    expect(syncedBlockTicketRole(editor, editor)).toBe('editor');
    expect(syncedBlockTicketRole(editor, { ...editor, role: 'viewer' })).toBe('viewer');
    expect(syncedBlockTicketRole({ ...editor, isLocked: true }, editor)).toBe('viewer');
    expect(syncedBlockTicketRole(editor, { ...editor, isLocked: true })).toBe('viewer');
  });

  it('rejects a ticket when collaboration is disabled on either page', () => {
    expect(syncedBlockTicketRole({ ...editor, collaborationEnabled: false }, editor)).toBeNull();
    expect(syncedBlockTicketRole(editor, { ...editor, collaborationEnabled: false })).toBeNull();
  });
});
