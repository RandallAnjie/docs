import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { absolutePositionToRelativePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  Bold,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderInput,
  Heading1,
  Heading2,
  Italic,
  KeyRound,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  LockKeyhole,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Quote,
  Search,
  Share2,
  Sparkles,
  Star,
  Table2,
  Trash2,
  Users,
  Upload,
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
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import type {
  AuthSessionResponse,
  AuthUserSummary,
  AttachmentSummary,
  OrganizationSummary,
  PageSummary,
  SpaceSummary,
  SpaceVisibility,
} from '@rdocs/shared';

import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  acceptInvitation,
  attachmentDownloadUrl,
  createOrganization,
  copyPage,
  createPage,
  createSpace,
  deletePage,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  exportMarkdown,
  getAuthSession,
  getCollabTicket,
  getPage,
  getPublicShare,
  listPages,
  listOrganizations,
  listSpaces,
  logout,
  importMarkdown,
  movePage,
  updateSpace,
  updatePageTitle,
} from './api';
import { HttpCollaborationTransport } from './http-collaboration';
import { AttachmentPanel } from './AttachmentPanel';
import { CommentsPanel } from './CommentsPanel';
import type { LocalIdentity } from './identity';
import { DiscoveryDialog } from './DiscoveryDialog';
import { OrganizationSettings } from './OrganizationSettings';
import { NotificationBell } from './NotificationBell';
import { PageAccessDialog } from './PageAccessDialog';
import { ancestorPageIds, buildPageTree, descendantPageIds, type PageTreeNode } from './page-tree';
import { RevisionPanel } from './RevisionPanel';
import { SpaceAccessDialog } from './SpaceAccessDialog';
import { SpaceTrashDialog } from './SpaceTrashDialog';
import { TemplateDialog } from './TemplateDialog';

type ConnectionState = 'connecting' | 'connected' | 'synced' | 'disconnected' | 'error';

interface CommentSelection {
  quotedText: string;
  anchorStart: string;
  anchorEnd: string;
}

