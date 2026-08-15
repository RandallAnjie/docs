import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Copy, RefreshCw, RotateCcw, Trash2, Unlink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import type { SyncedBlockReferenceSummary } from '@rdocs/shared';

import {
  deleteAllSyncedBlock,
  getPublicSyncedBlockTicket,
  getSyncedBlockTicket,
  listSyncedBlockReferences,
  restoreDeletedSyncedBlock,
  unsyncAllSyncedBlock,
} from './api';
import { HttpCollaborationTransport } from './http-collaboration';
import type { LocalIdentity } from './identity';

export interface SyncedBlockContext {
  identity: LocalIdentity;
  pageId: string;
  publicShareToken?: string;
}

interface SyncedBlockOptions {
  getContext: () => SyncedBlockContext | null;
}

interface SyncedBlockSession {
  generation: number;
  role: 'editor' | 'viewer';
  sourcePageId: string;
  ticket: string;
}

function caret(user: Record<string, unknown>): HTMLElement {
  const name = typeof user.name === 'string' ? user.name : '协作者';
  const color = typeof user.color === 'string' ? user.color : '#5f7f91';
  const root = document.createElement('span');
  const bubble = document.createElement('span');
  root.className = 'collaboration-carets__caret';
  root.style.borderColor = color;
  bubble.className = 'collaboration-carets__label';
  bubble.style.backgroundColor = color;
  bubble.textContent = [...name.trim()][0] ?? '协';
  root.append(bubble);
  return root;
}

function SyncedBlockEditor({
  document,
  editable,
  identity,
  onReady,
  provider,
}: {
  document: Y.Doc;
  editable: boolean;
  identity: LocalIdentity;
  onReady: (editor: Editor | null) => void;
  provider: WebsocketProvider;
}) {
  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit,
        Collaboration.configure({ document }),
        CollaborationCaret.configure({
          provider,
          user: { name: identity.name, color: identity.color },
          render: caret,
        }),
      ],
      editorProps: {
        attributes: { class: 'rdocs-synced-block-editor', spellcheck: 'true' },
      },
    },
    [document, provider],
  );

  useEffect(() => editor?.setEditable(editable), [editable, editor]);
  useEffect(() => {
    onReady(editor);
    return () => onReady(null);
  }, [editor, onReady]);
  return editor ? <EditorContent editor={editor} /> : null;
}

