import { mergeAttributes, Node } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Bookmark, Code2, ExternalLink, ListTree, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { attachmentEditorBlocks } from './AttachmentBlocks';
import { bookmarkDialog, embedDialog, emojiDialog, promptDialog } from './dialogs';
import { sanitizeHtmlBlock } from './html-sandbox';
import { inlineReminderExtension, type InlineReminderContext } from './InlineReminder';
import {
  pageUtilityEditorBlocks,
  type BreadcrumbItem,
  type PageLinkContext,
} from './PageUtilityBlocks';
import { syncedBlockExtensions, type SyncedBlockContext } from './SyncedBlock';

export interface EmbedTarget {
  originalUrl: string;
  provider: 'CodePen' | 'CodeSandbox' | 'Figma' | 'Loom' | 'YouTube';
  src: string;
}

function urlWithDefaultProtocol(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function normalizeBookmarkUrl(value: string): string | null {
  return urlWithDefaultProtocol(value)?.toString() ?? null;
}

function youtubeVideoId(url: URL): string | null {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  let candidate = '';
  if (hostname === 'youtu.be') candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') candidate = url.searchParams.get('v') ?? '';
    else candidate = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] ?? '';
  }
  return /^[A-Za-z0-9_-]{6,20}$/.test(candidate) ? candidate : null;
}

