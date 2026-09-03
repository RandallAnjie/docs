import DragHandle from '@tiptap/extension-drag-handle-react';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  ArrowDown,
  ArrowUp,
  BetweenHorizontalStart,
  CheckSquare,
  Code2,
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Link2,
  List,
  ListOrdered,
  MoreHorizontal,
  Pilcrow,
  Plus,
  Quote,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { showToast } from './dialogs';
import { lastTableCellPos } from './EditorTableControls';
import { moveTopLevelBlock, topLevelBlocks, type BlockDirection } from './editor-block-operations';

const DRAG_POSITION = { placement: 'left-start', strategy: 'fixed' } as const;
const HANDLE_KEEP_HIDE_MS = 160;
const HANDLE_KEEP_PAD = 16;
const HANDLE_NODE_EDGE = 48;

export type HandleKeepBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function boxContains(box: HandleKeepBox, x: number, y: number, pad = 0): boolean {
  return x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad;
}

/** Keep the handle while the pointer travels the gutter between the block and the handle. */
export function pointerInBlockHandleKeepZone(
  x: number,
  y: number,
  handle: HandleKeepBox,
  node: HandleKeepBox | null,
  options?: { pad?: number; nodeEdge?: number },
): boolean {
  const pad = options?.pad ?? HANDLE_KEEP_PAD;
  const nodeEdge = options?.nodeEdge ?? HANDLE_NODE_EDGE;
  if (boxContains(handle, x, y, pad)) return true;
  if (!node) return false;
  const corridor: HandleKeepBox = {
    left: Math.min(handle.left, node.left) - pad,
    right: Math.max(handle.right, node.left + nodeEdge) + pad,
    top: Math.min(handle.top, node.top) - pad,
    bottom: Math.max(handle.bottom, node.bottom) + pad,
  };
  return boxContains(corridor, x, y);
}

function blockHandleNodeDom(editor: Editor, position: number): HTMLElement | null {
  const dom = editor.view.nodeDOM(position);
  if (!(dom instanceof HTMLElement)) return null;
  return dom.closest('.tableWrapper') ?? dom;
}

type BlockTransform =
  | 'blockquote'
  | 'bulletList'
  | 'codeBlock'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'orderedList'
  | 'paragraph'
  | 'taskList';

function firstTextblockPosition(node: ProseMirrorNode, position: number): number | null {
  if (node.isTextblock) return position + 1;
  let result: number | null = null;
  node.descendants((child, offset) => {
    if (result !== null) return false;
    if (child.isTextblock) {
      result = position + offset + 2;
      return false;
    }
    return true;
  });
  return result;
}

function unwrapCurrentBlock(editor: Editor, nodeName: string, textPosition: number) {
  const chain = editor.chain().focus().setTextSelection(textPosition);
  switch (nodeName) {
    case 'bulletList':
      return chain.toggleBulletList();
    case 'orderedList':
      return chain.toggleOrderedList();
    case 'taskList':
      return chain.toggleTaskList();
    case 'blockquote':
      return chain.toggleBlockquote();
    case 'codeBlock':
      return chain.toggleCodeBlock();
    default:
      return chain;
  }
}

function transformBlock(editor: Editor, position: number, transform: BlockTransform): void {
  const node = editor.state.doc.nodeAt(position);
  if (!node) return;
  const textPosition = firstTextblockPosition(node, position);
  if (textPosition === null) return;
  const chain = unwrapCurrentBlock(editor, node.type.name, textPosition);

  switch (transform) {
    case 'heading1':
      chain.setHeading({ level: 1 }).run();
      break;
    case 'heading2':
      chain.setHeading({ level: 2 }).run();
      break;
    case 'heading3':
      chain.setHeading({ level: 3 }).run();
      break;
    case 'bulletList':
      chain.setParagraph().toggleBulletList().run();
      break;
    case 'orderedList':
      chain.setParagraph().toggleOrderedList().run();
      break;
    case 'taskList':
      chain.setParagraph().toggleTaskList().run();
      break;
    case 'blockquote':
      chain.setParagraph().toggleBlockquote().run();
      break;
    case 'codeBlock':
      chain.setParagraph().toggleCodeBlock().run();
      break;
    default:
      chain.setParagraph().run();
  }
}