function SyncedBlockNodeView(props: NodeViewProps) {
  const blockId = String(props.node.attrs.syncedBlockId ?? '');
  const options = props.extension.options as SyncedBlockOptions;
  const context = options.getContext();
  const identityId = context?.identity.id ?? '';
  const identityName = context?.identity.name ?? '';
  const identityColor = context?.identity.color ?? '';
  const pageId = context?.pageId ?? '';
  const publicShareToken = context?.publicShareToken ?? '';
  const [session, setSession] = useState<SyncedBlockSession | null>(null);
  const [collab, setCollab] = useState<{
    document: Y.Doc;
    provider: WebsocketProvider;
    ticket: string;
  } | null>(null);
  const [state, setState] = useState<'connecting' | 'error' | 'synced'>('connecting');
  const [nestedEditor, setNestedEditor] = useState<Editor | null>(null);
  const [locations, setLocations] = useState<SyncedBlockReferenceSummary[] | null>(null);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [managementBusy, setManagementBusy] = useState(false);
  const [ticketRetry, setTicketRetry] = useState(0);

  const loadTicket = useCallback(async () => {
    if (!pageId || !blockId || !identityName) throw new Error('同步块上下文不可用');
    const response = publicShareToken
      ? await getPublicSyncedBlockTicket(publicShareToken, pageId, blockId)
      : await getSyncedBlockTicket(pageId, blockId, { name: identityName });
    return {
      generation: response.generation,
      role: response.role,
      sourcePageId:
        'syncedBlock' in response && response.syncedBlock
          ? response.syncedBlock.sourcePageId
          : pageId,
      ticket: response.ticket,
    } satisfies SyncedBlockSession;
  }, [blockId, identityName, pageId, publicShareToken]);

  useEffect(() => {
    let active = true;
    setSession(null);
    setState('connecting');
    const attempt = async () => {
      for (let retry = 0; retry < 3; retry += 1) {
        try {
          const next = await loadTicket();
          if (active) setSession(next);
          return;
        } catch (reason) {
          if (retry === 2) {
            if (active) setState('error');
            return;
          }
          await new Promise((resolve) => globalThis.setTimeout(resolve, 150 * (retry + 1)));
        }
      }
    };
    void attempt();
    return () => {
      active = false;
    };
  }, [loadTicket, ticketRetry]);

  useEffect(() => {
    if (!session || !identityId || !identityName || !identityColor) return;
    let disposed = false;
    let httpSynced = false;
    const document = new Y.Doc();
    const offline =
      publicShareToken || session.role !== 'editor'
        ? null
        : new IndexeddbPersistence(
            `rdocs:synced-block:${blockId}:generation:${session.generation}`,
            document,
          );
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const provider = new WebsocketProvider(
      `${protocol}//${window.location.host}/collab`,
      blockId,
      document,
      { params: { ticket: session.ticket }, maxBackoffTime: 2_000 },
    );
    provider.awareness.setLocalStateField('user', {
      id: identityId,
      name: identityName,
      color: identityColor,
    });
    provider.on('sync', (synced: boolean) => {
      if (!disposed && synced) setState('synced');
    });
    provider.on('status', ({ status }: { status: string }) => {
      if (!disposed && !httpSynced && status !== 'connected') setState('connecting');
    });
    const renewTicket = async () => {
      const next = await loadTicket();
      const mutableProvider = provider as WebsocketProvider & { params: Record<string, string> };
      mutableProvider.params.ticket = next.ticket;
      provider.disconnect();
      provider.connect();
      if (!disposed && (next.generation !== session.generation || next.role !== session.role)) {
        setSession(next);
      }
      return next.ticket;
    };
    const httpTransport = new HttpCollaborationTransport({
      pageId: blockId,
      syncUrl: `/api/synced-blocks/${encodeURIComponent(blockId)}/collaboration-sync`,
      document,
      awareness: provider.awareness,
      ticket: session.ticket,
      renewTicket,
      onState: (next) => {
        if (disposed) return;
        if (next === 'synced') {
          httpSynced = true;
          setState('synced');
        } else if (next === 'forbidden' || next === 'rebased') {
          setState('error');
        } else if (!provider.synced) {
          setState('connecting');
        }
      },
    });
    void httpTransport.start();
    if (!disposed) setCollab({ document, provider, ticket: session.ticket });
    return () => {
      disposed = true;
      httpTransport.stop();
      provider.destroy();
      offline?.destroy();
      document.destroy();
    };
  }, [blockId, identityColor, identityId, identityName, loadTicket, publicShareToken, session]);

  const duplicateReference = () => {
    const position = typeof props.getPos === 'function' ? props.getPos() : undefined;
    if (typeof position !== 'number') return;
    props.editor
      .chain()
      .focus()
      .insertContentAt(position + props.node.nodeSize, {
        type: 'syncedBlock',
        attrs: { syncedBlockId: blockId },
      })
      .run();
  };

  const unsyncReference = () => {
    const position = typeof props.getPos === 'function' ? props.getPos() : undefined;
    if (typeof position !== 'number' || !nestedEditor) return;
    const content = nestedEditor.getJSON().content;
    props.editor
      .chain()
      .focus()
      .insertContentAt(
        { from: position, to: position + props.node.nodeSize },
        content?.length ? content : [{ type: 'paragraph' }],
      )
      .run();
  };

  const toggleLocations = () => {
    const nextOpen = !locationsOpen;
    setLocationsOpen(nextOpen);
    if (!nextOpen || locations || publicShareToken) return;
    setLocationsError(null);
    void listSyncedBlockReferences(pageId, blockId)
      .then((result) => setLocations(result.references))
      .catch((reason) =>
        setLocationsError(reason instanceof Error ? reason.message : '引用位置加载失败'),
      );
  };

  const unsyncAll = async () => {
    if (managementBusy) return;
    if (!window.confirm('将所有副本转换为独立内容，并永久停止同步？')) return;
    setManagementBusy(true);
    try {
      await unsyncAllSyncedBlock(pageId, blockId);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '全部取消同步失败');
      setManagementBusy(false);
    }
  };

  const deleteReference = async () => {
    if (session?.sourcePageId !== pageId || publicShareToken) {
      props.deleteNode();
      return;
    }
    if (managementBusy) return;
    if (!window.confirm('删除原始同步块会同时删除所有页面中的同步副本。确定继续？')) return;
    setManagementBusy(true);
    try {
      await deleteAllSyncedBlock(pageId, blockId);
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : '删除原始同步块失败');
      setManagementBusy(false);
    }
  };

  return (
    <NodeViewWrapper className="rdocs-synced-block" contentEditable={false}>
      <header>
        <span>
          <RefreshCw size={13} /> 同步块
          <i className={state} aria-live="polite">
            {state === 'synced' ? '已同步' : state === 'error' ? '无法访问' : '同步中…'}
          </i>
          {session && publicShareToken ? (
            <em className="rdocs-synced-block-public-label">原始页面</em>
          ) : session ? (
            <button
              className="rdocs-synced-block-locations-toggle"
              type="button"
              aria-expanded={locationsOpen}
              onClick={toggleLocations}
            >
              {locations
                ? `位于 ${locations.length} 个页面`
                : session.sourcePageId === pageId
                  ? '原始同步块'
                  : '同步副本'}
            </button>
          ) : null}
        </span>
        {props.editor.isEditable ? (
          <span className="rdocs-node-actions">
            <button
              type="button"
              title="创建同步副本"
              aria-label="创建同步副本"
              onClick={duplicateReference}
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              title="取消当前副本的同步"
              aria-label="取消当前副本的同步"
              disabled={!nestedEditor}
              onClick={unsyncReference}
            >
              <Unlink size={13} />
            </button>
            {session?.sourcePageId === pageId && !publicShareToken ? (
              <button
                type="button"
                title="取消全部副本的同步"
                aria-label="取消全部副本的同步"
                disabled={managementBusy}
                onClick={() => void unsyncAll()}
              >
                <RefreshCw size={13} />
              </button>
            ) : null}
            <button
              type="button"
              title={session?.sourcePageId === pageId ? '删除原始块及所有同步副本' : '删除当前引用'}
              aria-label={
                session?.sourcePageId === pageId ? '删除原始块及所有同步副本' : '删除当前引用'
              }
              disabled={managementBusy}
              onClick={() => void deleteReference()}
            >
              <Trash2 size={13} />
            </button>
          </span>
        ) : null}
      </header>
      {locationsOpen && !publicShareToken ? (
        <div className="rdocs-synced-block-locations" role="dialog" aria-label="同步块引用位置">
          <strong>引用位置</strong>
          {locationsError ? <p>{locationsError}</p> : null}
          {!locations && !locationsError ? <p>正在加载…</p> : null}
          {locations?.map((location) =>
            location.pageId === pageId ? (
              <span key={location.pageId}>
                {location.title} {location.isSource ? <i>原始</i> : null}
              </span>
            ) : (
              <a key={location.pageId} href={`/p/${encodeURIComponent(location.pageId)}`}>
                {location.title} {location.isSource ? <i>原始</i> : null}
              </a>
            ),
          )}
        </div>
      ) : null}
      {collab && session && collab.ticket === session.ticket ? (
        <SyncedBlockEditor
          document={collab.document}
          provider={collab.provider}
          identity={{ id: identityId, name: identityName, color: identityColor }}
          editable={session.role === 'editor' && props.editor.isEditable}
          onReady={setNestedEditor}
        />
      ) : state === 'error' ? (
        <p className="rdocs-synced-block-state">
          需要同时具有原始页面和当前页面的访问权限。
          <button
            type="button"
            onClick={() => {
              setState('connecting');
              setTicketRetry((value) => value + 1);
            }}
          >
            重试
          </button>
        </p>
      ) : (
        <p className="rdocs-synced-block-state">正在打开同步内容…</p>
      )}
    </NodeViewWrapper>
  );
}

