import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  FilePlus2,
  FileText,
  Heading1,
  Heading2,
  Italic,
  KeyRound,
  Link2,
  List,
  ListOrdered,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Quote,
  Search,
  Share2,
  Sparkles,
  Star,
  Users,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import type { AuthSessionResponse, AuthUserSummary, PageSummary } from '@rdocs/shared';

import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  createPage,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  getAuthSession,
  getCollabTicket,
  getPage,
  listPages,
  logout,
  updatePageTitle,
} from './api';
import { HttpCollaborationTransport } from './http-collaboration';
import { getLocalIdentity, type LocalIdentity } from './identity';
import { ancestorPageIds, buildPageTree, type PageTreeNode } from './page-tree';
import { RevisionPanel } from './RevisionPanel';

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
  const localIdentity = useMemo(getLocalIdentity, []);
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    setSessionError(null);
    try {
      setSession(await getAuthSession());
    } catch (reason) {
      setSession(null);
      setSessionError(reason instanceof Error ? reason.message : '无法检查登录状态');
      throw reason;
    }
  }, []);

  useEffect(() => {
    void refreshSession().catch(() => undefined);
  }, [refreshSession]);

  useEffect(() => {
    const handleAuthRequired = () => void refreshSession().catch(() => undefined);
    window.addEventListener('rdocs:auth-required', handleAuthRequired);
    return () => window.removeEventListener('rdocs:auth-required', handleAuthRequired);
  }, [refreshSession]);

  const signOut = useCallback(async () => {
    try {
      await logout();
      await refreshSession();
      window.location.assign('/');
    } catch (reason) {
      setSession(null);
      setSessionError(reason instanceof Error ? reason.message : '无法退出当前会话');
    }
  }, [refreshSession]);

  if (!session) {
    return sessionError ? (
      <AuthLoadFailure message={sessionError} onRetry={refreshSession} />
    ) : (
      <LoadingScreen message="正在检查设备密钥…" />
    );
  }
  if (session.mode === 'passkey' && !session.authenticated) {
    return <PasskeyGate session={session} onAuthenticated={refreshSession} />;
  }

  const identity = session.user ? identityFromUser(session.user) : localIdentity;

  if (!pageId) {
    return (
      <Welcome
        identity={identity}
        authenticated={session.authenticated}
        onLogout={session.authenticated ? signOut : undefined}
      />
    );
  }
  return (
    <Workspace
      pageId={pageId}
      identity={identity}
      onLogout={session.authenticated ? signOut : undefined}
    />
  );
}

function passkeyErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === 'NotAllowedError' || reason.name === 'AbortError') {
      return '设备验证已取消或超时，请再试一次。';
    }
    if (reason.name === 'InvalidStateError') return '这把设备密钥已经登记过了。';
    return reason.message;
  }
  return '设备密钥操作失败，请重试。';
}

