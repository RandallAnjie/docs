import { mergeAttributes, Node } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { ChevronRight, ExternalLink, FileText, Pencil, Trash2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PageLinkPreview } from '@rdocs/shared';

import { markdownToEditorContent } from './ai-markdown';
import { getPageLinkPreview } from './api';
import { pageButtonDialog } from './dialogs';

export interface BreadcrumbItem {
  id: string;
  title: string;
}

interface BreadcrumbBlockOptions {
  getItems: () => readonly BreadcrumbItem[];
}

export interface PageLinkContext {
  containerPageId: string;
  publicShareToken?: string;
}

interface PageLinkBlockOptions {
  getContext: () => PageLinkContext | null;
}

export type PageButtonAction = 'insertText' | 'openUrl' | 'insertTemplate';

export function normalizePageButtonUrl(value: string): string | null {
  try {
    const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function buttonInsertionContent(payload: string) {
  return payload
    .slice(0, 10_000)
    .split('\n')
    .slice(0, 100)
    .map((text) => ({
      type: 'paragraph',
      ...(text ? { content: [{ type: 'text', text }] } : {}),
    }));
}

function BreadcrumbNodeView(props: NodeViewProps) {
  const [, setVersion] = useState(0);
  const options = props.extension.options as BreadcrumbBlockOptions;

  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1);
    props.editor.view.dom.addEventListener('rdocs:breadcrumb-refresh', refresh);
    return () => props.editor.view.dom.removeEventListener('rdocs:breadcrumb-refresh', refresh);
  }, [props.editor]);

  const items = options.getItems();
  return (
    <NodeViewWrapper className="rdocs-breadcrumb-block" contentEditable={false}>
      <nav aria-label="页面面包屑">
        {items.map((item, index) => (
          <span key={item.id}>
            {index ? <ChevronRight size={13} aria-hidden="true" /> : null}
            {index === items.length - 1 ? (
              <strong>{item.title || '无标题'}</strong>
            ) : (
              <a href={`/p/${encodeURIComponent(item.id)}`}>{item.title || '无标题'}</a>
            )}
          </span>
        ))}
      </nav>
      {props.editor.isEditable ? (
        <button type="button" title="删除面包屑" onClick={props.deleteNode}>
          <Trash2 size={13} />
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}

function editPageButton(props: NodeViewProps) {
  void pageButtonDialog({
    defaultAction: String(props.node.attrs.action ?? 'insertText') as PageButtonAction,
    defaultLabel: String(props.node.attrs.label ?? '新按钮'),
    defaultPayload: String(props.node.attrs.payload ?? ''),
    normalizeUrl: normalizePageButtonUrl,
  }).then((button) => {
    if (button) props.updateAttributes(button);
  });
}

function PageButtonNodeView(props: NodeViewProps) {
  const action = String(props.node.attrs.action ?? 'insertText') as PageButtonAction;
  const label = String(props.node.attrs.label ?? '新按钮');
  const payload = String(props.node.attrs.payload ?? '');
  const disabled = action === 'insertText' && !props.editor.isEditable;

  const run = () => {
    if (action === 'openUrl') {
      const url = normalizePageButtonUrl(payload);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!props.editor.isEditable) return;
    const position = typeof props.getPos === 'function' ? props.getPos() : undefined;
    if (typeof position !== 'number') return;
    const content =
      action === 'insertTemplate'
        ? markdownToEditorContent(payload)
        : buttonInsertionContent(payload);
    props.editor
      .chain()
      .focus()
      .insertContentAt(position + props.node.nodeSize, content)
      .run();
  };

  return (
    <NodeViewWrapper className="rdocs-page-button-block" contentEditable={false} data-drag-handle>
      <button type="button" className="rdocs-page-button" onClick={run} disabled={disabled}>
        <Zap size={15} /> {label}
        {action === 'openUrl' ? <ExternalLink size={13} /> : null}
      </button>
      {props.editor.isEditable ? (
        <span className="rdocs-node-actions">
          <button type="button" title="编辑按钮" onClick={() => editPageButton(props)}>
            <Pencil size={13} />
          </button>
          <button type="button" title="删除按钮" onClick={props.deleteNode}>
            <Trash2 size={13} />
          </button>
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

function PageLinkNodeView(props: NodeViewProps) {
  const pageId = String(props.node.attrs.pageId ?? '');
  const fallbackTitle = String(props.node.attrs.title ?? '').trim() || '关联页面';
  const options = props.extension.options as PageLinkBlockOptions;
  const context = options.getContext();
  const [preview, setPreview] = useState<PageLinkPreview | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!context?.containerPageId || !pageId || context.publicShareToken) return;
    let active = true;
    setUnavailable(false);
    const load = () =>
      getPageLinkPreview(context.containerPageId, pageId)
        .then((result) => {
          if (!active) return;
          setPreview(result.preview);
          setUnavailable(false);
        })
        .catch(() => {
          if (active) setUnavailable(true);
        });
    void load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [context?.containerPageId, context?.publicShareToken, pageId]);

  return (
    <NodeViewWrapper className="rdocs-page-link-block" contentEditable={false} data-drag-handle>
      <a href={`/p/${encodeURIComponent(pageId)}`}>
        <span className="rdocs-page-link-icon">{preview?.page.icon || <FileText size={17} />}</span>
        <span>
          <strong>
            {unavailable ? '无权查看或页面已删除' : (preview?.page.title ?? fallbackTitle)}
          </strong>
          <small>
            {unavailable
              ? '链接内容不可见'
              : preview
                ? `${preview.spaceName}${preview.snippet ? ` · ${preview.snippet}` : ''}`
                : context?.publicShareToken
                  ? 'Rdocs 页面'
                  : '正在读取页面预览…'}
          </small>
        </span>
        <ChevronRight size={15} />
      </a>
      {props.editor.isEditable ? (
        <button type="button" title="删除页面链接" onClick={props.deleteNode}>
          <Trash2 size={13} />
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}

export const BreadcrumbBlock = Node.create<BreadcrumbBlockOptions>({
  name: 'breadcrumb',
  group: 'block',
  atom: true,
  selectable: true,
  addOptions() {
    return { getItems: () => [] };
  },
  parseHTML() {
    return [{ tag: 'nav[data-rdocs-breadcrumb]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-rdocs-breadcrumb': '' }), '面包屑'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(BreadcrumbNodeView);
  },
});

export const PageButtonBlock = Node.create({
  name: 'pageButton',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      action: { default: 'insertText' },
      label: { default: '新按钮' },
      payload: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'button[data-rdocs-page-button]',
        getAttrs: (element) => ({
          action: element.getAttribute('data-action') === 'openUrl' ? 'openUrl' : 'insertText',
          label: element.textContent?.trim() || '新按钮',
          payload: element.getAttribute('data-payload') ?? '',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'button',
      mergeAttributes(HTMLAttributes, {
        'data-action': node.attrs.action,
        'data-payload': node.attrs.payload,
        'data-rdocs-page-button': '',
        type: 'button',
      }),
      String(node.attrs.label ?? '新按钮'),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(PageButtonNodeView);
  },
});

export const PageLinkBlock = Node.create<PageLinkBlockOptions>({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { getContext: () => null };
  },
  addAttributes() {
    return {
      pageId: { default: '' },
      title: { default: '关联页面' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-rdocs-page-link]',
        getAttrs: (element) => ({
          pageId: element.getAttribute('data-page-id') ?? '',
          title: element.textContent?.trim() || '关联页面',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-page-id': node.attrs.pageId,
        'data-rdocs-page-link': '',
        href: `/p/${encodeURIComponent(String(node.attrs.pageId ?? ''))}`,
      }),
      String(node.attrs.title ?? '关联页面'),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkNodeView);
  },
});

export function pageUtilityEditorBlocks(
  getItems: () => readonly BreadcrumbItem[] = () => [],
  getPageLinkContext: () => PageLinkContext | null = () => null,
) {
  return [
    BreadcrumbBlock.configure({ getItems }),
    PageButtonBlock,
    PageLinkBlock.configure({ getContext: getPageLinkContext }),
  ];
}
