import { getSchema } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import { EditorState, TextSelection, AllSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { nextSelectAllScope } from './scoped-select-all';

const schema = getSchema([StarterKit, TableKit]);
const cell = (text: string, type = 'tableCell') => ({
  type,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('A1'), cell('B1')] },
        { type: 'tableRow', content: [cell('A2'), cell('B2')] },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'outro' }] },
  ],
});

function positionOf(text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) found = pos;
  });
  return found;
}

function step(state: EditorState): EditorState {
  const next = nextSelectAllScope(state);
  return next ? state.apply(state.tr.setSelection(next)) : state;
}

describe('scoped Cmd+A', () => {
  it('selects the cell, then the table, then the document', () => {
    const inCell = positionOf('B2') + 1;
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, inCell) });
    state = step(state);
    expect(state.selection).toBeInstanceOf(TextSelection);
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe('B2');
    state = step(state);
    expect(state.selection).toBeInstanceOf(CellSelection);
    expect((state.selection as CellSelection).ranges).toHaveLength(4);
    state = step(state);
    expect(state.selection).toBeInstanceOf(AllSelection);
    expect(nextSelectAllScope(state)).toBeNull();
  });

  it('works from any cell, not only the last one', () => {
    for (const text of ['A1', 'B1', 'A2']) {
      let state = EditorState.create({
        doc,
        selection: TextSelection.create(doc, positionOf(text) + 1),
      });
      state = step(state);
      expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe(text);
      state = step(state);
      expect(state.selection).toBeInstanceOf(CellSelection);
      state = step(state);
      expect(state.selection).toBeInstanceOf(AllSelection);
    }
  });

  it('selects the paragraph first, then the document', () => {
    const inIntro = positionOf('intro') + 2;
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, inIntro) });
    state = step(state);
    expect(state.doc.textBetween(state.selection.from, state.selection.to)).toBe('intro');
    state = step(state);
    expect(state.selection).toBeInstanceOf(AllSelection);
  });
});
