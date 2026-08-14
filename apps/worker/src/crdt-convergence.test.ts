import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

function applyEveryUpdate(document: Y.Doc, updates: Uint8Array[], order: number[]): void {
  for (const index of order) {
    const update = updates[index];
    if (update) Y.applyUpdate(document, update);
  }
  for (const update of updates) Y.applyUpdate(document, update);
}

describe('Yjs convergence', () => {
  it('converges concurrent text, formatting, deletion and structured-list updates', () => {
    const seed = new Y.Doc();
    seed.getText('body').insert(0, 'Rdocs 协作知识库');
    const seedUpdate = Y.encodeStateAsUpdate(seed);
    seed.destroy();

    const clients = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    clients.forEach((client) => Y.applyUpdate(client, seedUpdate));
    const updates: Uint8Array[] = [];
    clients.forEach((client) => client.on('update', (update) => updates.push(update)));

    clients[0]?.transact(() => {
      const text = clients[0]?.getText('body');
      text?.insert(5, '实时');
      text?.format(0, 5, { bold: true });
    });
    clients[1]?.transact(() => {
      const text = clients[1]?.getText('body');
      text?.delete(7, 2);
      text?.insert(text.length, '，自动保存');
    });
    clients[2]?.transact(() => {
      const list = new Y.XmlElement('taskList');
      const item = new Y.XmlElement('taskItem');
      item.setAttribute('checked', 'false');
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, '验证离线重连');
      paragraph.insert(0, [text]);
      item.insert(0, [paragraph]);
      list.insert(0, [item]);
      clients[2]?.getXmlFragment('default').insert(0, [list]);
    });

    applyEveryUpdate(clients[0]!, updates, [2, 1, 0]);
    applyEveryUpdate(clients[1]!, updates, [0, 2, 1]);
    applyEveryUpdate(clients[2]!, updates, [1, 0, 2]);

    const views = clients.map((client) => ({
      text: client.getText('body').toDelta(),
      blocks: client.getXmlFragment('default').toJSON(),
      vector: [...Y.encodeStateVector(client)],
    }));
    expect(views[1]).toEqual(views[0]);
    expect(views[2]).toEqual(views[0]);
    clients.forEach((client) => client.destroy());
  });
});
