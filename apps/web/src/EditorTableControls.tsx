import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  GripHorizontal,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Floating } from './floating';

const ADD_HOVER_HIDE_MS = 200;
const TABLE_CHROME_SELECTOR =
  '.rdocs-table-toolbar, .rdocs-table-add-row, .rdocs-table-add-col, .rdocs-table-handle, .rdocs-table-menu';

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

export function isTableChrome(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return Boolean((target as Element).closest(TABLE_CHROME_SELECTOR));
}

type CellCommand =
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteRow'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteColumn';

interface HoveredCell {
  cell: HTMLElement;
  wrapper: HTMLElement;
  lastRow: boolean;
  lastColumn: boolean;
}

function cellPosition(editor: Editor, cell: HTMLElement): number | null {
  try {
    return editor.view.posAtDOM(cell, 0);
  } catch {
    return null;
  }
}

function runCellCommand(editor: Editor, cell: HTMLElement, command: CellCommand) {
  const pos = cellPosition(editor, cell);
  if (pos === null) return;
  const chain = editor.chain().focus().setTextSelection(pos);
  switch (command) {
    case 'addRowBefore':
      chain.addRowBefore().run();
      break;
    case 'addRowAfter':
      chain.addRowAfter().run();
      break;
    case 'deleteRow':
      chain.deleteRow().run();
      break;
    case 'addColumnBefore':
      chain.addColumnBefore().run();
      break;
    case 'addColumnAfter':
      chain.addColumnAfter().run();
      break;
    case 'deleteColumn':
      chain.deleteColumn().run();
      break;
  }
}

function describeCell(cell: HTMLElement): HoveredCell | null {
  const wrapper = cell.closest('.tableWrapper');
  const row = cell.closest('tr');
  const table = cell.closest('table');
  if (!(wrapper instanceof HTMLElement) || !row || !table) return null;
  const rows = table.querySelectorAll('tr');
  return {
    cell,
    wrapper,
    lastRow: rows[rows.length - 1] === row,
    lastColumn: row.lastElementChild === cell,
  };
}

/**
 * Notion-style table chrome: a handle on the table's left border for the
 * hovered row and one on its top border for the hovered column (each opens
 * its own menu), plus "+" bars when the pointer is in the last row or column.
 * Nothing floats over the text above or below the table.
 */