export const SyncedBlock = Node.create<SyncedBlockOptions>({
  name: 'syncedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { getContext: () => null };
  },
  addAttributes() {
    return { syncedBlockId: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-rdocs-synced-block]',
        getAttrs: (element) => ({
          syncedBlockId: element.getAttribute('data-synced-block-id') ?? '',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-rdocs-synced-block': '',
        'data-synced-block-id': node.attrs.syncedBlockId,
      }),
      '同步块',
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(SyncedBlockNodeView, { stopEvent: () => true });
  },
});

function DeletedSyncedBlockNodeView(props: NodeViewProps) {
  const options = props.extension.options as SyncedBlockOptions;
  const context = options.getContext();
  const operationId = String(props.node.attrs.deletionOperationId ?? '');
  const [state, setState] = useState<'error' | 'idle' | 'restored' | 'restoring'>('idle');
  const [message, setMessage] = useState('');

  const restore = async () => {
    if (!operationId || state === 'restoring') return;
    if (!window.confirm('恢复原始同步块以及所有仍保留的同步引用？')) return;
    setState('restoring');
    setMessage('');
    try {
      await restoreDeletedSyncedBlock(operationId);
      setState('restored');
      setMessage('恢复完成，正在重新连接同步内容…');
    } catch (reason) {
      setState('error');
      setMessage(reason instanceof Error ? reason.message : '同步块恢复失败');
    }
  };

  const canRestore = props.editor.isEditable && !context?.publicShareToken;
  return (
    <NodeViewWrapper className="rdocs-deleted-synced-block" contentEditable={false}>
      <span>
        <Trash2 size={14} />
        <span>
          <strong>同步块已从所有引用页面删除</strong>
          <small role={state === 'error' ? 'alert' : undefined}>
            {message || '可在 30 天内整体撤销，不会覆盖删除后的其他编辑。'}
          </small>
        </span>
      </span>
      {canRestore ? (
        <button
          type="button"
          disabled={state === 'restoring' || state === 'restored'}
          onClick={() => void restore()}
        >
          <RotateCcw size={14} />
          {state === 'restoring' ? '正在恢复…' : state === 'restored' ? '已恢复' : '撤销全部删除'}
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}

export const DeletedSyncedBlock = Node.create<SyncedBlockOptions>({
  name: 'deletedSyncedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { getContext: () => null };
  },
  addAttributes() {
    return {
      syncedBlockId: { default: '' },
      deletionOperationId: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-rdocs-deleted-synced-block]',
        getAttrs: (element) => ({
          syncedBlockId: element.getAttribute('data-synced-block-id') ?? '',
          deletionOperationId: element.getAttribute('data-deletion-operation-id') ?? '',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-rdocs-deleted-synced-block': '',
        'data-synced-block-id': node.attrs.syncedBlockId,
        'data-deletion-operation-id': node.attrs.deletionOperationId,
      }),
      '已删除的同步块',
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DeletedSyncedBlockNodeView, { stopEvent: () => true });
  },
});

export function syncedBlockExtensions(getContext: () => SyncedBlockContext | null) {
  return [SyncedBlock.configure({ getContext }), DeletedSyncedBlock.configure({ getContext })];
}
