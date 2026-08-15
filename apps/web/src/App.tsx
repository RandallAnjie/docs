import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Mathematics } from '@tiptap/extension-mathematics';
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
  Bookmark,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Columns2,
  Columns3,
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
  ListTree,
  List,
  ListChecks,
  ListOrdered,
  LockKeyhole,
  LogOut,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Quote,
  Search,
  Share2,
  Sparkles,
  SquareChevronDown,
  Star,
  Table2,
  Trash2,
  Users,
  Upload,
  Video,
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
import { flushSync } from 'react-dom';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import 'katex/dist/katex.min.css';

import type {
  AuthSessionResponse,
  AuthUserSummary,
  AttachmentSummary,
  DatabaseSnapshot,
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
  copyPage,
  createPageDatabase,
  createPage,
  createSpace,
  deletePage,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  exportMarkdown,
  getAuthSession,
  getCollabTicket,
  getPageDatabase,
  getPage,
  getPublicShare,
  listPages,
  listOrganizations,
  listSpaces,
  logout,
  importMarkdown,
  movePage,
  updateSpace,
  updatePageAppearance,
  updatePageTitle,
  uploadAttachment,
} from './api';
import { HttpCollaborationTransport } from './http-collaboration';
import { AttachmentPanel, type AttachmentPanelHandle } from './AttachmentPanel';
import { CommentsPanel } from './CommentsPanel';
import { DatabaseCanvas } from './DatabaseCanvas';
import type { LocalIdentity } from './identity';
import { DiscoveryDialog } from './DiscoveryDialog';
import { EditorBlockHandle } from './EditorBlockHandle';
import { normalizeBookmarkUrl, normalizeEmbedUrl, rdocsEditorBlocks } from './EditorBlocks';
import { OrganizationSettings } from './OrganizationSettings';
import { NotificationBell } from './NotificationBell';
import { PageAccessDialog } from './PageAccessDialog';
import { PublicDatabaseForm } from './PublicDatabaseForm';
import { ancestorPageIds, buildPageTree, descendantPageIds, type PageTreeNode } from './page-tree';
import { RevisionPanel } from './RevisionPanel';
import { SpaceAccessDialog } from './SpaceAccessDialog';
import { SpaceTrashDialog } from './SpaceTrashDialog';
import { TemplateDialog } from './TemplateDialog';
import { firstCharacter, WorkspaceSwitcher } from './WorkspaceSwitcher';
import { removeAttachmentNodes } from './editor-block-operations';

type ConnectionState = 'connecting' | 'connected' | 'synced' | 'disconnected' | 'error';

interface CommentSelection {
  quotedText: string;
  anchorStart: string;
  anchorEnd: string;
}

interface ActiveCollaborator {
  id: string;
  name: string;
  color: string;
}

type SlashCommandId =
  | 'bookmark'
  | 'bullet-list'
  | 'callout'
  | 'code'
  | 'columns-2'
  | 'columns-3'
  | 'details'
  | 'divider'
  | 'embed'
  | 'file'
  | 'heading-1'
  | 'heading-2'
  | 'inline-math'
  | 'audio'
  | 'numbered-list'
  | 'paragraph'
  | 'quote'
  | 'table'
  | 'table-of-contents'
  | 'task-list'
  | 'video'
  | 'block-math';

interface SlashCommandDefinition {
  description: string;
  id: SlashCommandId;
  keywords: string;
  label: string;
}

interface SlashContext {
  from: number;
  query: string;
  to: number;
}

interface SlashMenuState extends SlashContext {
  left: number;
  top: number;
}

const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { id: 'paragraph', label: '正文', description: '从普通文本开始', keywords: 'text 文本 段落' },
  { id: 'heading-1', label: '一级标题', description: '大号章节标题', keywords: 'h1 title 标题' },
  { id: 'heading-2', label: '二级标题', description: '中号章节标题', keywords: 'h2 subtitle 标题' },
  {
    id: 'bullet-list',
    label: '无序列表',
    description: '创建简单项目列表',
    keywords: 'bullet list 列表',
  },
  {
    id: 'numbered-list',
    label: '有序列表',
    description: '创建带编号的步骤',
    keywords: 'number ordered list 编号',
  },
  {
    id: 'task-list',
    label: '待办清单',
    description: '跟踪要完成的事项',
    keywords: 'todo task check 待办',
  },
  {
    id: 'details',
    label: '折叠块',
    description: '收起或展开一段内容',
    keywords: 'toggle details 折叠',
  },
  {
    id: 'callout',
    label: 'Callout',
    description: '突出显示提示或结论',
    keywords: '提示 callout notice',
  },
  { id: 'quote', label: '引用', description: '引用一段文字', keywords: 'quote 引用' },
  { id: 'code', label: '代码块', description: '显示带格式的代码', keywords: 'code 代码' },
  { id: 'table', label: '简单表格', description: '插入 3 × 3 表格', keywords: 'table 表格' },
  {
    id: 'columns-2',
    label: '两栏布局',
    description: '并排组织两组内容',
    keywords: 'columns layout 分栏 两栏',
  },
  {
    id: 'columns-3',
    label: '三栏布局',
    description: '并排组织三组内容',
    keywords: 'columns layout 分栏 三栏',
  },
  {
    id: 'table-of-contents',
    label: '目录',
    description: '根据页面标题自动更新',
    keywords: 'toc contents 目录',
  },
  {
    id: 'bookmark',
    label: '网页书签',
    description: '以卡片形式保存链接',
    keywords: 'bookmark link url 书签',
  },
  {
    id: 'file',
    label: '文件',
    description: '上传并插入私有文件',
    keywords: 'file attachment upload 文件 附件',
  },
  {
    id: 'audio',
    label: '音频',
    description: '上传可播放的音频',
    keywords: 'audio music upload 音频 音乐',
  },
  {
    id: 'video',
    label: '视频',
    description: '上传可播放的视频',
    keywords: 'video movie upload 视频',
  },
  {
    id: 'embed',
    label: '嵌入',
    description: '嵌入视频、设计稿或代码',
    keywords: 'embed video figma loom 嵌入',
  },
  {
    id: 'inline-math',
    label: '行内公式',
    description: '在文字中插入 LaTeX',
    keywords: 'math latex formula 公式',
  },
  {
    id: 'block-math',
    label: '块公式',
    description: '单独显示 LaTeX 公式',
    keywords: 'math latex equation 公式',
  },
  {
    id: 'divider',
    label: '分割线',
    description: '在内容之间加入分隔',
    keywords: 'divider rule 分割线',
  },
];

