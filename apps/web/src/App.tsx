import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  FilePlus2,
  FileText,
  Heading1,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Quote,
  Search,
  Share2,
  Sparkles,
  Star,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import type { PageSummary } from '@rdocs/shared';

import { createPage, getCollabTicket, getPage, updatePageTitle } from './api';
import { HttpCollaborationTransport } from './http-collaboration';
import { getLocalIdentity, type LocalIdentity } from './identity';

type ConnectionState = 'connecting' | 'connected' | 'synced' | 'disconnected' | 'error';

function currentPageId(): string | null {
  const match = window.location.pathname.match(/^\/p\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function navigateToPage(pageId: string): void {
  window.location.assign(`/p/${encodeURIComponent(pageId)}`);
}

function normalizedPageTitle(value: string): string {
  return value.trim() || '未命名页面';
}

export function App() {
  const pageId = currentPageId();
  const identity = useMemo(getLocalIdentity, []);

  if (!pageId) return <Welcome identity={identity} />;
  return <Workspace pageId={pageId} identity={identity} />;
}

function Welcome({ identity }: { identity: LocalIdentity }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setCreating(true);
    setError(null);
    try {
      const { page } = await createPage('欢迎来到 Rdocs');
      navigateToPage(page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建页面');
      setCreating(false);
    }
  };

  return (
    <main className="welcome-shell">
      <nav className="welcome-nav">
        <Brand />
        <IdentityBubble identity={identity} />
      </nav>
      <section className="welcome-content">
        <div className="eyebrow">
          <Sparkles size={15} /> Technical preview · Phase 0
        </div>
        <h1>
          把团队的想法，
          <br />
          写进同一个空间。
        </h1>
        <p>
          Rdocs 是一套面向团队的实时协作知识库。这个首发预览先验证最重要的事：
          多人同时编辑、持久保存、断线重连与服务重启恢复。
        </p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={start} disabled={creating}>
            <FilePlus2 size={18} />
            {creating ? '正在创建…' : '创建协作文档'}
          </button>
          <a className="quiet-link" href="https://github.com/RandallAnjie/docs">
            查看源码 <span aria-hidden="true">↗</span>
          </a>
        </div>
        {error && <p className="error-message">{error}</p>}
        <div className="preview-note">
          <strong>预览环境说明</strong>
          <span>当前页面采用匿名访客身份，仅用于技术验证，请勿写入敏感内容。</span>
        </div>
      </section>
      <div className="welcome-orbit orbit-one" />
      <div className="welcome-orbit orbit-two" />
    </main>
  );
}

function Workspace({ pageId, identity }: { pageId: string; identity: LocalIdentity }) {
  const [bootstrap, setBootstrap] = useState<{ page: PageSummary; ticket: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([getPage(pageId), getCollabTicket(pageId, identity)])
      .then(([{ page }, { ticket }]) => {
        if (active) setBootstrap({ page, ticket });
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '页面加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [identity, pageId]);

  if (loading) return <LoadingScreen />;
  if (!bootstrap || error) return <NotFound message={error ?? '页面不存在'} />;

  return (
    <DocumentWorkspace
      initialPage={bootstrap.page}
      initialTicket={bootstrap.ticket}
      identity={identity}
    />
  );
}

function DocumentWorkspace({
  initialPage,
  initialTicket,
  identity,
}: {
  initialPage: PageSummary;
  initialTicket: string;
  identity: LocalIdentity;
}) {
  const [page, setPage] = useState(initialPage);
  const [title, setTitle] = useState(page.title);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [collab, setCollab] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const [onlineCount, setOnlineCount] = useState(1);
  const [copied, setCopied] = useState(false);
  const titleTimer = useRef<number | undefined>(undefined);
  const latestTitle = useRef(page.title);
  const savedTitle = useRef(page.title);
  const titleSaveRunning = useRef(false);

  useEffect(() => {
    let disposed = false;
    let httpSynced = false;
    let terminalError = false;
    const ydoc = new Y.Doc();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const provider = new WebsocketProvider(
      `${protocol}//${window.location.host}/collab`,
      page.id,
      ydoc,
      {
        params: { ticket: initialTicket },
        maxBackoffTime: 2_000,
      },
    );

    provider.awareness.setLocalStateField('user', {
      name: identity.name,
      color: identity.color,
    });
    provider.on('status', ({ status }: { status: string }) => {
      if (disposed || terminalError || httpSynced) return;
      setConnection(status === 'connected' ? 'connected' : 'disconnected');
    });
    provider.on('sync', (synced: boolean) => {
      if (!disposed && !terminalError && synced) setConnection('synced');
    });
    provider.awareness.on('change', () => {
      setOnlineCount(provider.awareness.getStates().size || 1);
    });
    provider.ws?.addEventListener('error', () => {
      if (!disposed && !httpSynced && !terminalError) setConnection('disconnected');
    });

    const httpTransport = new HttpCollaborationTransport({
      pageId: page.id,
      document: ydoc,
      awareness: provider.awareness,
      ticket: initialTicket,
      renewTicket: async () => (await getCollabTicket(page.id, identity)).ticket,
      onState: (state) => {
        if (disposed) return;
        if (state === 'synced') {
          httpSynced = true;
          setConnection('synced');
        } else if (state === 'forbidden') {
          httpSynced = false;
          terminalError = true;
          setConnection('error');
        } else {
          httpSynced = false;
          if (!provider.synced) setConnection('disconnected');
        }
      },
    });
    void httpTransport.start();
    setCollab({ ydoc, provider });

    return () => {
      disposed = true;
      httpTransport.stop();
      provider.destroy();
      ydoc.destroy();
    };
  }, [identity, initialTicket, page.id]);

  const flushTitle = useCallback(async () => {
    if (titleSaveRunning.current) return;
    titleSaveRunning.current = true;
    try {
      while (normalizedPageTitle(latestTitle.current) !== savedTitle.current) {
        const candidate = normalizedPageTitle(latestTitle.current);
        try {
          const { page: updated } = await updatePageTitle(page.id, candidate);
          savedTitle.current = updated.title;
          setPage(updated);
        } catch {
          window.clearTimeout(titleTimer.current);
          titleTimer.current = window.setTimeout(() => void flushTitle(), 1_500);
          return;
        }
      }
    } finally {
      titleSaveRunning.current = false;
    }
  }, [page.id]);

  const queueTitleSave = (nextTitle: string) => {
    latestTitle.current = nextTitle;
    window.clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => void flushTitle(), 500);
  };

  useEffect(() => {
    const persistBeforeExit = () => {
      const candidate = normalizedPageTitle(latestTitle.current);
      if (candidate !== savedTitle.current) {
        void updatePageTitle(page.id, candidate, { keepalive: true });
      }
    };

    window.addEventListener('pagehide', persistBeforeExit);
    return () => {
      window.removeEventListener('pagehide', persistBeforeExit);
      window.clearTimeout(titleTimer.current);
      persistBeforeExit();
    };
  }, [page.id]);

  const share = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand compact />
          <button className="icon-button subtle" aria-label="收起侧栏">
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button className="workspace-switcher">
          <span className="workspace-avatar">R</span>
          <span>
            <strong>Rdocs</strong>
            <small>Phase 0 workspace</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="sidebar-actions">
          <button>
            <Search size={16} />
            搜索 <kbd>⌘ K</kbd>
          </button>
          <button onClick={() => void createPage().then(({ page }) => navigateToPage(page.id))}>
            <FilePlus2 size={16} />
            新建页面
          </button>
        </div>
        <nav className="sidebar-nav">
          <p>空间</p>
          <a className="active" href={`/p/${page.id}`}>
            <FileText size={16} />
            <span>{page.title}</span>
          </a>
          <a href="#favorites">
            <Star size={16} />
            <span>收藏</span>
          </a>
          <a href="#recent">
            <Clock3 size={16} />
            <span>最近访问</span>
          </a>
        </nav>
        <div className="sidebar-footer">
          <IdentityBubble identity={identity} compact />
          <span>
            <strong>{identity.name}</strong>
            <small>匿名技术预览</small>
          </span>
          <MoreHorizontal size={17} />
        </div>
      </aside>

      <main className="document-area">
        <header className="document-header">
          <div className="breadcrumbs">
            <span>Rdocs</span>
            <span>/</span>
            <span>{page.title}</span>
          </div>
          <div className="header-actions">
            <ConnectionPill state={connection} />
            <div className="avatars" title={`${onlineCount} 人在线`}>
              <span style={{ background: identity.color }}>{identityMonogram(identity)}</span>
              {onlineCount > 1 && <b>+{onlineCount - 1}</b>}
            </div>
            <button className="header-button" onClick={share}>
              {copied ? <Check size={16} /> : <Share2 size={16} />}
              {copied ? '已复制' : '分享'}
            </button>
            <button className="icon-button" aria-label="更多">
              <MoreHorizontal size={18} />
            </button>
          </div>
        </header>

        <div className="document-scroll">
          <article className="document-sheet">
            <div className="document-kicker">团队知识 / 协作原型</div>
            <input
              className="title-input"
              value={title}
              onChange={(event) => {
                const nextTitle = event.target.value;
                setTitle(nextTitle);
                queueTitleSave(nextTitle);
              }}
              onBlur={() => void flushTitle()}
              aria-label="页面标题"
            />
            {collab ? (
              <CollaborativeEditor collab={collab} identity={identity} />
            ) : (
              <div className="editor-loading">
                <div className="loading-mark" />
                <span>正在建立加密协作连接…</span>
              </div>
            )}
          </article>
        </div>
      </main>

      <aside className="context-panel">
        <div className="context-tabs">
          <button className="active">
            <MessageSquare size={16} />
            评论
          </button>
          <button>
            <Clock3 size={16} />
            历史
          </button>
        </div>
        <div className="context-empty">
          <div className="empty-icon">
            <MessageSquare size={21} />
          </div>
          <strong>从对话开始</strong>
          <p>选中文字即可发起评论。评论与历史版本将在 Phase 1 接入。</p>
        </div>
        <div className="context-card">
          <span>实时协作</span>
          <strong>
            <Users size={16} /> {onlineCount} 人在线
          </strong>
          <small>内容由 Yjs 与 Durable Object 实时同步</small>
        </div>
      </aside>
    </div>
  );
}

function CollaborativeEditor({
  collab,
  identity,
}: {
  collab: { ydoc: Y.Doc; provider: WebsocketProvider };
  identity: LocalIdentity;
}) {
  const [, rerender] = useState(0);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: collab.ydoc }),
      CollaborationCaret.configure({
        provider: collab.provider,
        user: {
          name: identity.name,
          monogram: identityMonogram(identity),
          color: identity.color,
        },
        render: renderCollaborationCaret,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'rdocs-editor',
        spellcheck: 'true',
      },
    },
    onSelectionUpdate: () => rerender((value) => value + 1),
    onTransaction: () => rerender((value) => value + 1),
  });

  if (!editor) return null;

  const tools = [
    {
      label: '正文',
      icon: <span className="text-tool">T</span>,
      action: () => editor.chain().focus().setParagraph().run(),
      active: editor.isActive('paragraph'),
    },
    {
      label: '一级标题',
      icon: <Heading1 size={16} />,
      action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      active: editor.isActive('heading', { level: 1 }),
    },
    {
      label: '二级标题',
      icon: <Heading2 size={16} />,
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      active: editor.isActive('heading', { level: 2 }),
    },
    {
      label: '粗体',
      icon: <Bold size={16} />,
      action: () => editor.chain().focus().toggleBold().run(),
      active: editor.isActive('bold'),
    },
    {
      label: '斜体',
      icon: <Italic size={16} />,
      action: () => editor.chain().focus().toggleItalic().run(),
      active: editor.isActive('italic'),
    },
    {
      label: '无序列表',
      icon: <List size={16} />,
      action: () => editor.chain().focus().toggleBulletList().run(),
      active: editor.isActive('bulletList'),
    },
    {
      label: '有序列表',
      icon: <ListOrdered size={16} />,
      action: () => editor.chain().focus().toggleOrderedList().run(),
      active: editor.isActive('orderedList'),
    },
    {
      label: '引用',
      icon: <Quote size={16} />,
      action: () => editor.chain().focus().toggleBlockquote().run(),
      active: editor.isActive('blockquote'),
    },
    {
      label: '代码',
      icon: <Code2 size={16} />,
      action: () => editor.chain().focus().toggleCodeBlock().run(),
      active: editor.isActive('codeBlock'),
    },
    {
      label: '链接',
      icon: <Link2 size={16} />,
      action: () => undefined,
      active: editor.isActive('link'),
    },
  ];

  return (
    <div className="editor-frame">
      <div className="editor-toolbar">
        {tools.map((tool, index) => (
          <button
            key={tool.label}
            className={`${tool.active ? 'active' : ''} ${[3, 5, 9].includes(index) ? 'tool-separator' : ''}`}
            onClick={tool.action}
            title={tool.label}
            type="button"
          >
            {tool.icon}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className={`brand ${compact ? 'compact' : ''}`} href="/">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <strong>Rdocs</strong>
    </a>
  );
}

function identityMonogram(identity: LocalIdentity): string {
  return identity.name.trim().slice(-2) || '访客';
}

function renderCollaborationCaret(user: Record<string, unknown>): HTMLElement {
  const name = typeof user.name === 'string' ? user.name : '协作者';
  const monogram = typeof user.monogram === 'string' ? user.monogram.slice(-2) : name.slice(-2);
  const color = typeof user.color === 'string' ? user.color : '#5f7f91';
  const caret = document.createElement('span');
  const bubble = document.createElement('span');

  caret.classList.add('collaboration-carets__caret');
  caret.style.borderColor = color;
  bubble.classList.add('collaboration-carets__label');
  bubble.style.backgroundColor = color;
  bubble.title = name;
  bubble.setAttribute('aria-label', `协作者：${name}`);
  bubble.textContent = monogram || '协';
  caret.append(bubble);
  return caret;
}

function IdentityBubble({
  identity,
  compact = false,
}: {
  identity: LocalIdentity;
  compact?: boolean;
}) {
  return (
    <span
      className={`identity-bubble ${compact ? 'compact' : ''}`}
      style={{ background: identity.color }}
      title={identity.name}
      aria-label={`当前用户：${identity.name}`}
    >
      {identityMonogram(identity)}
    </span>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const labels: Record<ConnectionState, string> = {
    connecting: '正在连接',
    connected: '正在同步',
    synced: '已同步',
    disconnected: '重新连接中',
    error: '连接异常',
  };
  return (
    <span className={`connection-pill ${state}`}>
      <i />
      {labels[state]}
    </span>
  );
}

function LoadingScreen() {
  return (
    <div className="full-state">
      <Brand />
      <div className="loading-mark" />
      <p>正在打开文档空间…</p>
    </div>
  );
}

function NotFound({ message }: { message: string }) {
  return (
    <div className="full-state">
      <Brand />
      <h1>无法打开此页面</h1>
      <p>{message}</p>
      <a className="primary-button" href="/">
        返回 Rdocs
      </a>
    </div>
  );
}
