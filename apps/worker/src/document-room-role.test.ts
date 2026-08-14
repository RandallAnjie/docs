import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { collaborationRoleCanEdit, yjsUpdateChangesDocument } from './document-room';

describe('collaboration role enforcement', () => {
  it('only permits space administrators and editors to write the Yjs document', () => {
    expect(collaborationRoleCanEdit('space_admin')).toBe(true);
    expect(collaborationRoleCanEdit('editor')).toBe(true);
    expect(collaborationRoleCanEdit('commenter')).toBe(false);
    expect(collaborationRoleCanEdit('viewer')).toBe(false);
    expect(collaborationRoleCanEdit(null)).toBe(false);
    expect(collaborationRoleCanEdit('forged-role')).toBe(false);
  });
});

describe('collaboration update deduplication', () => {
  it('accepts new inserts and deletes but ignores replayed updates', () => {
    const server = new Y.Doc();
    server.getText('default').insert(0, 'Rdocs');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    let insert: Uint8Array<ArrayBufferLike> = new Uint8Array();
    client.once('update', (update) => {
      insert = update;
    });
    client.getText('default').insert(5, ' sync');
    expect(yjsUpdateChangesDocument(server, insert)).toBe(true);
    Y.applyUpdate(server, insert);
    expect(yjsUpdateChangesDocument(server, insert)).toBe(false);

    let deletion: Uint8Array<ArrayBufferLike> = new Uint8Array();
    client.once('update', (update) => {
      deletion = update;
    });
    client.getText('default').delete(0, 1);
    expect(yjsUpdateChangesDocument(server, deletion)).toBe(true);
    Y.applyUpdate(server, deletion);
    expect(yjsUpdateChangesDocument(server, deletion)).toBe(false);

    client.destroy();
    server.destroy();
  });
});
