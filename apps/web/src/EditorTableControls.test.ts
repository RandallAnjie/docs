import { getSchema } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { lastTableCellPos, tableFromWrapper, tableWrapperElement } from './EditorTableControls';

const schema = getSchema([StarterKit, TableKit]);

function tableDocument() {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
              },
              {
                type: 'tableHeader',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }],
              },
            ],
          },
        ],
      },
    ],
  });
}

describe('tableWrapperElement', () => {
  it('returns null when the selection is not inside a table', () => {
    const editor = {
      state: {
        selection: {
          $from: {
            depth: 1,
            node: () => ({ type: { name: 'paragraph' } }),
            before: () => 0,
          },
        },
      },
      view: { nodeDOM: () => null },
    };
    expect(tableWrapperElement(editor as never)).toBeNull();
  });
});

describe('tableFromWrapper', () => {
  it('returns null when the wrapper is not a table', () => {
    const editor = {
      view: { posAtDOM: () => 0 },
      state: {
        doc: {
          resolve: () => ({
            depth: 1,
            node: () => ({ type: { name: 'paragraph' } }),
            before: () => 0,
          }),
        },
      },
    };
    expect(tableFromWrapper(editor as never, { querySelector: () => null } as never)).toBeNull();
  });
});

describe('lastTableCellPos', () => {
  it('returns a cursor inside the last table cell', () => {
    const doc = tableDocument();
    const table = doc.child(1);
    const tablePos = 1 + doc.child(0).nodeSize;
    const pos = lastTableCellPos(tablePos, table);
    expect(pos).not.toBeNull();
    const $pos = doc.resolve(pos!);
    expect($pos.parent.type.name).toBe('paragraph');
    expect($pos.node($pos.depth - 1).type.name).toBe('tableCell');
    expect($pos.node($pos.depth - 1).textContent).toBe('2');
  });
});
