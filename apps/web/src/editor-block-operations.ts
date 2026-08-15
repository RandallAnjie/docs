import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, type EditorState, type Transaction } from '@tiptap/pm/state';

export interface TopLevelBlock {
  node: ProseMirrorNode;
  position: number;
}

export type BlockDirection = 'down' | 'up';

export function topLevelBlocks(document: ProseMirrorNode): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  document.forEach((node, offset) => blocks.push({ node, position: offset }));
  return blocks;
}

export function moveTopLevelBlock(
  state: EditorState,
  position: number,
  direction: BlockDirection,
): Transaction | null {
  const blocks = topLevelBlocks(state.doc);
  const index = blocks.findIndex((block) => block.position === position);
  const current = blocks[index];
  if (!current) return null;
  const adjacent = blocks[direction === 'up' ? index - 1 : index + 1];
  if (!adjacent) return null;

  const transaction = state.tr;
  let nextPosition: number;
  if (direction === 'up') {
    transaction.delete(current.position, current.position + current.node.nodeSize);
    nextPosition = adjacent.position;
    transaction.insert(nextPosition, current.node);
  } else {
    transaction.delete(current.position, current.position + current.node.nodeSize);
    nextPosition = current.position + adjacent.node.nodeSize;
    transaction.insert(nextPosition, current.node);
  }
  const selectionPosition = Math.min(nextPosition + 1, transaction.doc.content.size);
  transaction.setSelection(Selection.near(transaction.doc.resolve(selectionPosition)));
  transaction.scrollIntoView();
  return transaction;
}
