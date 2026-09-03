import { Extension } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import type { Node as ProseMirrorNode, NodeType, ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';

const pluginKey = new PluginKey('blockGapParagraphs');

function isGapPosition($pos: ResolvedPos): boolean {
  const valid = (GapCursor as unknown as { valid?: (pos: ResolvedPos) => boolean }).valid;
  return typeof valid === 'function' && valid($pos);
}

export function isGapCursorPosition($pos: ResolvedPos): boolean {
  return isGapPosition($pos);
}

export function isParagraph(node: ProseMirrorNode | null | undefined): boolean {
  return node?.type.name === 'paragraph';
}

export function clickIsAboveFirstBlock(
  first: ProseMirrorNode | null | undefined,
  clickY: number,
  firstBlockTop: number,
): boolean {
  return Boolean(first && !first.isTextblock && clickY < firstBlockTop);
}

function firstBlockTop(view: EditorView): number {
  const dom = view.nodeDOM(0);
  if (!(dom instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
  const block = dom.closest('.tableWrapper') ?? dom;
  return block.getBoundingClientRect().top;
}

function insertParagraphAboveFirstBlock(
  view: EditorView,
  clickY: number,
  paragraph: NodeType,
): boolean {
  if (!clickIsAboveFirstBlock(view.state.doc.firstChild, clickY, firstBlockTop(view))) {
    return false;
  }
  const transaction = view.state.tr.insert(0, paragraph.create());
  transaction.setSelection(TextSelection.create(transaction.doc, 1));
  view.dispatch(transaction.scrollIntoView());
  return true;
}

function isUnusedLeadingBlockParagraph(doc: ProseMirrorNode, selectionFrom: number): boolean {
  const first = doc.firstChild;
  if (!first || !isParagraph(first) || first.content.size !== 0) return false;
  const second = doc.childCount > 1 ? doc.child(1) : null;
  return Boolean(second && !second.isTextblock && selectionFrom >= first.nodeSize);
}

export function applyBlockGapFixes(state: EditorState): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return null;

  let tr = state.tr;
  let changed = false;
  let fromGap = false;

  if (state.selection instanceof GapCursor) {
    const pos = state.selection.from;
    tr = tr.insert(pos, paragraph.create());
    tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    changed = true;
    fromGap = true;
  }

  const leading = tr.doc.firstChild;
  if (leading && !fromGap && isUnusedLeadingBlockParagraph(tr.doc, tr.selection.from)) {
    tr = tr.delete(0, leading.nodeSize);
    changed = true;
  }

  const last = tr.doc.lastChild;
  if (!isParagraph(last)) {
    tr = tr.insert(tr.doc.content.size, paragraph.create());
    changed = true;
  }

  if (!changed) return null;
  if (!fromGap) tr.setMeta('addToHistory', false);
  return tr;
}

export const BlockGapParagraphs = Extension.create({
  name: 'blockGapParagraphs',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: pluginKey,
        appendTransaction(transactions, _oldState, newState) {
          if (!editor.isEditable) return null;
          if (
            !transactions.some((transaction) => transaction.docChanged || transaction.selectionSet)
          ) {
            return null;
          }
          return applyBlockGapFixes(newState);
        },
        props: {
          handleClick(view, pos, event) {
            if (!view.editable) return false;
            const paragraph = view.state.schema.nodes.paragraph;
            if (!paragraph) return false;
            if (insertParagraphAboveFirstBlock(view, event.clientY, paragraph)) return true;
            const $pos = view.state.doc.resolve(pos);
            if (!isGapPosition($pos)) return false;
            const transaction = view.state.tr.insert(pos, paragraph.create());
            transaction.setSelection(TextSelection.create(transaction.doc, pos + 1));
            view.dispatch(transaction.scrollIntoView());
            return true;
          },
          handleDOMEvents: {
            mousedown(view, event) {
              if (!view.editable) return false;
              const paragraph = view.state.schema.nodes.paragraph;
              if (!paragraph) return false;
              if (!insertParagraphAboveFirstBlock(view, event.clientY, paragraph)) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
