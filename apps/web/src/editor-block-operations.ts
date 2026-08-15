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

export function removeAttachmentNodes(
  state: EditorState,
  attachmentId: string,
): Transaction | null {
  const positions: number[] = [];
  const attachmentPath = `/api/attachments/${encodeURIComponent(attachmentId)}`;
  state.doc.descendants((node, position) => {
    const nodeAttachmentId = String(node.attrs.attachmentId ?? '');
    const source = String(node.attrs.src ?? '');
    if (nodeAttachmentId === attachmentId || source.includes(attachmentPath))
      positions.push(position);
  });
  if (!positions.length) return null;

  const transaction = state.tr;
  const paragraph = state.schema.nodes.paragraph;
  for (const position of [...positions].sort((left, right) => right - left)) {
    const node = transaction.doc.nodeAt(position);
    if (!node) continue;
    const resolved = transaction.doc.resolve(position);
    const index = resolved.index();
    if (
      paragraph &&
      resolved.parent.childCount === 1 &&
      resolved.parent.canReplaceWith(index, index + 1, paragraph)
    ) {
      transaction.replaceWith(position, position + node.nodeSize, paragraph.create());
    } else {
      transaction.delete(position, position + node.nodeSize);
    }
  }
  const selectionPosition = Math.min(state.selection.from, transaction.doc.content.size);
  transaction.setSelection(Selection.near(transaction.doc.resolve(selectionPosition)));
  return transaction;
}