export function normalizeEmbedUrl(value: string): EmbedTarget | null {
  const url = urlWithDefaultProtocol(value);
  if (!url || url.protocol !== 'https:') return null;
  const originalUrl = url.toString();
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  const videoId = youtubeVideoId(url);
  if (videoId) {
    return {
      originalUrl,
      provider: 'YouTube',
      src: `https://www.youtube-nocookie.com/embed/${videoId}`,
    };
  }

  if (hostname === 'figma.com' && /^\/(?:design|file|board|proto)\//.test(url.pathname)) {
    return {
      originalUrl,
      provider: 'Figma',
      src: `https://www.figma.com/embed?embed_host=rdocs&url=${encodeURIComponent(originalUrl)}`,
    };
  }

  if (hostname === 'loom.com') {
    const loomId = url.pathname.match(/^\/(?:share|embed)\/([A-Za-z0-9]+)$/)?.[1];
    if (loomId) {
      return {
        originalUrl,
        provider: 'Loom',
        src: `https://www.loom.com/embed/${loomId}`,
      };
    }
  }

  if (hostname === 'codepen.io') {
    const match = url.pathname.match(/^\/([^/]+)\/(?:pen|embed)\/([^/?#]+)/);
    if (match?.[1] && match[2]) {
      return {
        originalUrl,
        provider: 'CodePen',
        src: `https://codepen.io/${encodeURIComponent(match[1])}/embed/${encodeURIComponent(match[2])}?default-tab=result`,
      };
    }
  }

  if (hostname === 'codesandbox.io') {
    const sandboxId = url.pathname.match(/^\/(?:s|embed)\/([^/?#]+)/)?.[1];
    if (sandboxId) {
      return {
        originalUrl,
        provider: 'CodeSandbox',
        src: `https://codesandbox.io/embed/${encodeURIComponent(sandboxId)}`,
      };
    }
  }

  return null;
}

function promptForBookmark(props: NodeViewProps): void {
  void bookmarkDialog({
    defaultUrl: String(props.node.attrs.url ?? ''),
    defaultTitle: String(props.node.attrs.title ?? ''),
    normalize: normalizeBookmarkUrl,
  }).then((bookmark) => {
    if (!bookmark) return;
    props.updateAttributes({ url: bookmark.url, title: bookmark.title });
  });
}

function BookmarkNodeView(props: NodeViewProps) {
  const url = normalizeBookmarkUrl(String(props.node.attrs.url ?? ''));
  const title = String(props.node.attrs.title ?? '').trim() || url || '无效书签';
  const hostname = useMemo(() => {
    try {
      return url ? new URL(url).hostname : '';
    } catch {
      return '';
    }
  }, [url]);

  return (
    <NodeViewWrapper className="rdocs-bookmark" contentEditable={false} data-drag-handle>
      <a href={url ?? '#'} target="_blank" rel="noreferrer noopener">
        <span className="rdocs-bookmark-icon">
          <Bookmark size={17} />
        </span>
        <span>
          <strong>{title}</strong>
          <small>{hostname || '链接不可用'}</small>
        </span>
        <ExternalLink size={14} />
      </a>
      {props.editor.isEditable ? (
        <span className="rdocs-node-actions">
          <button type="button" title="编辑书签" onClick={() => promptForBookmark(props)}>
            <Pencil size={13} />
          </button>
          <button type="button" title="删除书签" onClick={props.deleteNode}>
            <Trash2 size={13} />
          </button>
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

function EmbedNodeView(props: NodeViewProps) {
  const source = String(props.node.attrs.originalUrl ?? props.node.attrs.src ?? '');
  const normalized = normalizeEmbedUrl(source);

  const edit = () => {
    void embedDialog({ defaultUrl: source, normalize: normalizeEmbedUrl }).then((target) => {
      if (target) props.updateAttributes(target);
    });
  };

  return (
    <NodeViewWrapper className="rdocs-embed" contentEditable={false} data-drag-handle>
      <div className="rdocs-embed-header">
        <span>{normalized?.provider ?? '嵌入内容'}</span>
        {props.editor.isEditable ? (
          <span className="rdocs-node-actions">
            <button type="button" title="编辑嵌入" onClick={edit}>
              <Pencil size={13} />
            </button>
            <button type="button" title="删除嵌入" onClick={props.deleteNode}>
              <Trash2 size={13} />
            </button>
          </span>
        ) : null}
      </div>
      {normalized ? (
        <iframe
          src={normalized.src}
          title={`${normalized.provider} 嵌入内容`}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
          allow="fullscreen; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <a href={normalizeBookmarkUrl(source) ?? '#'} target="_blank" rel="noreferrer noopener">
          嵌入地址不可用，点击打开原链接
        </a>
      )}
    </NodeViewWrapper>
  );
}

interface HeadingAnchor {
  level: number;
  position: number;
  text: string;
}

function TableOfContentsNodeView({ editor }: NodeViewProps) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1);
    editor.on('update', refresh);
    return () => {
      editor.off('update', refresh);
    };
  }, [editor]);

  const headings: HeadingAnchor[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'heading') {
      headings.push({
        level: Math.min(3, Math.max(1, Number(node.attrs.level) || 1)),
        position,
        text: node.textContent.trim() || '无标题',
      });
    }
  });

  return (
    <NodeViewWrapper className="rdocs-table-of-contents" contentEditable={false}>
      <div className="rdocs-toc-title">
        <ListTree size={15} /> 目录
      </div>
      {headings.length ? (
        <nav aria-label="页面目录">
          {headings.map((heading) => (
            <button
              key={`${heading.position}-${heading.text}`}
              type="button"
              style={{ '--toc-depth': heading.level - 1 } as CSSProperties}
              onClick={() =>
                editor
                  .chain()
                  .setTextSelection(Math.min(heading.position + 1, editor.state.doc.content.size))
                  .scrollIntoView()
                  .run()
              }
            >
              {heading.text}
            </button>
          ))}
        </nav>
      ) : (
        <small>添加标题后，目录会自动更新。</small>
      )}
    </NodeViewWrapper>
  );
}

const CALLOUT_TONES = [
  { id: 'gray', label: '灰' },
  { id: 'blue', label: '蓝' },
  { id: 'yellow', label: '黄' },
  { id: 'red', label: '红' },
  { id: 'green', label: '绿' },
  { id: 'purple', label: '紫' },
] as const;

function CalloutNodeView(props: NodeViewProps) {
  const icon = String(props.node.attrs.icon ?? '💡');
  const tone = String(props.node.attrs.tone ?? 'gray');

  return (
    <NodeViewWrapper as="aside" className="rdocs-callout" data-rdocs-callout="" data-tone={tone}>
      {props.editor.isEditable ? (
        <button
          type="button"
          className="rdocs-callout-icon"
          data-callout-icon=""
          title="更换图标"
          onClick={() => {
            void emojiDialog({
              title: '提示块图标',
              defaultValue: icon,
              allowEmpty: false,
            }).then((next) => {
              if (next) props.updateAttributes({ icon: next });
            });
          }}
        >
          {icon}
        </button>
      ) : (
        <span className="rdocs-callout-icon" data-callout-icon="">
          {icon}
        </span>
      )}
      <div data-callout-content="">
        {props.editor.isEditable ? (
          <div className="rdocs-callout-tones" contentEditable={false}>
            {CALLOUT_TONES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={tone === option.id ? 'active' : undefined}
                data-tone={option.id}
                title={`${option.label}色背景`}
                onClick={() => props.updateAttributes({ tone: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}

export const CalloutBlock = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      icon: { default: '💡' },
      tone: {
        default: 'gray',
        parseHTML: (element) => element.getAttribute('data-tone') || 'gray',
      },
    };
  },
  parseHTML() {
    return [{ tag: 'aside[data-rdocs-callout]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, {
        'data-rdocs-callout': '',
        'data-tone': node.attrs.tone,
      }),
      ['span', { 'data-callout-icon': '', contenteditable: 'false' }, String(node.attrs.icon)],
      ['div', { 'data-callout-content': '' }, 0],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },
});

export const BookmarkBlock = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      url: { default: '' },
      title: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-rdocs-bookmark]',
        getAttrs: (element) => ({
          title: element.textContent ?? '',
          url: element.getAttribute('href') ?? '',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const url = normalizeBookmarkUrl(String(node.attrs.url ?? '')) ?? '#';
    const title = String(node.attrs.title ?? '').trim() || url;
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-rdocs-bookmark': '',
        href: url,
        rel: 'noreferrer noopener',
        target: '_blank',
      }),
      title,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(BookmarkNodeView);
  },
});

export const EmbedBlock = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      originalUrl: { default: '' },
      provider: { default: '' },
      src: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-rdocs-embed]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const source = String(node.attrs.originalUrl ?? node.attrs.src ?? '');
    const target = normalizeEmbedUrl(source);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-original-url': target?.originalUrl ?? source,
        'data-provider': target?.provider ?? '',
        'data-rdocs-embed': '',
        'data-src': target?.src ?? '',
      }),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedNodeView);
  },
});

