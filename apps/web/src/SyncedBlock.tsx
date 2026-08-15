import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Copy, RefreshCw, Trash2, Unlink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import { getPublicSyncedBlockTicket, getSyncedBlockTicket } from './api';
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

  const loadTicket = useCallback(async () => {
    if (!pageId || !blockId || !identityName) throw new Error('同步块上下文不可用');
    const response = publicShareToken
      ? await getPublicSyncedBlockTicket(publicShareToken, pageId, blockId)
      : await getSyncedBlockTicket(pageId, blockId, { name: identityName });
    return {
      generation: response.generation,
      role: response.role,
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
  }, [loadTicket]);

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

  return (
    <NodeViewWrapper className="rdocs-synced-block" contentEditable={false}>
      <header>
        <span>
          <RefreshCw size={13} /> 同步块
          <i className={state} aria-live="polite">
            {state === 'synced' ? '已同步' : state === 'error' ? '无法访问' : '同步中…'}
          </i>
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
            <button
              type="button"
              title="删除当前引用"
              aria-label="删除当前引用"
              onClick={props.deleteNode}
            >
              <Trash2 size={13} />
            </button>
          </span>
        ) : null}
      </header>
      {collab && session && collab.ticket === session.ticket ? (
        <SyncedBlockEditor
          document={collab.document}
          provider={collab.provider}
          identity={{ id: identityId, name: identityName, color: identityColor }}
          editable={session.role === 'editor' && props.editor.isEditable}
          onReady={setNestedEditor}
        />
      ) : state === 'error' ? (
        <p className="rdocs-synced-block-state">需要同时具有原始页面和当前页面的访问权限。</p>
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

export function syncedBlockExtension(getContext: () => SyncedBlockContext | null) {
  return SyncedBlock.configure({ getContext });
}