const TRANSFORMS: Array<{
  icon: ReactNode;
  id: BlockTransform;
  label: string;
}> = [
  { id: 'paragraph', label: '正文', icon: <Pilcrow size={14} /> },
  { id: 'heading1', label: '一级标题', icon: <Heading1 size={14} /> },
  { id: 'heading2', label: '二级标题', icon: <Heading2 size={14} /> },
  { id: 'heading3', label: '三级标题', icon: <Heading3 size={14} /> },
  { id: 'bulletList', label: '无序列表', icon: <List size={14} /> },
  { id: 'orderedList', label: '有序列表', icon: <ListOrdered size={14} /> },
  { id: 'taskList', label: '待办清单', icon: <CheckSquare size={14} /> },
  { id: 'blockquote', label: '引用', icon: <Quote size={14} /> },
  { id: 'codeBlock', label: '代码块', icon: <Code2 size={14} /> },
];

const TRANSFORMABLE_BLOCKS = new Set([
  'blockquote',
  'bulletList',
  'codeBlock',
  'heading',
  'orderedList',
  'paragraph',
  'taskList',
]);

export function EditorBlockHandle({
  editor,
  onCopyBlockLink,
  onConvertToSyncedBlock,
}: {
  editor: Editor;
  onCopyBlockLink: (position: number) => Promise<void>;
  onConvertToSyncedBlock: (position: number, node: ProseMirrorNode) => Promise<void>;
}) {
  const controls = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [targetPosition, setTargetPosition] = useState(-1);
  const [targetNodeName, setTargetNodeName] = useState('');
  const [busy, setBusy] = useState(false);
  const menuOpenRef = useRef(false);
  const keepLockedRef = useRef(false);
  menuOpenRef.current = menuOpen;

  const handleNodeChange = useCallback(
    ({ node, pos }: { node: ProseMirrorNode | null; pos: number }) => {
      if (menuOpenRef.current) return;
      setTargetPosition(node ? pos : -1);
      setTargetNodeName(node?.type.name ?? '');
    },
    [],
  );

  const syncHandleLock = useCallback(
    (keepLocked: boolean) => {
      keepLockedRef.current = keepLocked;
      if (editor.isDestroyed) return;
      editor.view.dispatch(
        editor.state.tr.setMeta('lockDragHandle', menuOpenRef.current || keepLocked),
      );
    },
    [editor],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!controls.current?.contains(event.target as globalThis.Node)) setMenuOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    syncHandleLock(keepLockedRef.current);
  }, [menuOpen, syncHandleLock]);

  useEffect(() => {
    if (targetPosition < 0) return;
    const editorDom = editor.view.dom;
    let hideTimer = 0;

    const handleEl = () =>
      (controls.current?.closest('.rdocs-drag-handle-portal') as HTMLElement | null) ??
      controls.current;

    const inKeepZone = (x: number, y: number) => {
      const handle = handleEl();
      if (!handle) return false;
      const node = blockHandleNodeDom(editor, targetPosition);
      return pointerInBlockHandleKeepZone(
        x,
        y,
        handle.getBoundingClientRect(),
        node?.getBoundingClientRect() ?? null,
      );
    };

    const overNode = (x: number, y: number) => {
      const node = blockHandleNodeDom(editor, targetPosition);
      return node ? boxContains(node.getBoundingClientRect(), x, y, HANDLE_KEEP_PAD) : false;
    };

    const hideHandle = () => {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
      if (menuOpenRef.current) return;
      syncHandleLock(false);
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta('hideDragHandle', true));
      }
    };

    const onMove = (event: PointerEvent) => {
      if (menuOpenRef.current) return;
      if (inKeepZone(event.clientX, event.clientY)) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
        if (!keepLockedRef.current) syncHandleLock(true);
        return;
      }
      if (overNode(event.clientX, event.clientY)) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
        if (keepLockedRef.current) syncHandleLock(false);
        return;
      }
      if (!keepLockedRef.current) return;
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hideHandle, HANDLE_KEEP_HIDE_MS);
    };

    const onEditorLeave = (event: MouseEvent) => {
      if (menuOpenRef.current) return;
      const handle = handleEl();
      const related = event.relatedTarget;
      if (handle && related instanceof Node && handle.contains(related)) {
        syncHandleLock(true);
        return;
      }
      if (inKeepZone(event.clientX, event.clientY)) syncHandleLock(true);
    };

    document.addEventListener('pointermove', onMove);
    editorDom.addEventListener('mouseleave', onEditorLeave, true);
    return () => {
      window.clearTimeout(hideTimer);
      document.removeEventListener('pointermove', onMove);
      editorDom.removeEventListener('mouseleave', onEditorLeave, true);
    };
  }, [editor, syncHandleLock, targetPosition]);

  useEffect(() => {
    return () => {
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta('lockDragHandle', false));
      }
    };
  }, [editor]);

  const movement = useMemo(() => {
    const blocks = topLevelBlocks(editor.state.doc);
    const index = blocks.findIndex((block) => block.position === targetPosition);
    return { down: index >= 0 && index < blocks.length - 1, up: index > 0 };
  }, [editor.state.doc, targetPosition]);

  const targetNode = targetPosition >= 0 ? editor.state.doc.nodeAt(targetPosition) : null;
  const transformable = Boolean(targetNode && TRANSFORMABLE_BLOCKS.has(targetNode.type.name));

  const insertParagraph = (position: number) => {
    syncHandleLock(false);
    editor
      .chain()
      .focus()
      .insertContentAt(position, {
        type: 'paragraph',
        content: [{ type: 'text', text: '/' }],
      })
      .setTextSelection(position + 2)
      .run();
  };

  const insertAbove = () => {
    if (targetPosition < 0) return;
    insertParagraph(targetPosition);
  };

  const insertBelow = () => {
    const current = editor.state.doc.nodeAt(targetPosition);
    if (!current) return;
    insertParagraph(targetPosition + current.nodeSize);
  };

  const duplicate = () => {
    const current = editor.state.doc.nodeAt(targetPosition);
    if (!current) return;
    const insertionPosition = targetPosition + current.nodeSize;
    editor
      .chain()
      .focus()
      .insertContentAt(insertionPosition, current.toJSON())
      .setNodeSelection(insertionPosition)
      .run();
    setMenuOpen(false);
  };

  const remove = () => {
    const current = editor.state.doc.nodeAt(targetPosition);
    if (!current) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: targetPosition, to: targetPosition + current.nodeSize })
      .run();
    setMenuOpen(false);
  };

  const convertToSyncedBlock = async () => {
    const current = editor.state.doc.nodeAt(targetPosition);
    if (!current || busy) return;
    setMenuOpen(false);
    setBusy(true);
    try {
      await onConvertToSyncedBlock(targetPosition, current);
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '无法转换为同步块');
    } finally {
      setBusy(false);
    }
  };

  const copyBlockLink = async () => {
    if (targetPosition < 0 || busy) return;
    setMenuOpen(false);
    try {
      await onCopyBlockLink(targetPosition);
      showToast('块链接已复制', 'success');
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : '无法复制块链接');
    }
  };

  const move = (direction: BlockDirection) => {
    const transaction = moveTopLevelBlock(editor.state, targetPosition, direction);
    if (transaction) editor.view.dispatch(transaction);
    setMenuOpen(false);
  };

  return (
    <DragHandle
      editor={editor}
      className="rdocs-drag-handle-portal"
      computePositionConfig={DRAG_POSITION}
      nested
      onNodeChange={handleNodeChange}
      onElementDragStart={() => setMenuOpen(false)}
    >
      <div
        className="rdocs-block-controls"
        ref={controls}
        onPointerEnter={() => syncHandleLock(true)}
        onPointerLeave={() => {
          if (!menuOpenRef.current) syncHandleLock(false);
        }}
      >
        {!movement.up ? (
          <button
            type="button"
            className="rdocs-block-add"
            title="在上方插入内容块"
            aria-label="在上方插入内容块"
            disabled={targetPosition < 0}
            draggable={false}
            onMouseDown={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
            onClick={insertAbove}
          >
            <BetweenHorizontalStart size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="rdocs-block-add"
          title="在下方插入内容块"
          aria-label="在下方插入内容块"
          disabled={targetPosition < 0}
          draggable={false}
          onMouseDown={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
          onClick={insertBelow}
        >
          <Plus size={15} />
        </button>
        <span className="rdocs-block-grip" title="拖动内容块" aria-label="拖动内容块">
          <GripVertical size={16} />
        </span>
        <button
          type="button"
          className="rdocs-block-more"
          title="内容块菜单"
          aria-label="内容块菜单"
          disabled={targetPosition < 0}
          draggable={false}
          onPointerDown={(event) => {
            event.stopPropagation();
            syncHandleLock(true);
          }}
          onMouseDown={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && targetNode ? (
          <div
            className="rdocs-block-menu"
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>内容块</strong>
              <small>{targetNodeName}</small>
            </header>
            {transformable ? (
              <>
                <label>转换为</label>
                <div className="rdocs-block-transform-grid">
                  {TRANSFORMS.map((transform) => (
                    <button
                      key={transform.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        transformBlock(editor, targetPosition, transform.id);
                        setMenuOpen(false);
                      }}
                    >
                      {transform.icon}
                      <span>{transform.label}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {targetNodeName === 'table' ? (
              <>
                <label>表格</label>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const cellPos = targetNode
                      ? lastTableCellPos(targetPosition, targetNode)
                      : null;
                    if (cellPos !== null) {
                      editor.chain().focus().setTextSelection(cellPos).addRowAfter().run();
                    }
                    setMenuOpen(false);
                  }}
                >
                  <Plus size={14} /> 下方插入行
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const cellPos = targetNode
                      ? lastTableCellPos(targetPosition, targetNode)
                      : null;
                    if (cellPos !== null) {
                      editor.chain().focus().setTextSelection(cellPos).addColumnAfter().run();
                    }
                    setMenuOpen(false);
                  }}
                >
                  <Plus size={14} /> 右侧插入列
                </button>
              </>
            ) : null}
            <label>操作</label>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                insertAbove();
                setMenuOpen(false);
              }}
            >
              <BetweenHorizontalStart size={14} /> 上方插入
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                insertBelow();
                setMenuOpen(false);
              }}
            >
              <Plus size={14} /> 下方插入
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={
                busy || targetNodeName === 'syncedBlock' || targetNodeName === 'deletedSyncedBlock'
              }
              onClick={() => void convertToSyncedBlock()}
            >
              <RefreshCw size={14} /> 转为同步块
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!movement.up}
              onClick={() => move('up')}
            >
              <ArrowUp size={14} /> 上移
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!movement.down}
              onClick={() => move('down')}
            >
              <ArrowDown size={14} /> 下移
            </button>
            <button type="button" role="menuitem" onClick={duplicate}>
              <Copy size={14} /> 创建副本
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void copyBlockLink()}
            >
              <Link2 size={14} /> 复制块链接
            </button>
            <button type="button" role="menuitem" className="danger" onClick={remove}>
              <Trash2 size={14} /> 删除
            </button>
          </div>
        ) : null}
      </div>
    </DragHandle>
  );
}
