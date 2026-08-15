import { mergeAttributes, Node } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Bookmark, ExternalLink, ListTree, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

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
  const currentUrl = String(props.node.attrs.url ?? '');
  const nextUrl = window.prompt('编辑书签地址', currentUrl);
  if (nextUrl === null) return;
  const normalized = normalizeBookmarkUrl(nextUrl);
  if (!normalized) {
    window.alert('请输入有效的 HTTP(S) 地址');
    return;
  }
  const currentTitle = String(props.node.attrs.title ?? '');
  const nextTitle = window.prompt('书签标题', currentTitle) ?? currentTitle;
  props.updateAttributes({ url: normalized, title: nextTitle.trim() || normalized });
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
    const nextUrl = window.prompt(
      '编辑嵌入地址（支持 YouTube、Figma、Loom、CodePen、CodeSandbox）',
      source,
    );
    if (nextUrl === null) return;
    const target = normalizeEmbedUrl(nextUrl);
    if (!target) {
      window.alert('暂不支持这个嵌入地址，或地址不是 HTTPS');
      return;
    }
    props.updateAttributes(target);
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

export const rdocsEditorBlocks = [CalloutBlock, BookmarkBlock, EmbedBlock, TableOfContentsBlock];