export function EditorTableControls({ editor }: { editor: Editor }) {
  const [hovered, setHovered] = useState<HoveredCell | null>(null);
  const [menu, setMenu] = useState<'row' | 'column' | null>(null);
  const [, setTick] = useState(0);
  const hideTimer = useRef(0);
  const menuRef = useRef<'row' | 'column' | null>(null);
  menuRef.current = menu;
  const [rowAnchor, setRowAnchor] = useState<HTMLButtonElement | null>(null);
  const [columnAnchor, setColumnAnchor] = useState<HTMLButtonElement | null>(null);

  const hide = useCallback(() => {
    if (menuRef.current) return;
    setHovered(null);
  }, []);

  useEffect(() => {
    if (editor.isDestroyed) return;
    const root = editor.view.dom;
    const onMove = (event: PointerEvent) => {
      if (menuRef.current || !editor.isEditable) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const cell = target.closest('td, th');
      if (!(cell instanceof HTMLElement) || !root.contains(cell)) return;
      window.clearTimeout(hideTimer.current);
      setHovered((current) => (current?.cell === cell ? current : describeCell(cell)));
    };
    const onOut = (event: PointerEvent) => {
      const next = event.relatedTarget;
      if (isTableChrome(next)) return;
      if (next instanceof Element && next.closest('td, th') && root.contains(next)) return;
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(hide, ADD_HOVER_HIDE_MS);
    };
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerout', onOut);
    return () => {
      window.clearTimeout(hideTimer.current);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerout', onOut);
    };
  }, [editor, hide]);

  // Follow scrolling, resizing and edits while the controls are shown.
  useEffect(() => {
    if (!hovered) return;
    const update = () => {
      if (!hovered.cell.isConnected) {
        setHovered(null);
        return;
      }
      setTick((value) => value + 1);
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    editor.on('transaction', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      editor.off('transaction', update);
    };
  }, [editor, hovered]);

  const closeMenu = useCallback(() => setMenu(null), []);

  if (!hovered || !editor.isEditable || typeof document === 'undefined') return null;
  const tableRect = (
    hovered.wrapper.querySelector('table') ?? hovered.wrapper
  ).getBoundingClientRect();
  const visible = hovered.wrapper.getBoundingClientRect();
  const cellRect = hovered.cell.getBoundingClientRect();
  const rowRect = (hovered.cell.closest('tr') ?? hovered.cell).getBoundingClientRect();
  const keep = () => window.clearTimeout(hideTimer.current);
  const leave = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(hide, ADD_HOVER_HIDE_MS);
  };
  const run = (command: CellCommand) => {
    runCellCommand(editor, hovered.cell, command);
    setMenu(null);
    setHovered(null);
  };
  const columnLeft = Math.min(
    Math.max(cellRect.left + cellRect.width / 2 - 12, visible.left),
    visible.right - 24,
  );

  return createPortal(
    <>
      <button
        ref={setRowAnchor}
        type="button"
        className={`rdocs-table-handle is-row${menu === 'row' ? ' is-open' : ''}`}
        style={{ left: tableRect.left - 9, top: rowRect.top + rowRect.height / 2 - 12 }}
        aria-label="行操作"
        title="行操作"
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={keep}
        onPointerLeave={leave}
        onClick={() => setMenu((current) => (current === 'row' ? null : 'row'))}
      >
        <GripVertical size={12} />
      </button>
      <button
        ref={setColumnAnchor}
        type="button"
        className={`rdocs-table-handle is-column${menu === 'column' ? ' is-open' : ''}`}
        style={{ left: columnLeft, top: tableRect.top - 9 }}
        aria-label="列操作"
        title="列操作"
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={keep}
        onPointerLeave={leave}
        onClick={() => setMenu((current) => (current === 'column' ? null : 'column'))}
      >
        <GripHorizontal size={12} />
      </button>
      {hovered.lastColumn ? (
        <button
          type="button"
          className="rdocs-table-add-col"
          style={{
            left: Math.min(tableRect.right, visible.right) + 4,
            top: tableRect.top,
            height: tableRect.height,
          }}
          title="在右侧添加一列"
          aria-label="在右侧添加一列"
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={keep}
          onPointerLeave={leave}
          onClick={() => run('addColumnAfter')}
        >
          <Plus size={13} />
        </button>
      ) : null}
      {hovered.lastRow ? (
        <button
          type="button"
          className="rdocs-table-add-row"
          style={{
            left: visible.left,
            top: tableRect.bottom + 4,
            width: Math.min(tableRect.width, visible.width),
          }}
          title="在下方添加一行"
          aria-label="在下方添加一行"
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={keep}
          onPointerLeave={leave}
          onClick={() => run('addRowAfter')}
        >
          <Plus size={13} />
        </button>
      ) : null}
      <Floating
        anchor={rowAnchor}
        open={menu === 'row'}
        onClose={closeMenu}
        className="database-field-menu-pop rdocs-table-menu"
      >
        <button type="button" role="menuitem" onClick={() => run('addRowBefore')}>
          <ArrowUp size={14} /> 在上方插入行
        </button>
        <button type="button" role="menuitem" onClick={() => run('addRowAfter')}>
          <ArrowDown size={14} /> 在下方插入行
        </button>
        <hr />
        <button type="button" role="menuitem" className="danger" onClick={() => run('deleteRow')}>
          <Trash2 size={14} /> 删除行
        </button>
      </Floating>
      <Floating
        anchor={columnAnchor}
        open={menu === 'column'}
        onClose={closeMenu}
        className="database-field-menu-pop rdocs-table-menu"
      >
        <button type="button" role="menuitem" onClick={() => run('addColumnBefore')}>
          <ArrowLeft size={14} /> 在左侧插入列
        </button>
        <button type="button" role="menuitem" onClick={() => run('addColumnAfter')}>
          <ArrowRight size={14} /> 在右侧插入列
        </button>
        <hr />
        <button
          type="button"
          role="menuitem"
          className="danger"
          onClick={() => run('deleteColumn')}
        >
          <Trash2 size={14} /> 删除列
        </button>
      </Floating>
    </>,
    document.body,
  );
}