export const TableOfContentsBlock = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'nav[data-rdocs-table-of-contents]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-rdocs-table-of-contents': '' }), '目录'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableOfContentsNodeView);
  },
});

export const ColumnBlock = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  parseHTML() {
    return [{ tag: 'section[data-rdocs-column]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['section', mergeAttributes(HTMLAttributes, { 'data-rdocs-column': '' }), 0];
  },
});

export const ColumnsBlock = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,4}',
  isolating: true,
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-rdocs-columns]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-rdocs-columns': '' }), 0];
  },
});

export const MentionInline = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'user' },
      label: { default: '' },
      mentionId: { default: '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-rdocs-mention]',
        getAttrs: (element) => ({
          kind: element.getAttribute('data-kind') ?? 'user',
          label: element.getAttribute('data-label') ?? '',
          mentionId: element.getAttribute('data-mention-id') ?? '',
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-kind': node.attrs.kind,
        'data-label': node.attrs.label,
        'data-mention-id': node.attrs.mentionId,
        'data-rdocs-mention': '',
      }),
      `@${String(node.attrs.label ?? '')}`,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(function MentionNodeView(props: NodeViewProps) {
      return (
        <NodeViewWrapper as="span" className="rdocs-mention" contentEditable={false}>
          @{String(props.node.attrs.label ?? '')}
        </NodeViewWrapper>
      );
    });
  },
});

export const HtmlSandboxBlock = Node.create({
  name: 'htmlSandbox',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { html: { default: '<p>自定义 HTML</p>' } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-rdocs-html]',
        getAttrs: (element) => ({ html: element.getAttribute('data-html') ?? '' }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-html': node.attrs.html,
        'data-rdocs-html': '',
      }),
      'HTML',
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(function HtmlSandboxNodeView(props: NodeViewProps) {
      const html = sanitizeHtmlBlock(String(props.node.attrs.html ?? ''));
      return (
        <NodeViewWrapper className="rdocs-html-sandbox" contentEditable={false} data-drag-handle>
          <header>
            <span>
              <Code2 size={13} /> HTML 块
            </span>
            {props.editor.isEditable ? (
              <button
                type="button"
                title="编辑 HTML"
                onClick={() => {
                  void promptDialog({
                    title: 'HTML 块',
                    message: '在沙箱 iframe 中运行。脚本不能访问页面。',
                    label: 'HTML',
                    defaultValue: html,
                    multiline: true,
                  }).then((next) => {
                    if (next !== null) props.updateAttributes({ html: sanitizeHtmlBlock(next) });
                  });
                }}
              >
                <Pencil size={13} />
              </button>
            ) : null}
          </header>
          <iframe
            sandbox="allow-scripts"
            srcDoc={html}
            title="HTML 沙箱"
            referrerPolicy="no-referrer"
          />
        </NodeViewWrapper>
      );
    });
  },
});

export function createRdocsEditorBlocks(
  getBreadcrumbItems: () => readonly BreadcrumbItem[] = () => [],
  getSyncedBlockContext: () => SyncedBlockContext | null = () => null,
  getPageLinkContext: () => PageLinkContext | null = () => null,
  getInlineReminderContext: () => InlineReminderContext | null = () => null,
) {
  return [
    MentionInline,
    HtmlSandboxBlock,
    CalloutBlock,
    BookmarkBlock,
    EmbedBlock,
    TableOfContentsBlock,
    ColumnsBlock,
    ColumnBlock,
    inlineReminderExtension(getInlineReminderContext),
    ...attachmentEditorBlocks,
    ...pageUtilityEditorBlocks(getBreadcrumbItems, getPageLinkContext),
    ...syncedBlockExtensions(getSyncedBlockContext),
  ];
}

export const rdocsEditorBlocks = createRdocsEditorBlocks();
