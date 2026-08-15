import type {
  AuditEventSummary,
  AuthSessionResponse,
  AttachmentSummary,
  CollabTicketResponse,
  CommentThreadSummary,
  CreatePageResponse,
  CreateRevisionResponse,
  FavoritePageResult,
  GroupSummary,
  InvitationSummary,
  ListPagesResponse,
  ListRevisionsResponse,
  NotificationSummary,
  OrganizationMemberSummary,
  OrganizationSummary,
  PageAccessMode,
  PageGrantSummary,
  PageSearchResult,
  PageSummary,
  RecentPageResult,
  RestoreRevisionResponse,
  ShareLinkSummary,
  SpaceGrantPrincipalType,
  SpaceGrantSummary,
  SpaceRole,
  SpaceSummary,
  SpaceVisibility,
  TrashedPageSummary,
} from '@rdocs/shared';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

interface RequestPolicy {
  retryTransientGet?: boolean;
  timeoutMs?: number;
}

const TRANSIENT_UPSTREAM_STATUSES = new Set([502, 503, 504]);

function retryDelay(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 150));
}

async function request<T>(path: string, init?: RequestInit, policy?: RequestPolicy): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const mayRetry = Boolean(policy?.retryTransientGet && method === 'GET');
  const attempts = mayRetry ? 2 : 1;
  let response: Response | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetch(path, {
        ...init,
        signal:
          init?.signal ?? (policy?.timeoutMs ? AbortSignal.timeout(policy.timeoutMs) : undefined),
        headers: {
          'content-type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (reason) {
      if (mayRetry && attempt + 1 < attempts) {
        await retryDelay();
        continue;
      }
      if (reason instanceof DOMException && reason.name === 'TimeoutError') {
        throw new Error('请求超时，请重试');
      }
      throw reason;
    }

    if (response.ok) return (await response.json()) as T;
    if (mayRetry && attempt + 1 < attempts && TRANSIENT_UPSTREAM_STATUSES.has(response.status)) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      await retryDelay();
      continue;
    }
    break;
  }

  if (!response) throw new Error('请求失败');

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('rdocs:auth-required'));
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败（${response.status}）`);
  }

  return (await response.json()) as T;
}

async function binaryRequest(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `请求失败（${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function createPage(
  title = '未命名页面',
  parentId: string | null = null,
  spaceId?: string,
): Promise<CreatePageResponse> {
  return request('/api/pages', {
    method: 'POST',
    body: JSON.stringify({ title, parentId, spaceId }),
  });
}

export async function importMarkdown(spaceId: string, file: File): Promise<CreatePageResponse> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/import/markdown`, {
    method: 'POST',
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'x-rdocs-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `导入失败（${response.status}）`);
  }
  return (await response.json()) as CreatePageResponse;
}

export async function exportMarkdown(pageId: string): Promise<void> {
  const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/export/markdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `导出失败（${response.status}）`);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const name = encodedName ? decodeURIComponent(encodedName) : 'Rdocs.md';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function listPages(spaceId?: string): Promise<ListPagesResponse> {
  return request(
    spaceId ? `/api/spaces/${encodeURIComponent(spaceId)}/tree` : '/api/pages',
    undefined,
    { retryTransientGet: true, timeoutMs: 5_000 },
  );
}

export function searchPages(
  organizationId: string,
  query: string,
): Promise<{ results: PageSearchResult[] }> {
  const parameters = new URLSearchParams({ organizationId, q: query });
  return request(`/api/search?${parameters.toString()}`);
}

export function listRecentPages(organizationId: string): Promise<{ pages: RecentPageResult[] }> {
  return request(`/api/recent?organizationId=${encodeURIComponent(organizationId)}`);
}

export function listFavoritePages(
  organizationId: string,
): Promise<{ pages: FavoritePageResult[] }> {
  return request(`/api/favorites?organizationId=${encodeURIComponent(organizationId)}`);
}

export function setPageFavorite(
  pageId: string,
  favorite: boolean,
): Promise<{ ok: true; favorite: boolean }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/favorite`, {
    method: favorite ? 'PUT' : 'DELETE',
  });
}

export function getPublicShare(token: string): Promise<{
  page: PageSummary;
  share: ShareLinkSummary;
  ticket: string;
  expiresAt: number;
}> {
  return request(`/api/public/shares/${encodeURIComponent(token)}`);
}

export function listShareLinks(pageId: string): Promise<{ links: ShareLinkSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/share-links`);
}

export function createShareLink(
  pageId: string,
  input: { role: 'viewer' | 'commenter'; expiresInDays: number | null },
): Promise<{ link: ShareLinkSummary; token: string }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/share-links`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function revokeShareLink(shareLinkId: string): Promise<{ ok: true; revokedAt: number }> {
  return request(`/api/share-links/${encodeURIComponent(shareLinkId)}`, { method: 'DELETE' });
}

export function getPage(pageId: string): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`);
}

export function listAttachments(pageId: string): Promise<{ attachments: AttachmentSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/attachments`);
}

