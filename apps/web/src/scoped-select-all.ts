import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

/** Containers that are their own Cmd+A scope (text inside them first). */
const CONTAINER_SCOPES = new Set([
  'tableCell',
  'tableHeader',
  'callout',
  'blockquote',
  'details',
  'detailsContent',
  'column',
]);

/** Real extent of a selection (a CellSelection's from/to only cover its first range). */
function selectionBounds(selection: Selection): { from: number; to: number } {
  let from = selection.from;
  let to = selection.to;
  for (const range of selection.ranges) {
    from = Math.min(from, range.$from.pos);
    to = Math.max(to, range.$to.pos);
  }
  return { from, to };
}

function strictlyContains(outer: Selection, inner: Selection): boolean {
  if (inner instanceof AllSelection) return false;
  if (outer instanceof CellSelection && inner instanceof CellSelection) {
    return outer.ranges.length > inner.ranges.length;
  }
  const a = selectionBounds(outer);
  const b = selectionBounds(inner);
  return a.from <= b.from && a.to >= b.to && (a.from < b.from || a.to > b.to);
}

function wholeTable(doc: ProseMirrorNode, table: ProseMirrorNode, start: number): Selection {
  const map = TableMap.get(table);
  return CellSelection.create(doc, start + map.map[0]!, start + map.map[map.map.length - 1]!);
}

/**
 * The selection Cmd+A should produce next: the innermost scope around the
 * cursor that is larger than what is selected — text block, then container
 * (table cell, callout, toggle, column…), then the whole table, then the
 * whole document. Returns null when everything is already selected.
 */
export function nextSelectAllScope(state: EditorState): Selection | null {
  const { doc, selection } = state;
  const $from = selection.$from;
  const candidates: Selection[] = [];
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.isTextblock || CONTAINER_SCOPES.has(node.type.name)) {
      candidates.push(
        TextSelection.between(doc.resolve($from.start(depth)), doc.resolve($from.end(depth))),
      );
    }
    if (node.type.name === 'table') candidates.push(wholeTable(doc, node, $from.start(depth)));
  }
  candidates.push(new AllSelection(doc));
  return candidates.find((candidate) => strictlyContains(candidate, selection)) ?? null;
}

export const ScopedSelectAll = Extension.create({
  name: 'scopedSelectAll',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Mod-a': ({ editor }) => {
        const next = nextSelectAllScope(editor.state);
        if (!next) return true;
        editor.view.dispatch(editor.state.tr.setSelection(next).scrollIntoView());
        return true;
      },
    };
  },
});