function currentPageId(): string | null {
  const match = window.location.pathname.match(/^\/p\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function currentInvitationToken(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function currentShareToken(): string | null {
  const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function navigateToPage(pageId: string): void {
  window.location.assign(`/p/${encodeURIComponent(pageId)}`);
}

function normalizedPageTitle(value: string): string {
  return value.trim() || '未命名页面';
}

function encodeRelativePosition(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function App() {
  const pageId = currentPageId();
  const invitationToken = currentInvitationToken();
  const shareToken = currentShareToken();
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

  if (shareToken) return <SharedPage token={shareToken} />;

  if (!session) {
    return sessionError ? (
      <AuthLoadFailure message={sessionError} onRetry={refreshSession} />
    ) : (
      <LoadingScreen message="正在检查设备密钥…" />
    );
  }
  if (!session.authenticated || !session.user) {
    return (
      <PasskeyGate
        session={session}
        invitationToken={invitationToken}
        onAuthenticated={refreshSession}
      />
    );
  }

  const identity = identityFromUser(session.user);

  if (invitationToken) {
    return <InvitationAcceptance token={invitationToken} identity={identity} />;
  }

  if (!pageId) {
    return <TenantHome identity={identity} user={session.user} onLogout={signOut} />;
  }
  return <Workspace pageId={pageId} identity={identity} onLogout={signOut} />;
}

function SharedPage({ token }: { token: string }) {
  const identity = useMemo(
    () => ({ id: `share-${token.slice(0, 8)}`, name: '外部只读', color: '#6d7f73' }),
    [token],
  );
  const [shared, setShared] = useState<Awaited<ReturnType<typeof getPublicShare>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const renewTicket = useCallback(async () => (await getPublicShare(token)).ticket, [token]);

  useEffect(() => {
    let active = true;
    getPublicShare(token)
      .then((result) => active && setShared(result))
      .catch(
        (reason) => active && setError(reason instanceof Error ? reason.message : '分享页面不可用'),
      );
    return () => {
      active = false;
    };
  }, [token]);

  if (error) return <NotFound message={error} />;
  if (!shared) return <LoadingScreen message="正在打开分享页面…" />;
  return (
    <DocumentWorkspace
      initialPage={shared.page}
      initialPages={[shared.page]}
      initialTicket={shared.ticket}
      identity={identity}
      renewTicket={renewTicket}
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
  invitationToken,
  onAuthenticated,
}: {
  session: AuthSessionResponse;
  invitationToken: string | null;
  onAuthenticated: () => Promise<void>;
}) {
  const [registering, setRegistering] = useState(Boolean(invitationToken));
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
        enrollmentSecret: invitationToken ? undefined : enrollmentSecret,
        invitationToken: invitationToken ?? undefined,
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
        <h1>
          {registering ? (invitationToken ? '接受邀请并登记设备' : '登记这台设备') : '欢迎回来'}
        </h1>
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
            {!invitationToken ? (
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
            ) : null}
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
        {!unavailable && (session.enrollmentConfigured || invitationToken) ? (
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
        {!unavailable && !session.enrollmentConfigured && !invitationToken ? (
          <p className="auth-enrollment-note">新设备登记未开放，已有设备密钥仍可正常登录。</p>
        ) : null}
        <small className="auth-footnote">私钥不会离开设备 · 用户验证必需 · 会话可随时撤销</small>
      </section>
    </main>
  );
}

function InvitationAcceptance({ token, identity }: { token: string; identity: LocalIdentity }) {
  const [state, setState] = useState<'accepting' | 'accepted' | 'error'>('accepting');
  const [message, setMessage] = useState('正在确认组织邀请…');

  useEffect(() => {
    let active = true;
    acceptInvitation(token)
      .then(({ organization }) => {
        if (!active) return;
        window.localStorage.setItem('rdocs:selected-organization', organization.id);
        setState('accepted');
        setMessage(`已加入 ${organization.name}`);
      })
      .catch((reason) => {
        if (!active) return;
        setState('error');
        setMessage(reason instanceof Error ? reason.message : '无法接受此邀请');
      });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <main className="tenant-shell invitation-result">
      <nav className="tenant-nav">
        <Brand />
        <IdentityBubble identity={identity} />
      </nav>
      <section className="tenant-state-card">
        <div className="auth-key-mark">
          {state === 'accepted' ? <Check size={24} /> : <Users size={24} />}
        </div>
        <span className="auth-eyebrow">组织邀请</span>
        <h1>{state === 'accepted' ? '欢迎加入' : state === 'error' ? '邀请不可用' : '正在加入'}</h1>
        <p>{message}</p>
        {state !== 'accepting' ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => window.location.assign('/')}
          >
            进入 Rdocs
          </button>
        ) : (
          <div className="loading-mark" />
        )}
      </section>
    </main>
  );
}

function TenantHome({
  identity,
  user,
  onLogout,
}: {
  identity: LocalIdentity;
  user: AuthUserSummary;
  onLogout: () => Promise<void>;
}) {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [spaceName, setSpaceName] = useState('');
  const [spaceVisibility, setSpaceVisibility] = useState<SpaceVisibility>('organization');
  const [busy, setBusy] = useState(false);
  const [trashSpace, setTrashSpace] = useState<SpaceSummary | null>(null);
  const [accessSpace, setAccessSpace] = useState<SpaceSummary | null>(null);
  const [markdownSpaceId, setMarkdownSpaceId] = useState<string | null>(null);
  const [templateSpace, setTemplateSpace] = useState<SpaceSummary | null>(null);
  const markdownInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOrganizations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listOrganizations();
      setOrganizations(result.organizations);
      const remembered = window.localStorage.getItem('rdocs:selected-organization');
      const selected = result.organizations.some((organization) => organization.id === remembered)
        ? remembered
        : (result.organizations[0]?.id ?? null);
      setSelectedOrganizationId(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载组织');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrganizations();
  }, [loadOrganizations]);

  useEffect(() => {
    if (!selectedOrganizationId) {
      setSpaces([]);
      return;
    }
    let active = true;
    setSpacesLoading(true);
    listSpaces(selectedOrganizationId, true)
      .then(({ spaces: nextSpaces }) => {
        if (active) setSpaces(nextSpaces);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '无法加载空间');
      })
      .finally(() => {
        if (active) setSpacesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedOrganizationId]);

  const selectOrganization = (organizationId: string) => {
    window.localStorage.setItem('rdocs:selected-organization', organizationId);
    setSelectedOrganizationId(organizationId);
    setError(null);
  };

  const submitOrganization = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createOrganization({ name: organizationName });
      setOrganizations((current) => [...current, result.organization]);
      setSpaces([result.space]);
      setOrganizationName('');
      selectOrganization(result.organization.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建组织');
    } finally {
      setBusy(false);
    }
  };

  const submitSpace = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedOrganizationId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createSpace(selectedOrganizationId, {
        name: spaceName,
        visibility: spaceVisibility,
      });
      setSpaces((current) => [...current, result.space]);
      setSpaceName('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建空间');
    } finally {
      setBusy(false);
    }
  };

  const openNewPage = async (space: SpaceSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { page } = await createPage('欢迎来到 Rdocs', null, space.id);
      navigateToPage(page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建页面');
      setBusy(false);
    }
  };

  const importMarkdownFile = async (file: File | undefined) => {
    if (!file || !markdownSpaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { page } = await importMarkdown(markdownSpaceId, file);
      navigateToPage(page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法导入 Markdown');
      setBusy(false);
    } finally {
      if (markdownInput.current) markdownInput.current.value = '';
    }
  };

  const selectedOrganization = organizations.find(
    (organization) => organization.id === selectedOrganizationId,
  );
  const activeSpaces = spaces.filter((space) => space.archivedAt === null);
  const archivedSpaces = spaces.filter((space) => space.archivedAt !== null);

  const restoreSpace = async (space: SpaceSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await updateSpace(space.id, { archived: false });
      setSpaces((current) =>
        current.map((candidate) => (candidate.id === result.space.id ? result.space : candidate)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复空间');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="tenant-shell">
      <nav className="tenant-nav">
        <Brand />
        <div className="welcome-identity">
          <IdentityBubble identity={identity} />
          <button type="button" onClick={() => void onLogout()} aria-label="退出登录">
            <LogOut size={15} />
          </button>
        </div>
      </nav>
      <input
        ref={markdownInput}
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        onChange={(event) => void importMarkdownFile(event.target.files?.[0])}
      />

      <section className="tenant-hero">
        <span className="eyebrow">
          <Users size={15} /> Multi-tenant workspace
        </span>
        <h1>你好，{user.displayName}</h1>
        <p>选择一个组织和空间，继续团队的知识工作。</p>
      </section>

      {loading ? (
        <div className="tenant-state-card">
          <div className="loading-mark" />
          <p>正在加载组织…</p>
        </div>
      ) : (
        <>
          <div className="tenant-grid">
            <aside className="tenant-panel organization-panel">
              <div className="tenant-panel-heading">
                <span>你的组织</span>
                <b>{organizations.length}</b>
              </div>
              <div className="organization-list">
                {organizations.map((organization) => (
                  <button
                    key={organization.id}
                    type="button"
                    className={organization.id === selectedOrganizationId ? 'active' : ''}
                    onClick={() => selectOrganization(organization.id)}
                  >
                    <span>{organization.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>{organization.name}</strong>
                      <small>{organization.role}</small>
                    </div>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
              <form
                className="tenant-inline-form"
                onSubmit={(event) => void submitOrganization(event)}
              >
                <input
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                  placeholder="新组织名称"
                  maxLength={100}
                  required
                />
                <button type="submit" disabled={busy} aria-label="创建组织">
                  <Plus size={16} />
                </button>
              </form>
            </aside>

            <section className="tenant-panel spaces-panel">
              <div className="tenant-panel-heading">
                <div>
                  <span>{selectedOrganization?.name ?? '尚未创建组织'}</span>
                  <small>
                    {selectedOrganization ? `/${selectedOrganization.slug}` : '先创建一个组织'}
                  </small>
                </div>
                <b>{activeSpaces.length} 个空间</b>
              </div>

              {spacesLoading ? (
                <div className="tenant-empty">
                  <div className="loading-mark" />
                </div>
              ) : activeSpaces.length ? (
                <div className="space-card-grid">
                  {activeSpaces.map((space) => (
                    <article key={space.id} className="space-card">
                      <div className="space-card-icon">
                        <FileText size={19} />
                      </div>
                      <span>{space.visibility === 'restricted' ? '私密空间' : '组织空间'}</span>
                      <h2>{space.name}</h2>
                      <p>{space.role === 'space_admin' ? '空间管理员' : space.role}</p>
                      <div className="space-card-actions">
                        <button
                          type="button"
                          onClick={() => void openNewPage(space)}
                          disabled={busy}
                        >
                          新建页面 <ChevronRight size={15} />
                        </button>
                        {space.role === 'space_admin' || space.role === 'editor' ? (
                          <button type="button" onClick={() => setTemplateSpace(space)}>
                            <Sparkles size={14} /> 模板
                          </button>
                        ) : null}
                        {space.role === 'space_admin' || space.role === 'editor' ? (
                          <button
                            type="button"
                            onClick={() => {
                              setMarkdownSpaceId(space.id);
                              window.setTimeout(() => markdownInput.current?.click(), 0);
                            }}
                          >
                            <Upload size={14} /> 导入 Markdown
                          </button>
                        ) : null}
                        {space.role === 'space_admin' ? (
                          <button type="button" onClick={() => setAccessSpace(space)}>
                            <LockKeyhole size={14} /> 权限
                          </button>
                        ) : null}
                        {space.role === 'space_admin' || space.role === 'editor' ? (
                          <button type="button" onClick={() => setTrashSpace(space)}>
                            <Trash2 size={14} /> 回收站
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="tenant-empty">
                  <FileText size={24} />
                  <strong>{selectedOrganization ? '还没有可访问的空间' : '创建组织后开始'}</strong>
                  <p>空间是页面树和权限的主要边界。</p>
                </div>
              )}

              {archivedSpaces.length ? (
                <div className="archived-spaces">
                  <h3>已归档空间</h3>
                  <div className="space-card-grid">
                    {archivedSpaces.map((space) => (
                      <article key={space.id} className="space-card archived">
                        <div className="space-card-icon">
                          <ArchiveRestore size={18} />
                        </div>
                        <span>已归档</span>
                        <h2>{space.name}</h2>
                        <p>{new Date(space.archivedAt ?? 0).toLocaleString()}</p>
                        {space.role === 'space_admin' ? (
                          <div className="space-card-actions">
                            <button
                              type="button"
                              onClick={() => void restoreSpace(space)}
                              disabled={busy}
                            >
                              <ArchiveRestore size={14} /> 恢复空间
                            </button>
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedOrganization ? (
                <form className="space-create-form" onSubmit={(event) => void submitSpace(event)}>
                  <input
                    value={spaceName}
                    onChange={(event) => setSpaceName(event.target.value)}
                    placeholder="新空间名称"
                    maxLength={100}
                    required
                  />
                  <select
                    value={spaceVisibility}
                    onChange={(event) => setSpaceVisibility(event.target.value as SpaceVisibility)}
                  >
                    <option value="organization">组织可见</option>
                    <option value="restricted">仅授权成员</option>
                  </select>
                  <button className="primary-button" type="submit" disabled={busy}>
                    <Plus size={16} /> 创建空间
                  </button>
                </form>
              ) : null}
            </section>
          </div>
          {selectedOrganization && selectedOrganization.role !== 'guest' ? (
            <OrganizationSettings
              organization={selectedOrganization}
              currentUserId={user.id}
              onOrganizationChanged={(updated) =>
                setOrganizations((current) =>
                  current.map((organization) =>
                    organization.id === updated.id ? updated : organization,
                  ),
                )
              }
            />
          ) : null}
        </>
      )}
      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
      {trashSpace ? (
        <SpaceTrashDialog space={trashSpace} onClose={() => setTrashSpace(null)} />
      ) : null}
      {accessSpace ? (
        <SpaceAccessDialog
          space={accessSpace}
          onClose={() => setAccessSpace(null)}
          onUpdated={(updated) => {
            setAccessSpace(updated);
            setSpaces((current) =>
              current.map((space) => (space.id === updated.id ? updated : space)),
            );
          }}
        />
      ) : null}
      {templateSpace ? (
        <TemplateDialog space={templateSpace} onClose={() => setTemplateSpace(null)} />
      ) : null}
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
    getPage(pageId)
      .then(async ({ page }) => {
        const [{ ticket }, { pages }] = await Promise.all([
          getCollabTicket(pageId, identity),
          listPages(page.spaceId),
        ]);
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
  renewTicket,
}: {
  initialPage: PageSummary;
  initialPages: PageSummary[];
  initialTicket: string;
  identity: LocalIdentity;
  onLogout?: () => Promise<void>;
  renewTicket?: () => Promise<string>;
}) {
  const [page, setPage] = useState(initialPage);
  const [pages, setPages] = useState(initialPages);
  const [title, setTitle] = useState(page.title);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [offlineReady, setOfflineReady] = useState(false);
  const [collab, setCollab] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const [onlineCount, setOnlineCount] = useState(1);
  const [commentSelection, setCommentSelection] = useState<CommentSelection | null>(null);
  const [copied, setCopied] = useState(false);
  const [contextTab, setContextTab] = useState<'comments' | 'history' | 'attachments'>('comments');
  const [collapsedPageIds, setCollapsedPageIds] = useState<ReadonlySet<string>>(new Set());
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [moveParentId, setMoveParentId] = useState(page.parentId ?? '');
  const [pageActionBusy, setPageActionBusy] = useState(false);
  const [pageActionError, setPageActionError] = useState<string | null>(null);
  const [discoveryTab, setDiscoveryTab] = useState<'search' | 'favorites' | 'recent' | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const titleTimer = useRef<number | undefined>(undefined);
  const latestTitle = useRef(page.title);
  const savedTitle = useRef(page.title);
  const titleSaveRunning = useRef(false);
  const sidebarNavigation = useRef<HTMLElement>(null);
  const httpTransportRef = useRef<HttpCollaborationTransport | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const pageTree = useMemo(() => buildPageTree(pages), [pages]);
  const canEdit = page.role === 'space_admin' || page.role === 'editor';
  const handleEditorReady = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
  }, []);
  const unavailableMoveTargets = useMemo(
    () => new Set([page.id, ...descendantPageIds(page.id, pages)]),
    [page.id, pages],
  );
  const siblings = useMemo(
    () => pages.filter((candidate) => candidate.parentId === page.parentId),
    [page.parentId, pages],
  );
  const siblingIndex = siblings.findIndex((candidate) => candidate.id === page.id);

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
    const openSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDiscoveryTab('search');
      }
    };
    window.addEventListener('keydown', openSearch);
    return () => window.removeEventListener('keydown', openSearch);
  }, []);

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
    setOfflineReady(false);
    const offlinePersistence = renewTicket
      ? null
      : new IndexeddbPersistence(`rdocs:${page.id}:generation:${page.currentGeneration}`, ydoc);
    if (offlinePersistence) {
      void offlinePersistence.whenSynced.then(() => {
        if (!disposed) setOfflineReady(true);
      });
    }
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
      renewTicket: async () => {
        const ticket = renewTicket
          ? await renewTicket()
          : (await getCollabTicket(page.id, identity)).ticket;
        const providerWithParams = provider as WebsocketProvider & {
          params: Record<string, string>;
        };
        providerWithParams.params.ticket = ticket;
        provider.disconnect();
        provider.connect();
        return ticket;
      },
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
      offlinePersistence?.destroy();
      ydoc.destroy();
    };
  }, [identity, initialTicket, page.currentGeneration, page.id, renewTicket]);

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
      const { page: created } = await createPage('未命名页面', parentId, page.spaceId);
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

  const submitMove = async (event: FormEvent) => {
    event.preventDefault();
    if (pageActionBusy) return;
    setPageActionBusy(true);
    setPageActionError(null);
    try {
      await flushDocument();
      await movePage(page.id, { parentId: moveParentId || null });
      window.location.reload();
    } catch (reason) {
      setPageActionError(reason instanceof Error ? reason.message : '无法移动页面');
      setPageActionBusy(false);
    }
  };

  const reorderCurrentPage = async (direction: 'up' | 'down') => {
    if (pageActionBusy || siblingIndex < 0) return;
    const beforePageId =
      direction === 'up'
        ? (siblings[siblingIndex - 1]?.id ?? null)
        : (siblings[siblingIndex + 2]?.id ?? null);
    if (
      (direction === 'up' && siblingIndex === 0) ||
      (direction === 'down' && siblingIndex === siblings.length - 1)
    )
      return;
    setPageMenuOpen(false);
    setPageActionBusy(true);
    setPageActionError(null);
    try {
      await movePage(page.id, { parentId: page.parentId, beforePageId });
      setPages((await listPages(page.spaceId)).pages);
    } catch (reason) {
      setPageActionError(reason instanceof Error ? reason.message : '无法调整页面顺序');
    } finally {
      setPageActionBusy(false);
    }
  };

  const removeCurrentPage = async () => {
    if (!window.confirm(`确定将“${page.title}”及其子页面移入回收站吗？`)) return;
    setPageActionBusy(true);
    setPageActionError(null);
    try {
      await flushDocument();
      await deletePage(page.id);
      window.location.assign('/');
    } catch (reason) {
      setPageActionError(reason instanceof Error ? reason.message : '无法删除页面');
      setPageActionBusy(false);
    }
  };

  const copyCurrentPage = async () => {
    if (pageActionBusy) return;
    setPageMenuOpen(false);
    setPageActionBusy(true);
    setPageActionError(null);
    try {
      await flushDocument();
      const { page: copied } = await copyPage(page.id);
      navigateToPage(copied.id);
    } catch (reason) {
      setPageActionError(reason instanceof Error ? reason.message : '无法复制页面');
      setPageActionBusy(false);
    }
  };

  const exportCurrentPage = async () => {
    setPageActionBusy(true);
    setPageActionError(null);
    try {
      await flushDocument();
      await exportMarkdown(page.id);
    } catch (reason) {
      setPageActionError(reason instanceof Error ? reason.message : '无法导出 Markdown');
    } finally {
      setPageActionBusy(false);
    }
  };

  const insertAttachment = (attachment: AttachmentSummary) => {
    const editor = editorRef.current;
    if (!editor) return;
    const href = attachmentDownloadUrl(attachment.id);
    if (attachment.mimeType.startsWith('image/')) {
      editor
        .chain()
        .focus()
        .setImage({ src: href, alt: attachment.originalName, title: attachment.originalName })
        .run();
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: `📎 ${attachment.originalName}`,
            marks: [
              { type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } },
            ],
          },
        ],
      })
      .run();
  };

  return (
    <div
      className={`app-shell ${renewTicket ? 'public-share' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
    >
      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand compact />
          <button
            className="icon-button subtle"
            type="button"
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-avatar">R</span>
          <span>
            <strong>Rdocs</strong>
            <small>{renewTicket ? '只读分享' : '团队知识空间'}</small>
          </span>
          <ChevronDown size={15} />
        </div>
        <div className="sidebar-actions">
          {!renewTicket ? (
            <button type="button" onClick={() => setDiscoveryTab('search')}>
              <Search size={16} />
              搜索 <kbd>⌘ K</kbd>
            </button>
          ) : null}
          {canEdit ? (
            <button
              onClick={() => void createAndOpenPage(null)}
              disabled={creatingUnder !== undefined}
            >
              <FilePlus2 size={16} />
              {creatingUnder === null ? '正在创建…' : '新建页面'}
            </button>
          ) : null}
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
            canCreate={canEdit}
          />
          {pageTree.length === 0 && <div className="page-tree-empty">还没有页面</div>}
          {treeError && <div className="page-tree-error">{treeError}</div>}
          <div className="sidebar-shortcuts">
            <button type="button" onClick={() => setDiscoveryTab('favorites')}>
              <Star size={16} />
              <span>收藏</span>
            </button>
            <button type="button" onClick={() => setDiscoveryTab('recent')}>
              <Clock3 size={16} />
              <span>最近访问</span>
            </button>
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
            {onLogout ? <NotificationBell organizationId={page.organizationId} /> : null}
            <ConnectionPill state={connection} offlineReady={offlineReady} />
            <div className="avatars" title={`${onlineCount} 人在线`}>
              <span style={{ background: identity.color }}>{identityMonogram(identity)}</span>
              {onlineCount > 1 && <b>+{onlineCount - 1}</b>}
            </div>
            {page.role === 'space_admin' && !renewTicket ? (
              <button
                className="header-button"
                type="button"
                onClick={() => setAccessDialogOpen(true)}
              >
                <LockKeyhole size={16} /> 权限
              </button>
            ) : null}
            <button className="header-button" onClick={share}>
              {copied ? <Check size={16} /> : <Share2 size={16} />}
              {copied ? '已复制' : '分享'}
            </button>
            {!renewTicket ? (
              <button
                className="header-button"
                onClick={() => void exportCurrentPage()}
                disabled={pageActionBusy}
              >
                <Download size={16} /> 导出
              </button>
            ) : null}
            {canEdit ? (
              <button
                className="icon-button"
                aria-label="更多"
                aria-expanded={pageMenuOpen}
                onClick={() => setPageMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={18} />
              </button>
            ) : null}
            {pageMenuOpen ? (
              <div className="page-action-menu">
                {page.role === 'space_admin' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAccessDialogOpen(true);
                      setPageMenuOpen(false);
                    }}
                  >
                    <LockKeyhole size={15} /> 访问权限
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setMoveParentId(page.parentId ?? '');
                    setMoveDialogOpen(true);
                    setPageMenuOpen(false);
                  }}
                >
                  <FolderInput size={15} /> 移动页面
                </button>
                <button type="button" onClick={() => void copyCurrentPage()}>
                  <Copy size={15} /> 创建副本
                </button>
                <button
                  type="button"
                  disabled={siblingIndex <= 0}
                  onClick={() => void reorderCurrentPage('up')}
                >
                  <ArrowUp size={15} /> 上移
                </button>
                <button
                  type="button"
                  disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1}
                  onClick={() => void reorderCurrentPage('down')}
                >
                  <ArrowDown size={15} /> 下移
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={() => {
                    setPageMenuOpen(false);
                    void removeCurrentPage();
                  }}
                >
                  <Trash2 size={15} /> 移入回收站
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="document-scroll">
          <article className="document-sheet">
            <div className="document-kicker">团队知识 / 协作原型</div>
            <input
              className="title-input"
              value={title}
              readOnly={!canEdit}
              onChange={(event) => {
                const nextTitle = event.target.value;
                setTitle(nextTitle);
                queueTitleSave(nextTitle);
              }}
              onBlur={() => void flushTitle()}
              aria-label="页面标题"
            />
            {collab ? (
              <CollaborativeEditor
                collab={collab}
                identity={identity}
                onSelectionQuote={setCommentSelection}
                editable={canEdit}
                onReady={handleEditorReady}
              />
            ) : (
              <div className="editor-loading">
                <div className="loading-mark" />
                <span>正在建立加密协作连接…</span>
              </div>
            )}
          </article>
        </div>
      </main>

      {!renewTicket ? (
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
            <button
              className={contextTab === 'attachments' ? 'active' : ''}
              onClick={() => setContextTab('attachments')}
            >
              <Paperclip size={16} />
              附件
            </button>
          </div>
          {contextTab === 'comments' ? (
            <CommentsPanel
              pageId={page.id}
              canComment={page.role !== 'viewer'}
              selection={commentSelection}
              clearQuote={() => setCommentSelection(null)}
            />
          ) : contextTab === 'history' ? (
            <RevisionPanel
              pageId={page.id}
              flushDocument={flushDocument}
              getCurrentSnapshot={() => (collab ? Y.encodeStateAsUpdate(collab.ydoc) : null)}
            />
          ) : (
            <AttachmentPanel pageId={page.id} canEdit={canEdit} onInsert={insertAttachment} />
          )}
        </aside>
      ) : null}
      {moveDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <form className="rdocs-dialog" onSubmit={(event) => void submitMove(event)}>
            <div className="dialog-icon">
              <FolderInput size={19} />
            </div>
            <h2>移动“{page.title}”</h2>
            <p>页面只能在当前空间内移动，子页面会一起移动。</p>
            <label>
              目标位置
              <select
                value={moveParentId}
                onChange={(event) => setMoveParentId(event.target.value)}
              >
                <option value="">空间根目录</option>
                {pages
                  .filter((candidate) => !unavailableMoveTargets.has(candidate.id))
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
              </select>
            </label>
            {pageActionError ? (
              <p className="dialog-error" role="alert">
                {pageActionError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => setMoveDialogOpen(false)}
                disabled={pageActionBusy}
              >
                取消
              </button>
              <button className="primary-button" type="submit" disabled={pageActionBusy}>
                {pageActionBusy ? '正在移动…' : '确认移动'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {accessDialogOpen ? (
        <PageAccessDialog page={page} onClose={() => setAccessDialogOpen(false)} />
      ) : null}
      {discoveryTab ? (
        <DiscoveryDialog
          organizationId={page.organizationId}
          initialTab={discoveryTab}
          onClose={() => setDiscoveryTab(null)}
        />
      ) : null}
      {pageActionError && !moveDialogOpen ? (
        <p className="page-action-error" role="alert">
          {pageActionError}
        </p>
      ) : null}
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
  canCreate,
  depth = 0,
}: {
  nodes: PageTreeNode[];
  activePageId: string;
  collapsedPageIds: ReadonlySet<string>;
  creatingUnder: string | null | undefined;
  onToggle: (pageId: string) => void;
  onCreateChild: (parentId: string) => void;
  canCreate: boolean;
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
              {canCreate ? (
                <button
                  className="page-tree-add"
                  type="button"
                  title={`在“${node.title}”下新建子页面`}
                  aria-label={`在“${node.title}”下新建子页面`}
                  disabled={creatingUnder !== undefined}
                  onClick={() => onCreateChild(node.id)}
                >
                  {creatingUnder === node.id ? (
                    <span className="mini-spinner" />
                  ) : (
                    <Plus size={13} />
                  )}
                </button>
              ) : null}
            </div>
            {hasChildren && !collapsed && (
              <PageTree
                nodes={node.children}
                activePageId={activePageId}
                collapsedPageIds={collapsedPageIds}
                creatingUnder={creatingUnder}
                onToggle={onToggle}
                onCreateChild={onCreateChild}
                canCreate={canCreate}
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
  onSelectionQuote,
  editable,
  onReady,
}: {
  collab: { ydoc: Y.Doc; provider: WebsocketProvider };
  identity: LocalIdentity;
  onSelectionQuote: (selection: CommentSelection | null) => void;
  editable: boolean;
  onReady: (editor: Editor | null) => void;
}) {
  const [, rerender] = useState(0);
  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ allowBase64: false }),
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
    onSelectionUpdate: ({ editor: currentEditor }) => {
      rerender((value) => value + 1);
      const { from, to } = currentEditor.state.selection;
      if (from === to) {
        onSelectionQuote(null);
        return;
      }
      const quotedText = currentEditor.state.doc.textBetween(from, to, ' ').trim().slice(0, 500);
      const syncState = ySyncPluginKey.getState(currentEditor.state) as
        | { type?: Y.XmlFragment; binding?: { mapping?: Map<Y.AbstractType<unknown>, unknown> } }
        | undefined;
      if (!quotedText || !syncState?.type || !syncState.binding?.mapping) {
        onSelectionQuote(null);
        return;
      }
      const anchorStart = encodeRelativePosition(
        absolutePositionToRelativePosition(
          from,
          syncState.type,
          syncState.binding.mapping as never,
        ),
      );
      const anchorEnd = encodeRelativePosition(
        absolutePositionToRelativePosition(to, syncState.type, syncState.binding.mapping as never),
      );
      onSelectionQuote({ quotedText, anchorStart, anchorEnd });
    },
    onTransaction: () => rerender((value) => value + 1),
  });

  useEffect(() => {
    onReady(editor);
    return () => onReady(null);
  }, [editor, onReady]);

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
      label: '任务清单',
      icon: <ListChecks size={16} />,
      action: () => editor.chain().focus().toggleTaskList().run(),
      active: editor.isActive('taskList'),
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
      label: editor.isActive('link') ? '编辑链接' : '添加链接',
      icon: <Link2 size={16} />,
      action: () => {
        const current = String(editor.getAttributes('link').href ?? '');
        const href = window.prompt('输入链接地址；留空可移除链接', current);
        if (href === null) return;
        if (!href.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
        else editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
      },
      active: editor.isActive('link'),
    },
    {
      label: editor.isActive('table') ? '删除表格' : '插入表格',
      icon: <Table2 size={16} />,
      action: () => {
        if (editor.isActive('table')) editor.chain().focus().deleteTable().run();
        else editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      },
      active: editor.isActive('table'),
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
  return identity.name.trim().slice(-2) || '成员';
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

function ConnectionPill({
  state,
  offlineReady,
}: {
  state: ConnectionState;
  offlineReady: boolean;
}) {
  const labels: Record<ConnectionState, string> = {
    connecting: '正在连接',
    connected: '正在同步',
    synced: '已同步',
    disconnected: offlineReady ? '离线已保存' : '重新连接中',
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