export function listComments(pageId: string): Promise<{ threads: CommentThreadSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/comments`);
}

export function createCommentThread(
  pageId: string,
  input: { body: string; quotedText?: string; anchorStart?: string; anchorEnd?: string },
): Promise<{ threads: CommentThreadSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/comments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function replyToCommentThread(
  threadId: string,
  body: string,
): Promise<{ threads: CommentThreadSummary[] }> {
  return request(`/api/comment-threads/${encodeURIComponent(threadId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export function setCommentThreadResolved(
  threadId: string,
  resolved: boolean,
): Promise<{ threads: CommentThreadSummary[] }> {
  return request(`/api/comment-threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved }),
  });
}

export function listNotifications(organizationId?: string): Promise<{
  notifications: NotificationSummary[];
  unreadCount: number;
}> {
  return request(
    organizationId
      ? `/api/notifications?organizationId=${encodeURIComponent(organizationId)}`
      : '/api/notifications',
  );
}

export function markNotificationRead(notificationId: string): Promise<{ ok: true }> {
  return request(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'PATCH',
  });
}

export function markAllNotificationsRead(): Promise<{ ok: true }> {
  return request('/api/notifications/read-all', { method: 'POST' });
}

export async function uploadAttachment(
  pageId: string,
  file: File,
): Promise<{ attachment: AttachmentSummary }> {
  const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-rdocs-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `上传失败（${response.status}）`);
  }
  return (await response.json()) as { attachment: AttachmentSummary };
}

export function deleteAttachment(attachmentId: string): Promise<{ ok: true }> {
  return request(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
}

export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`;
}

export function updatePageTitle(
  pageId: string,
  title: string,
  options: { keepalive?: boolean } = {},
): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    keepalive: options.keepalive,
    body: JSON.stringify({ title }),
  });
}

export function movePage(
  pageId: string,
  input: { parentId: string | null; beforePageId?: string | null },
): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/move`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function copyPage(
  pageId: string,
  input: { parentId?: string | null; title?: string } = {},
): Promise<CreatePageResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/copy`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deletePage(
  pageId: string,
): Promise<{ ok: true; deletedAt: number; deletedCount: number }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`, { method: 'DELETE' });
}

export function listTrash(spaceId: string): Promise<{ pages: TrashedPageSummary[] }> {
  return request(`/api/spaces/${encodeURIComponent(spaceId)}/trash`);
}

export function restorePage(pageId: string): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/restore`, { method: 'POST' });
}

export function getPageAccess(
  pageId: string,
): Promise<{ mode: PageAccessMode; grants: PageGrantSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/access`);
}

export function updatePageAccessMode(
  pageId: string,
  mode: PageAccessMode,
): Promise<{ mode: PageAccessMode; grants: PageGrantSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/access`, {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
  });
}

export function putPageGrant(
  pageId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
  role: SpaceRole,
): Promise<{ mode: PageAccessMode; grants: PageGrantSummary[] }> {
  return request(
    `/api/pages/${encodeURIComponent(pageId)}/grants/${principalType}/${encodeURIComponent(principalId)}`,
    { method: 'PUT', body: JSON.stringify({ role }) },
  );
}

export function deletePageGrant(
  pageId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
): Promise<{ mode: PageAccessMode; grants: PageGrantSummary[] }> {
  return request(
    `/api/pages/${encodeURIComponent(pageId)}/grants/${principalType}/${encodeURIComponent(principalId)}`,
    { method: 'DELETE' },
  );
}

export function listRevisions(pageId: string): Promise<ListRevisionsResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/revisions`);
}

export function createRevision(
  pageId: string,
  label: string,
  description = '',
): Promise<CreateRevisionResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/revisions`, {
    method: 'POST',
    body: JSON.stringify({ label, description }),
  });
}

