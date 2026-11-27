import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Lock, Table2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import type { DatabaseSnapshot } from '@rdocs/shared';

import { getDatabase } from './api';
import { navigateToPage } from './navigation';

const DatabaseCanvas = lazy(() =>
  import('./DatabaseCanvas').then((module) => ({ default: module.DatabaseCanvas })),
);

export interface DatabaseBlockContext {
  actorId: string;
  /** Anonymous share and site visitors cannot read databases. */
  publicView: boolean;
}

interface DatabaseBlockOptions {
  getContext: () => DatabaseBlockContext | null;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: DatabaseSnapshot }
  | { status: 'error'; message: string };

function DatabaseBlockView(props: NodeViewProps) {
  const options = props.extension.options as DatabaseBlockOptions;
  const context = options.getContext();
  const databaseId = String(props.node.attrs.databaseId ?? '');
  const title = String(props.node.attrs.title ?? '') || '数据库';
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!databaseId || context?.publicView) return;
    let active = true;
    setState({ status: 'loading' });
    getDatabase(databaseId)
      .then((snapshot) => active && setState({ status: 'ready', snapshot }))
      .catch(
        (reason: unknown) =>
          active &&
          setState({
            status: 'error',
            message: reason instanceof Error ? reason.message : '无法打开数据库',
          }),
      );
    return () => {
      active = false;
    };
  }, [context?.publicView, databaseId]);

  // Keep the document's fallback title in step for exports and search.
  const loadedTitle = state.status === 'ready' ? state.snapshot.database.title : null;
  useEffect(() => {
    if (!loadedTitle || loadedTitle === props.node.attrs.title || !props.editor.isEditable) return;
    const position = props.getPos();
    if (typeof position !== 'number') return;
    props.editor.view.dispatch(
      props.editor.state.tr
        .setNodeAttribute(position, 'title', loadedTitle)
        .setMeta('addToHistory', false),
    );
  }, [loadedTitle, props]);

  let body;
  if (context?.publicView) {
    body = (
      <p className="rdocs-database-block-state">
        <Lock size={15} /> 「{title}」仅工作区成员可见
      </p>
    );
  } else if (state.status === 'loading') {
    body = (
      <p className="rdocs-database-block-state">
        <Table2 size={15} /> 正在打开「{title}」…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <p className="rdocs-database-block-state">
        <Lock size={15} /> 「{title}」不可用：{state.message}
      </p>
    );
  } else {
    const snapshot = state.snapshot;
    body = (
      <Suspense
        fallback={
          <p className="rdocs-database-block-state">
            <Table2 size={15} /> 正在打开「{title}」…
          </p>
        }
      >
        <DatabaseCanvas
          key={snapshot.database.id}
          initialSnapshot={snapshot}
          canEdit={snapshot.access?.canEdit ?? false}
          actorId={context?.actorId ?? ''}
          embedded={{ onOpenFullPage: () => navigateToPage(snapshot.database.pageId) }}
        />
      </Suspense>
    );
  }

  return (
    <NodeViewWrapper
      className={`rdocs-database-block${props.selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-database-id={databaseId}
    >
      {body}
    </NodeViewWrapper>
  );
}

/** A database shown and edited in place inside a document (Notion's inline database). */
export const DatabaseBlock = Node.create<DatabaseBlockOptions>({
  name: 'databaseBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { getContext: () => null };
  },
  addAttributes() {
    return {
      databaseId: { default: '' },
      title: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-rdocs-database]',
        getAttrs: (element) => ({
          databaseId: element.getAttribute('data-database-id') ?? '',
          title: element.getAttribute('data-title') ?? '',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-rdocs-database': '',
        'data-database-id': node.attrs.databaseId,
        'data-title': node.attrs.title,
      }),
      node.attrs.title || '数据库',
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(DatabaseBlockView, {
      // Everything inside belongs to the database UI, not the text editor.
      stopEvent: ({ event }) =>
        event.type !== 'drop' && event.type !== 'dragover' && event.type !== 'dragenter',
    });
  },
});

export function databaseBlockExtension(getContext: () => DatabaseBlockContext | null) {
  return DatabaseBlock.configure({ getContext });
}