function slashContext(editor: Editor): SlashContext | null {
  const { selection } = editor.state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;
  const beforeCursor = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    ' ',
    ' ',
  );
  const match = beforeCursor.match(/^\/([^/]*)$/);
  if (!match || (match[1]?.length ?? 0) > 40) return null;
  return {
    from: selection.from - match[0].length,
    query: match[1] ?? '',
    to: selection.from,
  };
}

function slashCommandIcon(id: SlashCommandId): ReactNode {
  switch (id) {
    case 'heading-1':
      return <Heading1 size={17} />;
    case 'heading-2':
      return <Heading2 size={17} />;
    case 'bullet-list':
      return <List size={17} />;
    case 'numbered-list':
      return <ListOrdered size={17} />;
    case 'task-list':
      return <ListChecks size={17} />;
    case 'details':
      return <SquareChevronDown size={17} />;
    case 'callout':
      return <span>💡</span>;
    case 'quote':
      return <Quote size={17} />;
    case 'code':
      return <Code2 size={17} />;
    case 'table':
      return <Table2 size={17} />;
    case 'columns-2':
      return <Columns2 size={17} />;
    case 'columns-3':
      return <Columns3 size={17} />;
    case 'table-of-contents':
      return <ListTree size={17} />;
    case 'bookmark':
      return <Bookmark size={17} />;
    case 'file':
      return <Paperclip size={17} />;
    case 'audio':
      return <Music2 size={17} />;
    case 'video':
      return <Video size={17} />;
    case 'embed':
      return <span>▶</span>;
    case 'inline-math':
    case 'block-math':
      return <Calculator size={17} />;
    case 'divider':
      return <Minus size={17} />;
    default:
      return <span className="text-tool">T</span>;
  }
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

function currentFormToken(): string | null {
  const match = window.location.pathname.match(/^\/forms\/([^/]+)\/?$/);
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
  const formToken = currentFormToken();
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
    if (formToken || shareToken) return;
    void refreshSession().catch(() => undefined);
  }, [formToken, refreshSession, shareToken]);

  useEffect(() => {
    if (formToken || shareToken) return;
    const handleAuthRequired = () => void refreshSession().catch(() => undefined);
    window.addEventListener('rdocs:auth-required', handleAuthRequired);
    return () => window.removeEventListener('rdocs:auth-required', handleAuthRequired);
  }, [formToken, refreshSession, shareToken]);

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

  if (formToken) return <PublicDatabaseForm token={formToken} />;
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
  const [pagesBySpace, setPagesBySpace] = useState<Record<string, PageSummary[]>>({});
  const [loading, setLoading] = useState(true);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [spaceVisibility, setSpaceVisibility] = useState<SpaceVisibility>('organization');
  const [busy, setBusy] = useState(false);
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(
    () => new URLSearchParams(window.location.search).get('settings') === '1',
  );
  const [discoveryTab, setDiscoveryTab] = useState<'search' | 'favorites' | 'recent' | null>(null);
  const [creatingPage, setCreatingPage] = useState<
    { spaceId: string; parentId: string | null } | undefined
  >(undefined);
  const [collapsedPageIds, setCollapsedPageIds] = useState<ReadonlySet<string>>(new Set());
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
    setPagesBySpace({});
    listSpaces(selectedOrganizationId, true)
      .then(async ({ spaces: nextSpaces }) => {
        if (!active) return;
        setSpaces(nextSpaces);
        setSpacesLoading(false);
        const pageResults = await Promise.allSettled(
          nextSpaces
            .filter((space) => space.archivedAt === null)
            .map(async (space) => ({
              spaceId: space.id,
              pages: (await listPages(space.id)).pages,
            })),
        );
        if (!active) return;
        setPagesBySpace(
          Object.fromEntries(
            pageResults.flatMap((result) =>
              result.status === 'fulfilled'
                ? [[result.value.spaceId, result.value.pages] as const]
                : [],
            ),
          ),
        );
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
      setPagesBySpace((current) => ({ ...current, [result.space.id]: [] }));
      setSpaceName('');
      setSpaceDialogOpen(false);
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

  const openNewDatabase = async (space: SpaceSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { page } = await createPage('未命名数据库', null, space.id);
      await createPageDatabase(page.id);
      navigateToPage(page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建数据库');
      setBusy(false);
    }
  };

  const createAndOpenPage = async (space: SpaceSummary, parentId: string | null) => {
    if (creatingPage) return;
    setCreatingPage({ spaceId: space.id, parentId });
    setError(null);
    try {
      const { page } = await createPage('未命名页面', parentId, space.id);
      navigateToPage(page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建页面');
      setCreatingPage(undefined);
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
  const restorableArchivedSpaces = archivedSpaces.filter((space) => space.role === 'space_admin');
  const recentPages = Object.values(pagesBySpace)
    .flat()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8);

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
    <main className="notion-home-shell">
      <input
        ref={markdownInput}
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        onChange={(event) => void importMarkdownFile(event.target.files?.[0])}
      />
      <aside className="notion-home-sidebar">
        <WorkspaceSwitcher
          organizations={organizations}
          activeOrganizationId={selectedOrganizationId}
          identity={identity}
          onSelect={selectOrganization}
          onCreated={({ organization, space }) => {
            setOrganizations((current) => [...current, organization]);
            setSpaces([space]);
            setPagesBySpace({ [space.id]: [] });
            selectOrganization(organization.id);
          }}
          onJoined={(organization) => {
            setOrganizations((current) =>
              current.some((candidate) => candidate.id === organization.id)
                ? current
                : [...current, organization],
            );
            selectOrganization(organization.id);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={onLogout}
        />
        <div className="notion-primary-navigation">
          <button
            type="button"
            disabled={!selectedOrganization}
            onClick={() => setDiscoveryTab('search')}
          >
            <Search size={17} />
            搜索
            <kbd>⌘ K</kbd>
          </button>
          <a className="active" href="/">
            <FileText size={17} /> 主页
          </a>
          <button
            type="button"
            disabled={!selectedOrganization}
            onClick={() => setDiscoveryTab('recent')}
          >
            <Clock3 size={17} /> 最近访问
          </button>
          <button
            type="button"
            disabled={!selectedOrganization}
            onClick={() => setDiscoveryTab('favorites')}
          >
            <Star size={17} /> 收藏
          </button>
        </div>
        <nav className="notion-space-navigation">
          <div className="notion-section-heading">
            <span>团队空间</span>
            {selectedOrganization ? (
              <button
                type="button"
                aria-label="新建团队空间"
                onClick={() => setSpaceDialogOpen(true)}
              >
                <Plus size={15} />
              </button>
            ) : null}
          </div>
          {spacesLoading || loading ? (
            <div className="notion-sidebar-loading">
              <span className="mini-spinner" /> 加载中…
            </div>
          ) : (
            activeSpaces.map((space) => {
              const spacePages = pagesBySpace[space.id] ?? [];
              const canCreate = space.role === 'space_admin' || space.role === 'editor';
              return (
                <section className="notion-space-group" key={space.id}>
                  <div className="notion-space-row">
                    <span>{space.icon || '◆'}</span>
                    <strong>{space.name}</strong>
                    {canCreate ? (
                      <span className="notion-space-create-actions">
                        <button
                          type="button"
                          aria-label={`在${space.name}中新建数据库`}
                          title="新建数据库"
                          onClick={() => void openNewDatabase(space)}
                        >
                          <Table2 size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={`在${space.name}中新建页面`}
                          title="新建页面"
                          onClick={() => void createAndOpenPage(space, null)}
                        >
                          <Plus size={13} />
                        </button>
                      </span>
                    ) : null}
                  </div>
                  <PageTree
                    nodes={buildPageTree(spacePages)}
                    activePageId=""
                    collapsedPageIds={collapsedPageIds}
                    creatingUnder={
                      creatingPage?.spaceId === space.id ? creatingPage.parentId : undefined
                    }
                    onToggle={togglePage}
                    onCreateChild={(parentId) => void createAndOpenPage(space, parentId)}
                    canCreate={canCreate}
                  />
                  {!spacePages.length ? <p className="notion-empty-pages">尚无页面</p> : null}
                </section>
              );
            })
          )}
        </nav>
        <div className="notion-sidebar-bottom">
          {activeSpaces[0] ? (
            <>
              <button type="button" onClick={() => setTemplateSpace(activeSpaces[0] ?? null)}>
                <Sparkles size={16} /> 模板
              </button>
              <button type="button" onClick={() => setTrashSpace(activeSpaces[0] ?? null)}>
                <Trash2 size={16} /> 回收站
              </button>
            </>
          ) : null}
        </div>
      </aside>

      <section className="notion-home-main">
        <header className="notion-home-header">
          <span>主页</span>
          <div>
            {selectedOrganization ? (
              <NotificationBell organizationId={selectedOrganization.id} />
            ) : null}
            <IdentityBubble identity={identity} compact />
          </div>
        </header>
        <div className="notion-home-content">
          <h1>你好，{user.displayName}</h1>
          <p className="notion-home-subtitle">继续处理你的文档，或从一个新页面开始。</p>
          {loading ? (
            <div className="notion-home-loading">
              <div className="loading-mark" />
              正在打开工作区…
            </div>
          ) : !selectedOrganization ? (
            <div className="notion-home-empty">
              <span>{firstCharacter(identity.name)}</span>
              <h2>创建你的第一个工作区</h2>
              <p>从左上角的菜单创建工作区，或者通过邀请链接加入其他团队。</p>
            </div>
          ) : (
            <>
              <section className="notion-home-section">
                <div className="notion-home-section-title">
                  <h2>最近访问</h2>
                  <button type="button" onClick={() => setDiscoveryTab('recent')}>
                    查看全部
                  </button>
                </div>
                {recentPages.length ? (
                  <div className="notion-recent-grid">
                    {recentPages.map((recentPage) => (
                      <a key={recentPage.id} href={`/p/${encodeURIComponent(recentPage.id)}`}>
                        <div>
                          <FileText size={24} />
                        </div>
                        <strong>{recentPage.title}</strong>
                        <small>{new Date(recentPage.updatedAt).toLocaleDateString()}</small>
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="notion-inline-empty">这里会显示最近编辑过的页面。</div>
                )}
              </section>
              <section className="notion-home-section">
                <div className="notion-home-section-title">
                  <h2>团队空间</h2>
                  <button type="button" onClick={() => setSpaceDialogOpen(true)}>
                    新建
                  </button>
                </div>
                <div className="notion-teamspace-list">
                  {activeSpaces.map((space) => (
                    <article key={space.id}>
                      <button
                        className="notion-teamspace-main"
                        type="button"
                        onClick={() => {
                          const firstPage = pagesBySpace[space.id]?.[0];
                          if (firstPage) navigateToPage(firstPage.id);
                          else void openNewPage(space);
                        }}
                      >
                        <span>{space.icon || '◆'}</span>
                        <div>
                          <strong>{space.name}</strong>
                          <small>
                            {pagesBySpace[space.id]?.length ?? 0} 个页面 ·{' '}
                            {space.visibility === 'restricted' ? '仅受邀成员' : '工作区成员'}
                          </small>
                        </div>
                        <ChevronRight size={16} />
                      </button>
                      <div className="notion-teamspace-actions">
                        {space.role === 'space_admin' || space.role === 'editor' ? (
                          <button
                            type="button"
                            onClick={() => {
                              setMarkdownSpaceId(space.id);
                              window.setTimeout(() => markdownInput.current?.click(), 0);
                            }}
                            aria-label={`导入到${space.name}`}
                          >
                            <Upload size={15} />
                          </button>
                        ) : null}
                        {space.role === 'space_admin' ? (
                          <button
                            type="button"
                            onClick={() => setAccessSpace(space)}
                            aria-label={`${space.name}权限`}
                          >
                            <LockKeyhole size={15} />
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              {restorableArchivedSpaces.length ? (
                <section className="notion-home-section notion-archived-section">
                  <h2>已归档空间</h2>
                  {restorableArchivedSpaces.map((space) => (
                    <button
                      key={space.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void restoreSpace(space)}
                    >
                      <ArchiveRestore size={15} /> {space.name} <span>恢复</span>
                    </button>
                  ))}
                </section>
              ) : null}
            </>
          )}
        </div>
      </section>

      {spaceDialogOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="rdocs-dialog workspace-action-dialog"
            onSubmit={(event) => void submitSpace(event)}
          >
            <button
              className="dialog-close-button"
              type="button"
              aria-label="关闭"
              onClick={() => setSpaceDialogOpen(false)}
            >
              ×
            </button>
            <div className="dialog-icon">
              <Users size={19} />
            </div>
            <h2>新建团队空间</h2>
            <p>团队空间拥有独立的页面树和成员权限。</p>
            <label>
              名称
              <input
                autoFocus
                required
                maxLength={100}
                value={spaceName}
                onChange={(event) => setSpaceName(event.target.value)}
                placeholder="例如：产品与设计"
              />
            </label>
            <label>
              可见范围
              <select
                value={spaceVisibility}
                onChange={(event) => setSpaceVisibility(event.target.value as SpaceVisibility)}
              >
                <option value="organization">所有工作区成员</option>
                <option value="restricted">仅受邀成员</option>
              </select>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setSpaceDialogOpen(false)}>
                取消
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? '正在创建…' : '创建'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {settingsOpen && selectedOrganization && selectedOrganization.role !== 'guest' ? (
        <div className="dialog-backdrop organization-settings-backdrop" role="presentation">
          <div className="organization-settings-dialog">
            <button
              className="dialog-close-button"
              type="button"
              aria-label="关闭设置"
              onClick={() => setSettingsOpen(false)}
            >
              ×
            </button>
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
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="tenant-error floating-error" role="alert">
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
      {discoveryTab && selectedOrganization ? (
        <DiscoveryDialog
          organizationId={selectedOrganization.id}
          initialTab={discoveryTab}
          onClose={() => setDiscoveryTab(null)}
        />
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
    database: DatabaseSnapshot | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getPage(pageId)
      .then(async ({ page }) => {
        const [{ ticket }, { pages }, database] = await Promise.all([
          getCollabTicket(pageId, identity),
          listPages(page.spaceId),
          getPageDatabase(pageId),
        ]);
        if (active) {
          setBootstrap({
            page,
            pages: pages.some((candidate) => candidate.id === page.id) ? pages : [...pages, page],
            ticket,
            database,
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
      initialDatabase={bootstrap.database}
    />
  );
}

function PageAppearanceDialog({
  page,
  canManage,
  onSaved,
  onClose,
}: {
  page: PageSummary;
  canManage: boolean;
  onSaved: (page: PageSummary) => void;
  onClose: () => void;
}) {
  const [icon, setIcon] = useState(page.icon ?? '');
  const [coverAttachmentId, setCoverAttachmentId] = useState<string | null>(page.coverAttachmentId);
  const [fontStyle, setFontStyle] = useState(page.fontStyle);
  const [isFullWidth, setIsFullWidth] = useState(page.isFullWidth);
  const [isSmallText, setIsSmallText] = useState(page.isSmallText);
  const [isLocked, setIsLocked] = useState(page.isLocked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadCover = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!file.type.startsWith('image/')) {
      setError('封面必须是图片文件');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { attachment } = await uploadAttachment(page.id, file);
      setCoverAttachmentId(attachment.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '封面上传失败');
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = page.isLocked
        ? { isLocked: false }
        : {
            icon: icon.trim() || null,
            coverAttachmentId,
            fontStyle,
            isFullWidth,
            isSmallText,
            ...(canManage ? { isLocked } : {}),
          };
      const { page: updated } = await updatePageAppearance(page.id, input);
      onSaved(updated);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存页面外观');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="rdocs-dialog page-appearance-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-appearance-title"
        onSubmit={(event) => void save(event)}
      >
        <header>
          <div>
            <h2 id="page-appearance-title">自定义页面</h2>
            <p>图标、封面和排版会对所有有权访问此页面的人生效。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {page.isLocked ? (
          <div className="page-appearance-locked">
            <LockKeyhole size={17} />
            <span>页面已锁定。先解锁，才能修改外观和内容。</span>
          </div>
        ) : (
          <>
            <div className="page-appearance-row">
              <label>
                页面图标
                <input
                  value={icon}
                  maxLength={32}
                  placeholder="输入一个 Emoji"
                  onChange={(event) => setIcon(event.target.value)}
                />
              </label>
              <button type="button" onClick={() => setIcon('')} disabled={!icon}>
                移除图标
              </button>
            </div>
            <div className="page-cover-setting">
              {coverAttachmentId ? (
                <img src={attachmentDownloadUrl(coverAttachmentId)} alt="当前页面封面" />
              ) : (
                <div className="page-cover-placeholder">添加一张页面封面</div>
              )}
              <div>
                <label className="file-button">
                  <Upload size={15} /> {busy ? '上传中…' : '上传图片'}
                  <input
                    type="file"
                    accept="image/*"
                    disabled={busy}
                    onChange={(event) => void uploadCover(event.target.files?.[0])}
                  />
                </label>
                <button
                  type="button"
                  disabled={!coverAttachmentId || busy}
                  onClick={() => setCoverAttachmentId(null)}
                >
                  移除封面
                </button>
              </div>
            </div>
            <fieldset className="page-font-options">
              <legend>字体</legend>
              {(
                [
                  ['sans', '默认', '清晰、现代'],
                  ['serif', '衬线', '适合长文阅读'],
                  ['mono', '等宽', '适合技术内容'],
                ] as const
              ).map(([value, label, description]) => (
                <label key={value} className={`font-${value}`}>
                  <input
                    type="radio"
                    name="fontStyle"
                    value={value}
                    checked={fontStyle === value}
                    onChange={() => setFontStyle(value)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="page-setting-toggle">
              <span>
                <strong>全宽页面</strong>
                <small>让内容使用更多横向空间</small>
              </span>
              <input
                type="checkbox"
                checked={isFullWidth}
                onChange={(event) => setIsFullWidth(event.target.checked)}
              />
            </label>
            <label className="page-setting-toggle">
              <span>
                <strong>小字号</strong>
                <small>提高长页面的信息密度</small>
              </span>
              <input
                type="checkbox"
                checked={isSmallText}
                onChange={(event) => setIsSmallText(event.target.checked)}
              />
            </label>
            {canManage ? (
              <label className="page-setting-toggle">
                <span>
                  <strong>锁定页面</strong>
                  <small>关闭现有编辑连接，并阻止内容和数据库写入</small>
                </span>
                <input
                  type="checkbox"
                  checked={isLocked}
                  onChange={(event) => setIsLocked(event.target.checked)}
                />
              </label>
            ) : null}
          </>
        )}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || (page.isLocked && !canManage)}
          >
            {busy ? '保存中…' : page.isLocked ? '解锁页面' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DocumentWorkspace({
  initialPage,
  initialPages,
  initialTicket,
  identity,
  onLogout,
  renewTicket,
  initialDatabase,
}: {
  initialPage: PageSummary;
  initialPages: PageSummary[];
  initialTicket: string;
  identity: LocalIdentity;
  onLogout?: () => Promise<void>;
  renewTicket?: () => Promise<string>;
  initialDatabase?: DatabaseSnapshot | null;
}) {
  const [page, setPage] = useState(initialPage);
  const [pages, setPages] = useState(initialPages);
  const [title, setTitle] = useState(page.title);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [offlineReady, setOfflineReady] = useState(false);
  const [collab, setCollab] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const [collaborators, setCollaborators] = useState<ActiveCollaborator[]>([
    { id: identity.id, name: identity.name, color: identity.color },
  ]);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [organizationSpaces, setOrganizationSpaces] = useState<SpaceSummary[]>([]);
  const [commentSelection, setCommentSelection] = useState<CommentSelection | null>(null);
  const [copied, setCopied] = useState(false);
  const [contextTab, setContextTab] = useState<'comments' | 'history' | 'attachments'>('comments');
  const [collapsedPageIds, setCollapsedPageIds] = useState<ReadonlySet<string>>(new Set());
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [appearanceDialogOpen, setAppearanceDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [moveParentId, setMoveParentId] = useState(page.parentId ?? '');
  const [pageActionBusy, setPageActionBusy] = useState(false);
  const [pageActionError, setPageActionError] = useState<string | null>(null);
  const [discoveryTab, setDiscoveryTab] = useState<'search' | 'favorites' | 'recent' | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [database, setDatabase] = useState<DatabaseSnapshot | null>(initialDatabase ?? null);
  const titleTimer = useRef<number | undefined>(undefined);
  const latestTitle = useRef(page.title);
  const savedTitle = useRef(page.title);
  const titleSaveRunning = useRef(false);
  const sidebarNavigation = useRef<HTMLElement>(null);
  const httpTransportRef = useRef<HttpCollaborationTransport | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const attachmentPanelRef = useRef<AttachmentPanelHandle>(null);
  const pageTree = useMemo(() => buildPageTree(pages), [pages]);
  const canEditStructure = page.role === 'space_admin' || page.role === 'editor';
  const canManagePage = page.role === 'space_admin';
  const canEdit = canEditStructure && !page.isLocked;
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
  const activeOrganization = organizations.find(
    (organization) => organization.id === page.organizationId,
  );
  const activeSpace = organizationSpaces.find((space) => space.id === page.spaceId);

  useEffect(() => {
    if (renewTicket) return;
    let active = true;
    Promise.all([listOrganizations(), listSpaces(page.organizationId)])
      .then(([organizationResult, spaceResult]) => {
        if (!active) return;
        setOrganizations(organizationResult.organizations);
        setOrganizationSpaces(spaceResult.spaces);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [page.organizationId, renewTicket]);

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
      id: identity.id,
      name: identity.name,
      color: identity.color,
      monogram: identityMonogram(identity),
    });
    provider.on('status', ({ status }: { status: string }) => {
      if (disposed || terminalError || httpSynced) return;
      setConnection(status === 'connected' ? 'connected' : 'disconnected');
    });
    provider.on('sync', (synced: boolean) => {
      if (!disposed && !terminalError && synced) setConnection('synced');
    });
    const updateCollaborators = () => {
      const next = new Map<string, ActiveCollaborator>();
      const seenIdentities = new Set<string>();
      for (const [clientId, state] of provider.awareness.getStates()) {
        const user = state.user as Record<string, unknown> | undefined;
        if (!user) continue;
        const name = typeof user.name === 'string' && user.name.trim() ? user.name : '协作者';
        const color = typeof user.color === 'string' ? user.color : '#5f7f91';
        const id = typeof user.id === 'string' ? user.id : `${name}:${color}:${clientId}`;
        const identityKey = `${name}\u0000${color}`;
        if (!seenIdentities.has(identityKey)) {
          seenIdentities.add(identityKey);
          next.set(id, { id, name, color });
        }
      }
      if (!next.size)
        next.set(identity.id, { id: identity.id, name: identity.name, color: identity.color });
      setCollaborators([...next.values()]);
    };
    updateCollaborators();
    provider.awareness.on('change', updateCollaborators);
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
      provider.awareness.off('change', updateCollaborators);
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

  const convertToDatabase = async () => {
    if (pageActionBusy || database) return;
    setPageMenuOpen(false);
    setPageActionBusy(true);
    setPageActionError(null);
    try {
      await flushDocument();
      setDatabase(await createPageDatabase(page.id));
    } catch (reason) {
      setPageActionError(reason instanceof Error ? reason.message : '无法转换为数据库');
    } finally {
      setPageActionBusy(false);
    }
  };

  const insertAttachment = useCallback((attachment: AttachmentSummary) => {
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
    const commonAttributes = {
      attachmentId: attachment.id,
      byteSize: attachment.byteSize,
      mimeType: attachment.mimeType,
      name: attachment.originalName,
    };
    if (attachment.mimeType.startsWith('audio/')) {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'attachmentAudio', attrs: commonAttributes })
        .run();
      return;
    }
    if (attachment.mimeType.startsWith('video/')) {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'attachmentVideo', attrs: commonAttributes })
        .run();
      return;
    }
    editor.chain().focus().insertContent({ type: 'attachmentFile', attrs: commonAttributes }).run();
  }, []);

  const removeDeletedAttachmentFromDocument = useCallback((attachment: AttachmentSummary) => {
    const editor = editorRef.current;
    if (!editor) return;
    const transaction = removeAttachmentNodes(editor.state, attachment.id);
    if (transaction) editor.view.dispatch(transaction);
  }, []);

  const requestAttachmentUpload = useCallback((kind: 'audio' | 'file' | 'video') => {
    flushSync(() => {
      setContextPanelOpen(true);
      setContextTab('attachments');
    });
    const accept = kind === 'audio' ? 'audio/*' : kind === 'video' ? 'video/*' : undefined;
    attachmentPanelRef.current?.openPicker(accept);
  }, []);

  return (
    <div
      className={`app-shell ${renewTicket ? 'public-share' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${contextPanelOpen ? 'context-panel-open' : ''}`}
    >
      <aside className="sidebar">
        <div className="sidebar-top">
          {renewTicket ? (
            <a className="workspace-switcher public-workspace-switcher" href="/">
              <span className="workspace-avatar">R</span>
              {!sidebarCollapsed ? (
                <span className="workspace-switcher-copy">
                  <strong>Rdocs</strong>
                  <small>只读分享</small>
                </span>
              ) : null}
            </a>
          ) : (
            <WorkspaceSwitcher
              organizations={organizations}
              activeOrganizationId={page.organizationId}
              identity={identity}
              collapsed={sidebarCollapsed}
              onSelect={(organizationId) => {
                if (organizationId !== page.organizationId) window.location.assign('/');
              }}
              onCreated={() => window.location.assign('/')}
              onJoined={() => window.location.assign('/')}
              onOpenSettings={() => window.location.assign('/?settings=1')}
              onLogout={onLogout}
            />
          )}
          <button
            className="icon-button subtle"
            type="button"
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <div className="sidebar-actions">
          {!renewTicket ? (
            <button type="button" onClick={() => setDiscoveryTab('search')}>
              <Search size={16} />
              搜索 <kbd>⌘ K</kbd>
            </button>
          ) : null}
          {!renewTicket ? (
            <a href="/">
              <FileText size={16} />
              主页
            </a>
          ) : null}
          {canEditStructure ? (
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
            <p>{activeSpace?.name ?? '团队空间'}</p>
            <span>{pages.length}</span>
          </div>
          <PageTree
            nodes={pageTree}
            activePageId={page.id}
            collapsedPageIds={collapsedPageIds}
            creatingUnder={creatingUnder}
            onToggle={togglePage}
            onCreateChild={(parentId) => void createAndOpenPage(parentId)}
            canCreate={canEditStructure}
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
            <small>{activeOrganization?.name ?? (onLogout ? '设备密钥会话' : '只读分享')}</small>
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
            <span>{activeOrganization?.name ?? 'Rdocs'}</span>
            <span>/</span>
            {activeSpace ? (
              <>
                <span>{activeSpace.name}</span>
                <span>/</span>
              </>
            ) : null}
            <span>{page.title}</span>
            {page.isLocked ? <LockKeyhole size={13} aria-label="页面已锁定" /> : null}
          </div>
          <div className="header-actions">
            {onLogout ? <NotificationBell organizationId={page.organizationId} /> : null}
            <ConnectionPill state={connection} offlineReady={offlineReady} />
            <CollaboratorStack collaborators={collaborators} />
            {!renewTicket ? (
              <button
                className={`icon-button subtle header-comment-button ${contextPanelOpen ? 'active' : ''}`}
                type="button"
                aria-label={contextPanelOpen ? '关闭页面面板' : '打开评论与页面面板'}
                aria-pressed={contextPanelOpen}
                onClick={() => setContextPanelOpen((open) => !open)}
              >
                <MessageSquare size={17} />
              </button>
            ) : null}
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
            {canEditStructure ? (
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
                <button
                  type="button"
                  onClick={() => {
                    setAppearanceDialogOpen(true);
                    setPageMenuOpen(false);
                  }}
                >
                  <Sparkles size={15} /> 自定义页面
                </button>
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
                {!database ? (
                  <button type="button" onClick={() => void convertToDatabase()}>
                    <Table2 size={15} /> 转换为数据库
                  </button>
                ) : null}
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
          <article
            className={`document-sheet font-${page.fontStyle} ${page.isFullWidth ? 'page-full-width' : ''} ${page.isSmallText ? 'page-small-text' : ''} ${page.coverAttachmentId ? 'has-cover' : ''}`}
          >
            {page.coverAttachmentId ? (
              <div className="page-cover">
                <img src={attachmentDownloadUrl(page.coverAttachmentId)} alt="" />
              </div>
            ) : null}
            {page.icon ? (
              canEditStructure && !renewTicket ? (
                <button
                  className="page-icon-display"
                  type="button"
                  aria-label="修改页面图标"
                  onClick={() => setAppearanceDialogOpen(true)}
                >
                  {page.icon}
                </button>
              ) : (
                <span className="page-icon-display static">{page.icon}</span>
              )
            ) : null}
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
            {page.isLocked ? (
              <div className="page-lock-notice">
                <LockKeyhole size={15} /> 页面已锁定，当前为只读模式
              </div>
            ) : null}
            {database ? (
              <DatabaseCanvas initialSnapshot={database} canEdit={canEdit} />
            ) : collab ? (
              <CollaborativeEditor
                collab={collab}
                identity={identity}
                onSelectionQuote={setCommentSelection}
                editable={canEdit}
                onReady={handleEditorReady}
                onRequestAttachment={requestAttachmentUpload}
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

      {!renewTicket && contextPanelOpen ? (
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
            <AttachmentPanel
              ref={attachmentPanelRef}
              pageId={page.id}
              canEdit={canEdit}
              onInsert={insertAttachment}
              onDeleted={removeDeletedAttachmentFromDocument}
            />
          )}
        </aside>
      ) : null}
      {appearanceDialogOpen && !renewTicket ? (
        <PageAppearanceDialog
          page={page}
          canManage={canManagePage}
          onClose={() => setAppearanceDialogOpen(false)}
          onSaved={(updated) => {
            if (updated.isLocked !== page.isLocked) {
              window.location.reload();
              return;
            }
            setPage(updated);
            setPages((current) =>
              current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
            );
          }}
        />
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
                {node.icon ? (
                  <span className="page-tree-icon">{node.icon}</span>
                ) : (
                  <FileText size={14} />
                )}
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
  onRequestAttachment,
}: {
  collab: { ydoc: Y.Doc; provider: WebsocketProvider };
  identity: LocalIdentity;
  onSelectionQuote: (selection: CommentSelection | null) => void;
  editable: boolean;
  onReady: (editor: Editor | null) => void;
  onRequestAttachment: (kind: 'audio' | 'file' | 'video') => void;
}) {
  const [, rerender] = useState(0);
  const editorInstance = useRef<Editor | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  const updateSlashMenu = useCallback((currentEditor: Editor) => {
    const context = slashContext(currentEditor);
    if (!context) {
      setSlashMenu(null);
      return;
    }
    try {
      const coordinates = currentEditor.view.coordsAtPos(context.to);
      setSlashMenu({
        ...context,
        left: Math.min(coordinates.left, Math.max(12, window.innerWidth - 330)),
        top: Math.min(coordinates.bottom + 7, Math.max(12, window.innerHeight - 430)),
      });
    } catch {
      setSlashMenu(null);
    }
  }, []);

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
      Details.configure({ persist: true }),
      DetailsSummary,
      DetailsContent,
      Mathematics.configure({
        katexOptions: { throwOnError: false },
        inlineOptions: {
          onClick: (node, position) => {
            const currentEditor = editorInstance.current;
            if (!currentEditor?.isEditable) return;
            const latex = window.prompt('编辑行内 LaTeX 公式', String(node.attrs.latex ?? ''));
            if (latex === null || !latex.trim()) return;
            currentEditor
              .chain()
              .setNodeSelection(position)
              .updateInlineMath({ latex: latex.trim(), pos: position })
              .focus()
              .run();
          },
        },
        blockOptions: {
          onClick: (node, position) => {
            const currentEditor = editorInstance.current;
            if (!currentEditor?.isEditable) return;
            const latex = window.prompt('编辑块 LaTeX 公式', String(node.attrs.latex ?? ''));
            if (latex === null || !latex.trim()) return;
            currentEditor
              .chain()
              .setNodeSelection(position)
              .updateBlockMath({ latex: latex.trim(), pos: position })
              .focus()
              .run();
          },
        },
      }),
      ...rdocsEditorBlocks,
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
    onTransaction: ({ editor: currentEditor }) => {
      rerender((value) => value + 1);
      updateSlashMenu(currentEditor);
    },
  });

  useEffect(() => {
    editorInstance.current = editor;
    onReady(editor);
    return () => {
      editorInstance.current = null;
      onReady(null);
    };
  }, [editor, onReady]);

  const filteredSlashCommands = useMemo(() => {
    const query = slashMenu?.query.trim().toLocaleLowerCase() ?? '';
    if (!query) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((command) =>
      `${command.label} ${command.description} ${command.keywords}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [slashMenu?.query]);

  const runSlashCommand = useCallback(
    (id: SlashCommandId) => {
      if (!editor?.isEditable) return;
      const context = slashContext(editor);
      if (!context) return;

      if (id === 'bookmark') {
        const input = window.prompt('输入网页书签地址');
        if (input === null) return;
        const url = normalizeBookmarkUrl(input);
        if (!url) {
          window.alert('请输入有效的 HTTP(S) 地址');
          return;
        }
        const suggestedTitle = new URL(url).hostname;
        const title = window.prompt('书签标题', suggestedTitle)?.trim() || suggestedTitle;
        editor
          .chain()
          .focus()
          .deleteRange(context)
          .insertContent({ type: 'bookmark', attrs: { title, url } })
          .run();
        setSlashMenu(null);
        return;
      }

      if (id === 'embed') {
        const input = window.prompt(
          '输入嵌入地址（支持 YouTube、Figma、Loom、CodePen、CodeSandbox）',
        );
        if (input === null) return;
        const target = normalizeEmbedUrl(input);
        if (!target) {
          window.alert('暂不支持这个嵌入地址，或地址不是 HTTPS');
          return;
        }
        editor
          .chain()
          .focus()
          .deleteRange(context)
          .insertContent({ type: 'embed', attrs: target })
          .run();
        setSlashMenu(null);
        return;
      }

      if (id === 'inline-math' || id === 'block-math') {
        const latex = window.prompt(
          id === 'inline-math' ? '输入行内 LaTeX 公式' : '输入块 LaTeX 公式',
          id === 'inline-math' ? 'E = mc^2' : '\\sum_{i=1}^{n} x_i',
        );
        if (latex === null || !latex.trim()) return;
        const chain = editor.chain().focus().deleteRange(context);
        if (id === 'inline-math') chain.insertInlineMath({ latex: latex.trim() }).run();
        else chain.insertBlockMath({ latex: latex.trim() }).run();
        setSlashMenu(null);
        return;
      }

      if (id === 'audio' || id === 'file' || id === 'video') {
        editor.chain().focus().deleteRange(context).run();
        onRequestAttachment(id);
        setSlashMenu(null);
        return;
      }

      const chain = editor.chain().focus().deleteRange(context);
      switch (id) {
        case 'paragraph':
          chain.setParagraph().run();
          break;
        case 'heading-1':
          chain.setHeading({ level: 1 }).run();
          break;
        case 'heading-2':
          chain.setHeading({ level: 2 }).run();
          break;
        case 'bullet-list':
          chain.toggleBulletList().run();
          break;
        case 'numbered-list':
          chain.toggleOrderedList().run();
          break;
        case 'task-list':
          chain.toggleTaskList().run();
          break;
        case 'details':
          chain.setDetails().run();
          break;
        case 'callout':
          chain
            .insertContent({
              type: 'callout',
              attrs: { icon: '💡', tone: 'gray' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '输入提示内容' }] }],
            })
            .run();
          break;
        case 'quote':
          chain.toggleBlockquote().run();
          break;
        case 'code':
          chain.toggleCodeBlock().run();
          break;
        case 'table':
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          break;
        case 'columns-2':
        case 'columns-3': {
          const columnCount = id === 'columns-2' ? 2 : 3;
          chain
            .insertContent({
              type: 'columns',
              content: Array.from({ length: columnCount }, (_, index) => ({
                type: 'column',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: `第 ${index + 1} 栏` }],
                  },
                ],
              })),
            })
            .run();
          break;
        }
        case 'table-of-contents':
          chain.insertContent({ type: 'tableOfContents' }).run();
          break;
        case 'divider':
          chain.setHorizontalRule().run();
          break;
        default:
          break;
      }
      setSlashMenu(null);
    },
    [editor, onRequestAttachment],
  );

  useEffect(() => setSlashIndex(0), [slashMenu?.query]);

  useEffect(() => {
    if (!editor || !slashMenu) return;
    const handleMenuKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        editor.chain().focus().deleteRange(slashMenu).run();
        setSlashMenu(null);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!filteredSlashCommands.length) return;
        event.preventDefault();
        setSlashIndex((current) => {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          return (current + delta + filteredSlashCommands.length) % filteredSlashCommands.length;
        });
        return;
      }
      if (event.key === 'Enter' && filteredSlashCommands.length) {
        event.preventDefault();
        const selected = filteredSlashCommands[slashIndex % filteredSlashCommands.length];
        if (selected) runSlashCommand(selected.id);
      }
    };
    editor.view.dom.addEventListener('keydown', handleMenuKeys);
    return () => editor.view.dom.removeEventListener('keydown', handleMenuKeys);
  }, [editor, filteredSlashCommands, runSlashCommand, slashIndex, slashMenu]);

  if (!editor) return null;

  const tools = [
    {
      label: '插入内容块（也可输入 /）',
      icon: <Plus size={16} />,
      action: () => {
        const parent = editor.state.selection.$from.parent;
        if (parent.isTextblock && parent.content.size === 0) {
          editor.chain().focus().insertContent('/').run();
        } else {
          editor
            .chain()
            .focus()
            .insertContent({ type: 'paragraph', content: [{ type: 'text', text: '/' }] })
            .run();
        }
      },
      active: Boolean(slashMenu),
    },
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
            className={`${tool.active ? 'active' : ''} ${[1, 4, 6, 10].includes(index) ? 'tool-separator' : ''}`}
            onClick={tool.action}
            title={tool.label}
            type="button"
          >
            {tool.icon}
          </button>
        ))}
      </div>
      {editable ? <EditorBlockHandle editor={editor} /> : null}
      <EditorContent editor={editor} />
      {slashMenu ? (
        <div
          className="slash-menu"
          role="listbox"
          aria-label="插入内容块"
          style={{ left: slashMenu.left, top: slashMenu.top }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <header>
            <strong>基础内容块</strong>
            <span>输入关键词筛选 · ↑↓ 选择 · Enter 插入</span>
          </header>
          <div>
            {filteredSlashCommands.length ? (
              filteredSlashCommands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  className={index === slashIndex ? 'active' : ''}
                  onMouseEnter={() => setSlashIndex(index)}
                  onClick={() => runSlashCommand(command.id)}
                >
                  <span className="slash-command-icon">{slashCommandIcon(command.id)}</span>
                  <span>
                    <strong>{command.label}</strong>
                    <small>{command.description}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>没有匹配的内容块</p>
            )}
          </div>
        </div>
      ) : null}
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
  return firstCharacter(identity.name);
}

function renderCollaborationCaret(user: Record<string, unknown>): HTMLElement {
  const name = typeof user.name === 'string' ? user.name : '协作者';
  const monogram =
    typeof user.monogram === 'string'
      ? firstCharacter(user.monogram, '协')
      : firstCharacter(name, '协');
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

function CollaboratorStack({ collaborators }: { collaborators: ActiveCollaborator[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [maximumVisible, setMaximumVisible] = useState(4);

  useLayoutEffect(() => {
    const documentArea = root.current?.closest('.document-area');
    if (!documentArea) return;
    const update = (width: number) => {
      setMaximumVisible(
        width >= 1180 ? 6 : width >= 900 ? 5 : width >= 680 ? 4 : width >= 480 ? 3 : 2,
      );
    };
    update(documentArea.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) update(width);
    });
    observer.observe(documentArea);
    return () => observer.disconnect();
  }, []);

  const visibleCount =
    collaborators.length > maximumVisible ? Math.max(1, maximumVisible - 1) : maximumVisible;
  const visibleCollaborators = collaborators.slice(0, visibleCount);
  const overflow = Math.max(0, collaborators.length - visibleCollaborators.length);

  return (
    <div
      className="collaborator-stack"
      ref={root}
      title={collaborators.map((collaborator) => collaborator.name).join('、')}
      aria-label={`${collaborators.length} 人在线：${collaborators.map((collaborator) => collaborator.name).join('、')}`}
    >
      {visibleCollaborators.map((collaborator) => (
        <span
          key={collaborator.id}
          className="collaborator-avatar"
          style={{ background: collaborator.color }}
          title={collaborator.name}
        >
          {firstCharacter(collaborator.name, '协')}
        </span>
      ))}
      {overflow ? <b title={`另有 ${overflow} 位协作者`}>+{overflow}</b> : null}
    </div>
  );
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
