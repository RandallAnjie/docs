import { getSchema } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import {
  applyBlockGapFixes,
  clickIsAboveFirstBlock,
  isGapCursorPosition,
} from './editor-block-gaps';

const schema = getSchema([StarterKit]);

function horizontalRuleDoc() {
  return schema.node('doc', null, [schema.nodes.horizontalRule!.create()]);
}

describe('applyBlockGapFixes', () => {
  it('does not keep a standing first line above a leading block', () => {
    const state = EditorState.create({ schema, doc: horizontalRuleDoc() });
    const transaction = applyBlockGapFixes(state);
    expect(transaction).not.toBeNull();
    expect(transaction!.doc.firstChild?.type.name).toBe('horizontalRule');
    expect(transaction!.doc.lastChild?.type.name).toBe('paragraph');
    expect(transaction!.doc.lastChild?.content.size).toBe(0);
    expect(transaction!.doc.childCount).toBe(2);
  });

  it('removes an unused empty first line once the caret leaves it', () => {
    const paragraph = schema.nodes.paragraph!.create();
    const rule = schema.nodes.horizontalRule!.create();
    const doc = schema.node('doc', null, [paragraph, rule, paragraph]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    const transaction = applyBlockGapFixes(state)!;
    expect(transaction.doc.firstChild?.type.name).toBe('horizontalRule');
    expect(transaction.doc.lastChild?.type.name).toBe('paragraph');
    expect(transaction.doc.childCount).toBe(2);
  });

  it('keeps an empty first line while the caret is in it', () => {
    const paragraph = schema.nodes.paragraph!.create();
    const rule = schema.nodes.horizontalRule!.create();
    const doc = schema.node('doc', null, [paragraph, rule, paragraph]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
    });
    expect(applyBlockGapFixes(state)).toBeNull();
  });

  it('does not add extra paragraphs when the document already ends with one', () => {
    const paragraph = schema.nodes.paragraph!.create();
    const doc = schema.node('doc', null, [schema.nodes.horizontalRule!.create(), paragraph]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    expect(applyBlockGapFixes(state)).toBeNull();
  });

  it('turns a gap cursor before the first block into a paragraph', () => {
    const doc = horizontalRuleDoc();
    expect(isGapCursorPosition(doc.resolve(0))).toBe(true);
    const state = EditorState.create({
      schema,
      doc,
      selection: new GapCursor(doc.resolve(0)),
    });
    const transaction = applyBlockGapFixes(state)!;
    expect(transaction.doc.firstChild?.type.name).toBe('paragraph');
    expect(transaction.doc.lastChild?.type.name).toBe('paragraph');
    expect(transaction.doc.childCount).toBe(3);
    expect(transaction.selection).toBeInstanceOf(TextSelection);
    expect(transaction.selection.from).toBe(1);
  });

  it('turns a gap cursor after the last block into the trailing paragraph', () => {
    const doc = horizontalRuleDoc();
    const end = doc.content.size;
    expect(isGapCursorPosition(doc.resolve(end))).toBe(true);
    const state = EditorState.create({
      schema,
      doc,
      selection: new GapCursor(doc.resolve(end)),
    });
    const transaction = applyBlockGapFixes(state)!;
    expect(transaction.doc.firstChild?.type.name).toBe('horizontalRule');
    expect(transaction.doc.lastChild?.type.name).toBe('paragraph');
    expect(transaction.doc.childCount).toBe(2);
    expect(transaction.selection).toBeInstanceOf(TextSelection);
  });

  it('inserts a paragraph between two blocks instead of leaving a gap cursor', () => {
    const rule = schema.nodes.horizontalRule!.create();
    const doc = schema.node('doc', null, [rule, rule]);
    const pos = rule.nodeSize;
    expect(isGapCursorPosition(doc.resolve(pos))).toBe(true);
    const state = EditorState.create({
      schema,
      doc,
      selection: new GapCursor(doc.resolve(pos)),
    });
    const transaction = applyBlockGapFixes(state)!;
    expect(transaction.doc.child(1)?.type.name).toBe('paragraph');
    expect(transaction.doc.firstChild?.type.name).toBe('horizontalRule');
    expect(transaction.doc.lastChild?.type.name).toBe('paragraph');
    expect(transaction.doc.childCount).toBe(4);
  });
});

describe('clickIsAboveFirstBlock', () => {
  it('treats a click above a leading block like a gap between blocks', () => {
    const rule = schema.nodes.horizontalRule!.create();
    expect(clickIsAboveFirstBlock(rule, 40, 80)).toBe(true);
    expect(clickIsAboveFirstBlock(rule, 90, 80)).toBe(false);
    expect(clickIsAboveFirstBlock(schema.nodes.paragraph!.create(), 40, 80)).toBe(false);
  });
});