function PasskeyGate({
  session,
  onAuthenticated,
}: {
  session: AuthSessionResponse;
  onAuthenticated: () => Promise<void>;
}) {
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [enrollmentSecret, setEnrollmentSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();
  const originMatches =
    !session.expectedOrigin || window.location.origin === session.expectedOrigin;

  const authenticate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await beginPasskeyAuthentication();
      const response = await startAuthentication({ optionsJSON: options });
      await finishPasskeyAuthentication(challengeId, response);
      await onAuthenticated();
    } catch (reason) {
      setError(passkeyErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { challengeId, options } = await beginPasskeyRegistration({
        email,
        displayName,
        enrollmentSecret,
      });
      const response = await startRegistration({ optionsJSON: options });
      await finishPasskeyRegistration(challengeId, response);
      await onAuthenticated();
    } catch (reason) {
      setError(passkeyErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  let unavailable: ReactNode = null;
  if (!session.passkeyConfigured) {
    unavailable = <p className="auth-warning">管理员尚未配置 Rdocs 的设备密钥域名和登记密钥。</p>;
  } else if (!originMatches) {
    unavailable = (
      <p className="auth-warning">
        设备密钥只在正式域名生效。请前往{' '}
        <a href={session.expectedOrigin ?? '/'}>{session.expectedOrigin}</a>。
      </p>
    );
  } else if (!supported) {
    unavailable = <p className="auth-warning">当前浏览器不支持 WebAuthn 设备密钥。</p>;
  }

  return (
    <main className="auth-shell">
      <nav className="auth-nav">
        <Brand />
        <span>Passkey</span>
      </nav>
      <section className="auth-card">
        <div className="auth-key-mark">
          <KeyRound size={24} />
        </div>
        <span className="auth-eyebrow">Rdocs 设备密钥</span>
        <h1>{registering ? '登记这台设备' : '欢迎回来'}</h1>
        <p>
          {registering
            ? '设备会在本地生成私钥；Rdocs 只保存公钥，无法读取你的生物识别数据。'
            : '使用系统生物识别、PIN、手机或安全密钥登录，无需密码。'}
        </p>

        {unavailable ? (
          unavailable
        ) : registering ? (
          <form className="auth-form" onSubmit={(event) => void register(event)}>
            <label>
              显示名称
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                maxLength={80}
                required
              />
            </label>
            <label>
              邮箱（仅用于账号标识）
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
                required
              />
            </label>
            <label>
              管理员设备登记码
              <input
                type="password"
                value={enrollmentSecret}
                onChange={(event) => setEnrollmentSecret(event.target.value)}
                autoComplete="one-time-code"
                required
              />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              <KeyRound size={17} />
              {busy ? '正在验证设备…' : '创建设备密钥'}
            </button>
          </form>
        ) : (
          <button
            className="primary-button auth-primary"
            type="button"
            onClick={() => void authenticate()}
            disabled={busy}
          >
            <KeyRound size={17} />
            {busy ? '正在等待设备…' : '使用设备密钥登录'}
          </button>
        )}

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        {!unavailable && session.enrollmentConfigured ? (
          <button
            className="auth-switch"
            type="button"
            onClick={() => {
              setRegistering((value) => !value);
              setError(null);
            }}
            disabled={busy}
          >
            {registering ? '已有设备密钥？返回登录' : '首次使用？登记这台设备'}
          </button>
        ) : null}
        {!unavailable && !session.enrollmentConfigured ? (
          <p className="auth-enrollment-note">新设备登记未开放，已有设备密钥仍可正常登录。</p>
        ) : null}
        <small className="auth-footnote">私钥不会离开设备 · 用户验证必需 · 会话可随时撤销</small>
      </section>
    </main>
  );
}

function Welcome({
  identity,
  authenticated,
  onLogout,
}: {
  identity: LocalIdentity;
  authenticated: boolean;
  onLogout?: () => Promise<void>;
}) {
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
        <div className="welcome-identity">
          <IdentityBubble identity={identity} />
          {onLogout ? (
            <button type="button" onClick={() => void onLogout()} aria-label="退出登录">
              <LogOut size={15} />
            </button>
          ) : null}
        </div>
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
          <strong>{authenticated ? '设备密钥已验证' : '预览环境说明'}</strong>
          <span>
            {authenticated
              ? `当前以 ${identity.name} 登录，会话凭证不会暴露给页面脚本。`
              : '当前页面采用匿名访客身份，仅用于技术验证，请勿写入敏感内容。'}
          </span>
        </div>
      </section>
      <div className="welcome-orbit orbit-one" />
      <div className="welcome-orbit orbit-two" />
    </main>
  );
}

function Workspace({
  pageId,
  identity,
  onLogout,
}: {
  pageId: string;
  identity: LocalIdentity;
  onLogout?: () => Promise<void>;
}) {
  const [bootstrap, setBootstrap] = useState<{
    page: PageSummary;
    pages: PageSummary[];
    ticket: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([getPage(pageId), getCollabTicket(pageId, identity), listPages()])
      .then(([{ page }, { ticket }, { pages }]) => {
        if (active) {
          setBootstrap({
            page,
            pages: pages.some((candidate) => candidate.id === page.id) ? pages : [...pages, page],
            ticket,
          });
        }
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
      initialPages={bootstrap.pages}
      initialTicket={bootstrap.ticket}
      identity={identity}
      onLogout={onLogout}
    />
  );
}

function DocumentWorkspace({
  initialPage,
  initialPages,
  initialTicket,
  identity,
  onLogout,
}: {
  initialPage: PageSummary;
  initialPages: PageSummary[];
  initialTicket: string;
  identity: LocalIdentity;
  onLogout?: () => Promise<void>;
}) {
  const [page, setPage] = useState(initialPage);
  const [pages, setPages] = useState(initialPages);
  const [title, setTitle] = useState(page.title);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [collab, setCollab] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const [onlineCount, setOnlineCount] = useState(1);
  const [copied, setCopied] = useState(false);
  const [contextTab, setContextTab] = useState<'comments' | 'history'>('comments');
  const [collapsedPageIds, setCollapsedPageIds] = useState<ReadonlySet<string>>(new Set());
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [treeError, setTreeError] = useState<string | null>(null);
  const titleTimer = useRef<number | undefined>(undefined);
  const latestTitle = useRef(page.title);
  const savedTitle = useRef(page.title);
  const titleSaveRunning = useRef(false);
  const sidebarNavigation = useRef<HTMLElement>(null);
  const httpTransportRef = useRef<HttpCollaborationTransport | null>(null);
  const pageTree = useMemo(() => buildPageTree(pages), [pages]);

  useLayoutEffect(() => {
    const navigation = sidebarNavigation.current;
    const activeLink = navigation?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!navigation || !activeLink) return;

    const navigationBounds = navigation.getBoundingClientRect();
    const activeBounds = activeLink.getBoundingClientRect();
    if (activeBounds.top < navigationBounds.top) {
      navigation.scrollTop -= navigationBounds.top - activeBounds.top;
    } else if (activeBounds.bottom > navigationBounds.bottom) {
      navigation.scrollTop += activeBounds.bottom - navigationBounds.bottom;
    }
  }, [page.id, pages.length]);

  useEffect(() => {
    const ancestors = ancestorPageIds(page.id, pages);
    setCollapsedPageIds((current) => {
      const next = new Set([...current].filter((id) => !ancestors.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [page.id, pages]);

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
        } else if (state === 'rebased') {
          terminalError = true;
          setConnection('connecting');
          window.location.reload();
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
    httpTransportRef.current = httpTransport;
    void httpTransport.start();
    setCollab({ ydoc, provider });

    return () => {
      disposed = true;
      if (httpTransportRef.current === httpTransport) httpTransportRef.current = null;
      httpTransport.stop();
      provider.destroy();
      ydoc.destroy();
    };
  }, [identity, initialTicket, page.id]);

  const flushDocument = useCallback(async () => {
    await httpTransportRef.current?.flushNow();
  }, []);

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
          setPages((current) =>
            current.map((candidatePage) =>
              candidatePage.id === updated.id ? updated : candidatePage,
            ),
          );
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

  const createAndOpenPage = async (parentId: string | null) => {
    if (creatingUnder !== undefined) return;
    setCreatingUnder(parentId);
    setTreeError(null);
    try {
      const { page: created } = await createPage('未命名页面', parentId);
      navigateToPage(created.id);
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : '无法创建页面');
      setCreatingUnder(undefined);
    }
  };

  const togglePage = (pageId: string) => {
    setCollapsedPageIds((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
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
          <button
            onClick={() => void createAndOpenPage(null)}
            disabled={creatingUnder !== undefined}
          >
            <FilePlus2 size={16} />
            {creatingUnder === null ? '正在创建…' : '新建页面'}
          </button>
        </div>
        <nav className="sidebar-nav" ref={sidebarNavigation}>
          <div className="sidebar-section-heading">
            <p>空间</p>
            <span>{pages.length}</span>
          </div>
          <PageTree
            nodes={pageTree}
            activePageId={page.id}
            collapsedPageIds={collapsedPageIds}
            creatingUnder={creatingUnder}
            onToggle={togglePage}
            onCreateChild={(parentId) => void createAndOpenPage(parentId)}
          />
          {pageTree.length === 0 && <div className="page-tree-empty">还没有页面</div>}
          {treeError && <div className="page-tree-error">{treeError}</div>}
          <div className="sidebar-shortcuts">
            <a href="#favorites">
              <Star size={16} />
              <span>收藏</span>
            </a>
            <a href="#recent">
              <Clock3 size={16} />
              <span>最近访问</span>
            </a>
          </div>
        </nav>
        <div className="sidebar-footer">
          <IdentityBubble identity={identity} compact />
          <span>
            <strong>{identity.name}</strong>
            <small>{onLogout ? '设备密钥会话' : '匿名技术预览'}</small>
          </span>
          {onLogout ? (
            <button
              type="button"
              className="sidebar-logout"
              onClick={() => void onLogout()}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut size={16} />
            </button>
          ) : (
            <MoreHorizontal size={17} />
          )}
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
          <button
            className={contextTab === 'comments' ? 'active' : ''}
            onClick={() => setContextTab('comments')}
          >
            <MessageSquare size={16} />
            评论
          </button>
          <button
            className={contextTab === 'history' ? 'active' : ''}
            onClick={() => setContextTab('history')}
          >
            <Clock3 size={16} />
            历史
          </button>
        </div>
        {contextTab === 'comments' ? (
          <>
            <div className="context-empty">
              <div className="empty-icon">
                <MessageSquare size={21} />
              </div>
              <strong>从对话开始</strong>
              <p>选中文字即可发起评论。评论将在 Phase 2 接入。</p>
            </div>
            <div className="context-card">
              <span>实时协作</span>
              <strong>
                <Users size={16} /> {onlineCount} 人在线
              </strong>
              <small>内容由 Yjs 与 Durable Object 实时同步</small>
            </div>
          </>
        ) : (
          <RevisionPanel pageId={page.id} flushDocument={flushDocument} />
        )}
      </aside>
    </div>
  );
}

function PageTree({
  nodes,
  activePageId,
  collapsedPageIds,
  creatingUnder,
  onToggle,
  onCreateChild,
  depth = 0,
}: {
  nodes: PageTreeNode[];
  activePageId: string;
  collapsedPageIds: ReadonlySet<string>;
  creatingUnder: string | null | undefined;
  onToggle: (pageId: string) => void;
  onCreateChild: (parentId: string) => void;
  depth?: number;
}) {
  return (
    <ul className={depth === 0 ? 'page-tree' : 'page-tree-children'}>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const collapsed = collapsedPageIds.has(node.id);
        const active = node.id === activePageId;
        return (
          <li className="page-tree-node" key={node.id}>
            <div
              className={`page-tree-row ${active ? 'active' : ''}`}
              style={{ '--tree-depth': depth } as CSSProperties}
            >
              <button
                className={`page-tree-toggle ${hasChildren ? '' : 'placeholder'}`}
                type="button"
                aria-label={
                  hasChildren ? (collapsed ? `展开${node.title}` : `收起${node.title}`) : undefined
                }
                aria-expanded={hasChildren ? !collapsed : undefined}
                disabled={!hasChildren}
                onClick={() => onToggle(node.id)}
              >
                {hasChildren &&
                  (collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />)}
              </button>
              <a
                href={`/p/${encodeURIComponent(node.id)}`}
                aria-current={active ? 'page' : undefined}
              >
                <FileText size={14} />
                <span>{node.title}</span>
              </a>
              <button
                className="page-tree-add"
                type="button"
                title={`在“${node.title}”下新建子页面`}
                aria-label={`在“${node.title}”下新建子页面`}
                disabled={creatingUnder !== undefined}
                onClick={() => onCreateChild(node.id)}
              >
                {creatingUnder === node.id ? <span className="mini-spinner" /> : <Plus size={13} />}
              </button>
            </div>
            {hasChildren && !collapsed && (
              <PageTree
                nodes={node.children}
                activePageId={activePageId}
                collapsedPageIds={collapsedPageIds}
                creatingUnder={creatingUnder}
                onToggle={onToggle}
                onCreateChild={onCreateChild}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
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

function identityFromUser(user: AuthUserSummary): LocalIdentity {
  const colors = ['#3156a3', '#b6492e', '#37805a', '#8a4da3', '#b07a17', '#317f8d'];
  let hash = 0;
  for (const character of user.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return {
    id: user.id,
    name: user.displayName,
    color: colors[hash % colors.length] ?? colors[0]!,
  };
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

function LoadingScreen({ message = '正在打开文档空间…' }: { message?: string }) {
  return (
    <div className="full-state">
      <Brand />
      <div className="loading-mark" />
      <p>{message}</p>
    </div>
  );
}

function AuthLoadFailure({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <div className="full-state">
      <Brand />
      <h1>无法确认登录状态</h1>
      <p>{message}</p>
      <button
        className="primary-button"
        type="button"
        onClick={() => void onRetry().catch(() => undefined)}
      >
        重试
      </button>
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
