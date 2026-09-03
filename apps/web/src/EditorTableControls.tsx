import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { BetweenHorizontalEnd, BetweenVerticalEnd, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const ADD_HOVER_HIDE_MS = 200;
const TABLE_CHROME_SELECTOR = '.rdocs-table-toolbar, .rdocs-table-add-row, .rdocs-table-add-col';

export type TableToolbarCommand =
  'addRowAfter' | 'addColumnAfter' | 'deleteRow' | 'deleteColumn' | 'deleteTable';

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

export function tableFromWrapper(
  editor: Editor,
  wrapper: HTMLElement,
): { pos: number; node: ProseMirrorNode } | null {
  const table = wrapper.querySelector('table') ?? wrapper;
  try {
    const pos = editor.view.posAtDOM(table, 0);
    const $pos = editor.state.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.name === 'table') {
        return { pos: $pos.before(depth), node: $pos.node(depth) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function runTableCommand(editor: Editor, command: TableToolbarCommand, pos?: number): void {
  const chain =
    pos === undefined ? editor.chain().focus() : editor.chain().focus().setTextSelection(pos);
  switch (command) {
    case 'addRowAfter':
      chain.addRowAfter().run();
      break;
    case 'addColumnAfter':
      chain.addColumnAfter().run();
      break;
    case 'deleteRow':
      chain.deleteRow().run();
      break;
    case 'deleteColumn':
      chain.deleteColumn().run();
      break;
    case 'deleteTable':
      chain.deleteTable().run();
      break;
    default:
      break;
  }
}

function runAtLastTableCell(
  editor: Editor,
  table: { pos: number; node: ProseMirrorNode },
  command: TableToolbarCommand,
): void {
  const pos = lastTableCellPos(table.pos, table.node);
  if (pos === null) return;
  runTableCommand(editor, command, pos);
}

export function isTableChrome(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return Boolean((target as Element).closest(TABLE_CHROME_SELECTOR));
}

export function EditorTableControls({ editor }: { editor: Editor }) {
  const [focusedRect, setFocusedRect] = useState<DOMRect | null>(null);
  const [hoverWrapper, setHoverWrapper] = useState<HTMLElement | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hoverRef = useRef<HTMLElement | null>(null);
  const hideTimer = useRef(0);

  useEffect(() => {
    let frame = 0;
    const updateFocused = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor.isEditable || editor.isDestroyed || !editor.isActive('table')) {
          setFocusedRect((current) => (current ? null : current));
          return;
        }
        const next = tableWrapperElement(editor)?.getBoundingClientRect() ?? null;
        setFocusedRect((current) => (sameRect(current, next) ? current : next));
      });
    };
    updateFocused();
    editor.on('selectionUpdate', updateFocused);
    editor.on('transaction', updateFocused);
    window.addEventListener('scroll', updateFocused, true);
    window.addEventListener('resize', updateFocused);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('selectionUpdate', updateFocused);
      editor.off('transaction', updateFocused);
      window.removeEventListener('scroll', updateFocused, true);
      window.removeEventListener('resize', updateFocused);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor.isEditable || editor.isDestroyed) return;
    const root = editor.view.dom;
    const clearHide = () => window.clearTimeout(hideTimer.current);
    const hide = () => {
      hoverRef.current = null;
      setHoverWrapper(null);
      setHoverRect(null);
    };
    const scheduleHide = () => {
      clearHide();
      hideTimer.current = window.setTimeout(hide, ADD_HOVER_HIDE_MS);
    };
    const showWrapper = (wrapper: HTMLElement) => {
      clearHide();
      hoverRef.current = wrapper;
      setHoverWrapper(wrapper);
      setHoverRect((current) => {
        const next = wrapper.getBoundingClientRect();
        return sameRect(current, next) ? current : next;
      });
    };
    const onOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const wrapper = target.closest('.tableWrapper');
      if (wrapper instanceof HTMLElement && root.contains(wrapper)) showWrapper(wrapper);
    };
    const onOut = (event: PointerEvent) => {
      if (isTableChrome(event.relatedTarget)) return;
      const related = event.relatedTarget;
      if (related instanceof Element && related.closest('.tableWrapper') === hoverRef.current) {
        return;
      }
      scheduleHide();
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerout', onOut);
    return () => {
      clearHide();
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
    };
  }, [editor]);

  useEffect(() => {
    if (!hoverWrapper) return;
    const update = () => {
      const next = hoverWrapper.getBoundingClientRect();
      setHoverRect((current) => (sameRect(current, next) ? current : next));
    };
    update();
    hoverWrapper.addEventListener('scroll', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    editor.on('transaction', update);
    return () => {
      hoverWrapper.removeEventListener('scroll', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      editor.off('transaction', update);
    };
  }, [editor, hoverWrapper]);

  const coarsePointer = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
  const tableRect = hoverRect ?? (coarsePointer ? focusedRect : null);
  const tableWrapper = hoverWrapper ?? (coarsePointer ? tableWrapperElement(editor) : null);

  if (!tableRect || typeof document === 'undefined') return null;

  const keepVisible = () => window.clearTimeout(hideTimer.current);
  const leaveChrome = () => {
    hideTimer.current = window.setTimeout(() => {
      hoverRef.current = null;
      setHoverWrapper(null);
      setHoverRect(null);
    }, ADD_HOVER_HIDE_MS);
  };

  const runOnTable = (command: TableToolbarCommand) => {
    const wrapper = tableWrapper;
    if (!wrapper) return;
    const selected = tableWrapperElement(editor);
    if (selected === wrapper && editor.isActive('table')) {
      runTableCommand(editor, command);
      return;
    }
    const table = tableFromWrapper(editor, wrapper);
    if (table) runAtLastTableCell(editor, table, command);
  };

  const addAtEdge = (command: 'addRowAfter' | 'addColumnAfter') => {
    const wrapper = tableWrapper;
    if (!wrapper) return;
    const table = tableFromWrapper(editor, wrapper);
    if (table) runAtLastTableCell(editor, table, command);
  };

  return createPortal(
    <>
      <div
        className="rdocs-table-toolbar"
        role="toolbar"
        aria-label="表格"
        style={{ left: Math.max(8, tableRect.left), top: Math.max(8, tableRect.top - 44) }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={keepVisible}
        onPointerLeave={leaveChrome}
      >
        <button
          type="button"
          title="在下方插入行"
          aria-label="在下方插入行"
          onClick={() => runOnTable('addRowAfter')}
        >
          <BetweenHorizontalEnd size={14} /> 插入行
        </button>
        <button
          type="button"
          title="在右侧插入列"
          aria-label="在右侧插入列"
          onClick={() => runOnTable('addColumnAfter')}
        >
          <BetweenVerticalEnd size={14} /> 插入列
        </button>
        <button
          type="button"
          title="删除当前行"
          aria-label="删除当前行"
          onClick={() => runOnTable('deleteRow')}
        >
          删除行
        </button>
        <button
          type="button"
          title="删除当前列"
          aria-label="删除当前列"
          onClick={() => runOnTable('deleteColumn')}
        >
          删除列
        </button>
        <button
          type="button"
          className="danger"
          title="删除整张表格"
          aria-label="删除整张表格"
          onClick={() => runOnTable('deleteTable')}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <button
        type="button"
        className="rdocs-table-add-col"
        style={{ left: tableRect.right + 6, top: tableRect.top, height: tableRect.height }}
        title="在表尾插入列"
        aria-label="在表尾插入列"
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={keepVisible}
        onPointerLeave={leaveChrome}
        onClick={() => addAtEdge('addColumnAfter')}
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        className="rdocs-table-add-row"
        style={{ left: tableRect.left, top: tableRect.bottom + 6, width: tableRect.width }}
        title="在表尾插入行"
        aria-label="在表尾插入行"
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={keepVisible}
        onPointerLeave={leaveChrome}
        onClick={() => addAtEdge('addRowAfter')}
      >
        <Plus size={14} />
      </button>
    </>,
    document.body,
  );
}
