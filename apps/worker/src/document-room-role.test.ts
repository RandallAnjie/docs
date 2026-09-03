import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  collaborationRoleCanEdit,
  decodeStoredBytes,
  documentDeletedSyncedBlockCount,
  documentContainsSyncedBlock,
  documentPageLinkIds,
  documentSyncedBlockIds,
  documentSyncedBlockResourceIds,
  encodeStoredBytes,
  restoredTailNeedsCompact,
  syncedBlockDeleteUpdate,
  syncedBlockRestoreUpdate,
  syncedBlockUnsyncUpdate,
  yjsUpdateChangesDocument,
} from './document-room';

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

  it('does not clone a large document to accept a new insert', () => {
    const server = new Y.Doc();
    server.getText('default').insert(0, 'a'.repeat(200 * 1024));
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    let insert: Uint8Array = new Uint8Array();
    client.once('update', (update) => {
      insert = update;
    });
    client.getText('default').insert(200 * 1024, 'tail');
    expect(yjsUpdateChangesDocument(server, insert)).toBe(true);
    Y.applyUpdate(server, insert);
    expect(yjsUpdateChangesDocument(server, insert)).toBe(false);
    client.destroy();
    server.destroy();
  });
});

describe('synced block reference projection', () => {
  it('collects unique valid references through nested page blocks', () => {
    const document = new Y.Doc();
    const fragment = document.getXmlFragment('default');
    const first = new Y.XmlElement('syncedBlock');
    first.setAttribute('syncedBlockId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const column = new Y.XmlElement('column');
    const nested = new Y.XmlElement('syncedBlock');
    nested.setAttribute('syncedBlockId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const duplicate = new Y.XmlElement('syncedBlock');
    duplicate.setAttribute('syncedBlockId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const invalid = new Y.XmlElement('syncedBlock');
    invalid.setAttribute('syncedBlockId', 'another-tenant');
    column.insert(0, [nested, duplicate, invalid]);
    fragment.insert(0, [first, column]);

    expect(documentSyncedBlockIds(document)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    expect(documentContainsSyncedBlock(document)).toBe(true);
    document.destroy();
  });

  it('rejects nested synced nodes even when their identifier is malformed', () => {
    const document = new Y.Doc();
    const invalid = new Y.XmlElement('syncedBlock');
    invalid.setAttribute('syncedBlockId', 'not-a-resource-id');
    document.getXmlFragment('default').insert(0, [invalid]);

    expect(documentSyncedBlockIds(document)).toEqual([]);
    expect(documentContainsSyncedBlock(document)).toBe(true);
    document.destroy();
  });

  it('rejects a recoverable deletion placeholder inside a new synced resource', () => {
    const document = new Y.Doc();
    const placeholder = new Y.XmlElement('deletedSyncedBlock');
    placeholder.setAttribute('syncedBlockId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    placeholder.setAttribute('deletionOperationId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    document.getXmlFragment('default').insert(0, [placeholder]);

    expect(documentContainsSyncedBlock(document)).toBe(true);
    document.destroy();
  });

  it('replaces every matching reference with independent source content', () => {
    const blockId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const source = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('shared content')]);
    source.getXmlFragment('default').insert(0, [paragraph]);

    const target = new Y.Doc();
    const first = new Y.XmlElement('syncedBlock');
    first.setAttribute('syncedBlockId', blockId);
    const column = new Y.XmlElement('column');
    const second = new Y.XmlElement('syncedBlock');
    second.setAttribute('syncedBlockId', blockId);
    column.insert(0, [second]);
    target.getXmlFragment('default').insert(0, [first, column]);

    const result = syncedBlockUnsyncUpdate(target, blockId, Y.encodeStateAsUpdate(source));
    expect(result.replacements).toBe(2);
    Y.applyUpdate(target, result.update);
    expect(documentSyncedBlockIds(target)).toEqual([]);
    expect(
      target
        .getXmlFragment('default')
        .toString()
        .match(/shared content/g),
    ).toHaveLength(2);

    source.destroy();
    target.destroy();
  });

  it('removes every matching reference when the original block is deleted', () => {
    const blockId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const target = new Y.Doc();
    const first = new Y.XmlElement('syncedBlock');
    first.setAttribute('syncedBlockId', blockId);
    const second = new Y.XmlElement('syncedBlock');
    second.setAttribute('syncedBlockId', blockId);
    target.getXmlFragment('default').insert(0, [first, second]);
    const empty = new Y.Doc();

    const result = syncedBlockUnsyncUpdate(target, blockId, Y.encodeStateAsUpdate(empty));
    expect(result.replacements).toBe(2);
    Y.applyUpdate(target, result.update);
    expect(documentSyncedBlockIds(target)).toEqual([]);
    expect(target.getXmlFragment('default').length).toBe(0);

    empty.destroy();
    target.destroy();
  });

  it('restores cascade-deleted references without overwriting later page edits', () => {
    const blockId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const target = new Y.Doc();
    const first = new Y.XmlElement('syncedBlock');
    first.setAttribute('syncedBlockId', blockId);
    const column = new Y.XmlElement('column');
    const second = new Y.XmlElement('syncedBlock');
    second.setAttribute('syncedBlockId', blockId);
    column.insert(0, [second]);
    target.getXmlFragment('default').insert(0, [first, column]);

    const deleted = syncedBlockDeleteUpdate(target, blockId, operationId);
    expect(deleted.replacements).toBe(2);
    expect(deleted.remaining).toBe(0);
    Y.applyUpdate(target, deleted.update);
    expect(documentSyncedBlockIds(target)).toEqual([]);
    expect(documentSyncedBlockResourceIds(target)).toEqual([blockId]);
    expect(documentDeletedSyncedBlockCount(target, blockId, operationId)).toBe(2);

    const laterParagraph = new Y.XmlElement('paragraph');
    laterParagraph.insert(0, [new Y.XmlText('written after deletion')]);
    target.getXmlFragment('default').insert(1, [laterParagraph]);
    const restored = syncedBlockRestoreUpdate(target, blockId, operationId);
    expect(restored.replacements).toBe(2);
    expect(restored.remaining).toBe(0);
    Y.applyUpdate(target, restored.update);
    expect(documentSyncedBlockIds(target)).toEqual([blockId]);
    expect(documentDeletedSyncedBlockCount(target, blockId, operationId)).toBe(0);
    expect(target.getXmlFragment('default').toString()).toContain('written after deletion');
    target.destroy();
  });

  it('does not restore a placeholder created by another deletion operation', () => {
    const blockId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const originalOperation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const target = new Y.Doc();
    const block = new Y.XmlElement('syncedBlock');
    block.setAttribute('syncedBlockId', blockId);
    target.getXmlFragment('default').insert(0, [block]);
    Y.applyUpdate(target, syncedBlockDeleteUpdate(target, blockId, originalOperation).update);

    const restored = syncedBlockRestoreUpdate(
      target,
      blockId,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(restored.replacements).toBe(0);
    expect(documentDeletedSyncedBlockCount(target, blockId, originalOperation)).toBe(1);
    target.destroy();
  });
});

describe('page link projection', () => {
  it('collects unique valid page targets through nested blocks', () => {
    const document = new Y.Doc();
    const first = new Y.XmlElement('pageLink');
    first.setAttribute('pageId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const column = new Y.XmlElement('column');
    const nested = new Y.XmlElement('pageLink');
    nested.setAttribute('pageId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const duplicate = new Y.XmlElement('pageLink');
    duplicate.setAttribute('pageId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const invalid = new Y.XmlElement('pageLink');
    invalid.setAttribute('pageId', 'private-page');
    column.insert(0, [nested, duplicate, invalid]);
    document.getXmlFragment('default').insert(0, [first, column]);

    expect(documentPageLinkIds(document)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    document.destroy();
  });
});

describe('restored collaboration tail', () => {
  it('compacts any updates applied after the latest snapshot', () => {
    expect(restoredTailNeedsCompact(0)).toBe(false);
    expect(restoredTailNeedsCompact(1)).toBe(true);
    expect(restoredTailNeedsCompact(100)).toBe(true);
  });
});

describe('durable object blob encoding', () => {
  it('round-trips binary updates as JSON-safe base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13, 0]);
    const encoded = encodeStoredBytes(bytes);
    expect(JSON.parse(JSON.stringify({ blob: encoded })).blob).toBe(encoded);
    expect([...decodeStoredBytes(encoded)]).toEqual([...bytes]);
    expect(JSON.stringify({ blob: bytes.buffer })).toBe('{"blob":{}}');
  });

  it('rejects non-base64 SQL text as invalid_stored_blob', () => {
    expect(() => decodeStoredBytes('{}')).toThrow('invalid_stored_blob');
    expect(() => decodeStoredBytes(null)).toThrow('invalid_stored_blob');
  });
});
