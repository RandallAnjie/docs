import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  collaborationRoleCanEdit,
  documentContainsSyncedBlock,
  documentPageLinkIds,
  documentSyncedBlockIds,
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