export function restoreRevision(
  revisionId: string,
  idempotencyKey: string,
): Promise<RestoreRevisionResponse> {
  return request(`/api/revisions/${encodeURIComponent(revisionId)}/restore`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function getRevisionSnapshot(revisionId: string): Promise<Uint8Array> {
  return binaryRequest(`/api/revisions/${encodeURIComponent(revisionId)}/snapshot`);
}

export function getCollabTicket(
  pageId: string,
  actor: { id: string; name: string },
): Promise<CollabTicketResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/collab-ticket`, {
    method: 'POST',
    body: JSON.stringify({ actorId: actor.id, displayName: actor.name }),
  });
}

export function getAuthSession(): Promise<AuthSessionResponse> {
  return request('/api/auth/session');
}

export function beginPasskeyRegistration(input: {
  email: string;
  displayName: string;
  enrollmentSecret?: string;
  invitationToken?: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  return request('/api/auth/passkey/registration/options', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function finishPasskeyRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
): Promise<{ verified: true }> {
  return request('/api/auth/passkey/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

export function beginPasskeyAuthentication(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  return request('/api/auth/passkey/authentication/options', { method: 'POST' });
}

export function finishPasskeyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ verified: true }> {
  return request('/api/auth/passkey/authentication/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

export function logout(): Promise<{ ok: true }> {
  return request('/api/auth/logout', { method: 'POST' });
}

export function listOrganizations(): Promise<{ organizations: OrganizationSummary[] }> {
  return request('/api/organizations');
}

export function createOrganization(input: {
  name: string;
  slug?: string;
}): Promise<{ organization: OrganizationSummary; space: SpaceSummary }> {
  return request('/api/organizations', { method: 'POST', body: JSON.stringify(input) });
}

export function updateOrganization(
  organizationId: string,
  input: { name?: string; slug?: string },
): Promise<{ organization: OrganizationSummary }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listOrganizationMembers(
  organizationId: string,
): Promise<{ members: OrganizationMemberSummary[] }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/members`);
}

export function listOrganizationActivity(
  organizationId: string,
): Promise<{ events: AuditEventSummary[] }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/activity`);
}

export function listGroups(organizationId: string): Promise<{ groups: GroupSummary[] }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/groups`);
}

export function createGroup(
  organizationId: string,
  input: { name: string; description?: string },
): Promise<{ group: GroupSummary }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/groups`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteGroup(organizationId: string, groupId: string): Promise<{ ok: true }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}`,
    { method: 'DELETE' },
  );
}

export function listGroupMembers(
  organizationId: string,
  groupId: string,
): Promise<{ members: OrganizationMemberSummary[] }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}/members`,
  );
}

export function setGroupMember(
  organizationId: string,
  groupId: string,
  userId: string,
  member: boolean,
): Promise<{ members: OrganizationMemberSummary[] }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    { method: member ? 'PUT' : 'DELETE' },
  );
}

export function createInvitation(
  organizationId: string,
  input: { email: string; role: 'admin' | 'member' | 'guest' },
): Promise<{ invitation: InvitationSummary; token: string; reused: boolean }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/invitations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function listInvitations(
  organizationId: string,
): Promise<{ invitations: InvitationSummary[] }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/invitations`);
}

export function revokeInvitation(
  organizationId: string,
  invitationId: string,
): Promise<{ ok: true; revokedAt: number }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE' },
  );
}

export function transferOrganizationOwnership(
  organizationId: string,
  userId: string,
): Promise<{ organization: OrganizationSummary }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export function acceptInvitation(token: string): Promise<{ organization: OrganizationSummary }> {
  return request(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' });
}

export function updateOrganizationMember(
  organizationId: string,
  userId: string,
  input: { role?: 'admin' | 'member' | 'guest'; status?: 'active' | 'suspended' },
): Promise<{ members: OrganizationMemberSummary[] }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function removeOrganizationMember(
  organizationId: string,
  userId: string,
): Promise<{ ok: true }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export function listSpaces(
  organizationId: string,
  includeArchived = false,
): Promise<{ spaces: SpaceSummary[] }> {
  return request(
    `/api/organizations/${encodeURIComponent(organizationId)}/spaces${includeArchived ? '?includeArchived=1' : ''}`,
  );
}

export function createSpace(
  organizationId: string,
  input: { name: string; slug?: string; icon?: string; visibility: SpaceVisibility },
): Promise<{ space: SpaceSummary }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/spaces`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateSpace(
  spaceId: string,
  input: {
    name?: string;
    slug?: string;
    icon?: string;
    visibility?: SpaceVisibility;
    archived?: boolean;
  },
): Promise<{ space: SpaceSummary }> {
  return request(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listSpaceGrants(spaceId: string): Promise<{ grants: SpaceGrantSummary[] }> {
  return request(`/api/spaces/${encodeURIComponent(spaceId)}/grants`);
}

export function putSpaceGrant(
  spaceId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
  role: SpaceRole,
): Promise<{ grants: SpaceGrantSummary[] }> {
  return request(
    `/api/spaces/${encodeURIComponent(spaceId)}/grants/${principalType}/${encodeURIComponent(principalId)}`,
    { method: 'PUT', body: JSON.stringify({ role }) },
  );
}

export function deleteSpaceGrant(
  spaceId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
): Promise<{ ok: true }> {
  return request(
    `/api/spaces/${encodeURIComponent(spaceId)}/grants/${principalType}/${encodeURIComponent(principalId)}`,
    { method: 'DELETE' },
  );
}
