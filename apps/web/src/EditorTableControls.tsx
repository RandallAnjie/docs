import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { BetweenHorizontalEnd, BetweenVerticalEnd, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export function tableWrapperElement(editor: Editor): HTMLElement | null {
  const { state, view } = editor;
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'table') continue;
    const dom = view.nodeDOM($from.before(depth));
    if (!(dom instanceof HTMLElement)) return null;
    return dom.classList.contains('tableWrapper') ? dom : (dom.closest('.tableWrapper') ?? dom);
  }
  return null;
}

export function lastTableCellPos(tablePos: number, table: ProseMirrorNode): number | null {
  let last: number | null = null;
  table.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      last = tablePos + 1 + pos + 1;
    }
  });
  return last;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function runAtLastTableCell(editor: Editor, command: 'addRowAfter' | 'addColumnAfter'): void {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'table') continue;
    const pos = lastTableCellPos($from.before(depth), $from.node(depth));
    if (pos === null) return;
    const chain = editor.chain().focus().setTextSelection(pos);
    if (command === 'addRowAfter') chain.addRowAfter().run();
    else chain.addColumnAfter().run();
    return;
  }
}

export function EditorTableControls({ editor }: { editor: Editor }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor.isEditable || editor.isDestroyed || !editor.isActive('table')) {
          setRect((current) => (current ? null : current));
          return;
        }
        const next = tableWrapperElement(editor)?.getBoundingClientRect() ?? null;
        setRect((current) => (sameRect(current, next) ? current : next));
      });
    };
    update();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [editor]);

  if (!rect || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        className="rdocs-table-toolbar"
        role="toolbar"
        aria-label="表格"
        style={{ left: Math.max(8, rect.left), top: Math.max(8, rect.top - 44) }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          title="在下方插入行"
          aria-label="在下方插入行"
          onClick={() => editor.chain().focus().addRowAfter().run()}
        >
          <BetweenHorizontalEnd size={14} /> 插入行
        </button>
        <button
          type="button"
          title="在右侧插入列"
          aria-label="在右侧插入列"
          onClick={() => editor.chain().focus().addColumnAfter().run()}
        >
          <BetweenVerticalEnd size={14} /> 插入列
        </button>
        <button
          type="button"
          title="删除当前行"
          aria-label="删除当前行"
          onClick={() => editor.chain().focus().deleteRow().run()}
        >
          删除行
        </button>
        <button
          type="button"
          title="删除当前列"
          aria-label="删除当前列"
          onClick={() => editor.chain().focus().deleteColumn().run()}
        >
          删除列
        </button>
        <button
          type="button"
          className="danger"
          title="删除整张表格"
          aria-label="删除整张表格"
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <button
        type="button"
        className="rdocs-table-add-col"
        style={{ left: rect.right + 6, top: rect.top, height: rect.height }}
        title="在表尾插入列"
        aria-label="在表尾插入列"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => runAtLastTableCell(editor, 'addColumnAfter')}
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        className="rdocs-table-add-row"
        style={{ left: rect.left, top: rect.bottom + 6, width: rect.width }}
        title="在表尾插入行"
        aria-label="在表尾插入行"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => runAtLastTableCell(editor, 'addRowAfter')}
      >
        <Plus size={14} />
      </button>
    </>,
    document.body,
  );
}
