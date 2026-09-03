import type {
  AuditEventSummary,
  AuthSessionResponse,
  AuthUserSummary,
  AttachmentSummary,
  CollabTicketResponse,
  CommentThreadSummary,
  CreatePageResponse,
  CreateRevisionResponse,
  DatabasePropertyGrantSummary,
  DatabasePropertySummary,
  DatabaseFormLinkSummary,
  DatabaseAutomationAction,
  DatabaseAutomationRunSummary,
  DatabaseAutomationSummary,
  DatabaseAutomationTrigger,
  DatabasePropertyType,
  DatabaseRowSummary,
  DatabaseSnapshot,
  DatabaseSummary,
  DatabaseTemplateSummary,
  DatabaseViewSummary,
  DatabaseViewType,
  FavoritePageResult,
  GroupSummary,
  InvitationSummary,
  ListPagesResponse,
  ListRevisionsResponse,
  NotificationGroupSummary,
  NotificationSummary,
  OrganizationAssignableRole,
  OrganizationMemberSummary,
  OrganizationSummary,
  PageAccessMode,
  PageBacklinkSummary,
  PageGrantRole,
  PageGrantSummary,
  PageLinkPreview,
  PageNotificationMode,
  PageNotificationSettings,
  PageReminderSourceType,
  PageReminderSummary,
  PageSearchSort,
  PageSearchResult,
  PageSummary,
  PageUpdateSummary,
  PublicDatabaseFormDefinition,
  ProjectWorkspaceSummary,
  RecentPageResult,
  RestoreRevisionResponse,
  ShareLinkRole,
  ShareLinkSummary,
  SiteAnalyticsDay,
  SiteSearchResult,
  SiteSummary,
  SpaceGrantPrincipalType,
  SpaceGrantRole,
  SpaceGrantSummary,
  SpaceRole,
  SpaceSummary,
  SpaceVisibility,
  SyncedBlockSummary,
  SyncedBlockReferenceSummary,
  TrashedPageSummary,
  JsonValue,
} from '@rdocs/shared';
import { ATTACHMENT_DIRECT_UPLOAD_BYTES, ATTACHMENT_PART_BYTES } from '@rdocs/shared';
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

export function createProjectWorkspace(
  spaceId: string,
  name = '项目中心',
): Promise<{ workspace: ProjectWorkspaceSummary }> {
  return request(`/api/spaces/${encodeURIComponent(spaceId)}/project-workspaces`, {
    method: 'POST',
    body: JSON.stringify({ name }),
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

async function downloadExport(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `导出失败（${response.status}）`);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const name = encodedName ? decodeURIComponent(encodedName) : fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportMarkdown(pageId: string): Promise<void> {
  await downloadExport(`/api/pages/${encodeURIComponent(pageId)}/export/markdown`, 'Rdocs.md');
}

export async function exportPageHtml(pageId: string): Promise<void> {
  await downloadExport(`/api/pages/${encodeURIComponent(pageId)}/export/html`, 'Rdocs.html');
}

export async function exportPagePdf(pageId: string): Promise<void> {
  await downloadExport(`/api/pages/${encodeURIComponent(pageId)}/export/pdf`, 'Rdocs.pdf');
}

export async function exportPageZip(pageId: string): Promise<void> {
  await downloadExport(`/api/pages/${encodeURIComponent(pageId)}/export/zip`, 'Rdocs.zip');
}

export async function importMarkdownZip(
  spaceId: string,
  file: File,
): Promise<{ imported: number; pages: PageSummary[] }> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/import/zip`, {
    method: 'POST',
    headers: { 'x-rdocs-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `导入失败（${response.status}）`);
  }
  return (await response.json()) as { imported: number; pages: PageSummary[] };
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
  options: {
    createdBy?: string;
    dateFrom?: number;
    dateTo?: number;
    inPageId?: string;
    sort?: PageSearchSort;
    spaceId?: string;
    titleOnly?: boolean;
  } = {},
): Promise<{ results: PageSearchResult[] }> {
  const parameters = new URLSearchParams({ organizationId, q: query });
  if (options.createdBy) parameters.set('createdBy', options.createdBy);
  if (options.dateFrom) parameters.set('dateFrom', String(options.dateFrom));
  if (options.dateTo) parameters.set('dateTo', String(options.dateTo));
  if (options.inPageId) parameters.set('inPageId', options.inPageId);
  if (options.sort) parameters.set('sort', options.sort);
  if (options.spaceId) parameters.set('spaceId', options.spaceId);
  if (options.titleOnly) parameters.set('titleOnly', '1');
  return request(`/api/search?${parameters.toString()}`);
}

export function listPageUpdates(organizationId: string): Promise<{ updates: PageUpdateSummary[] }> {
  return request(`/api/updates?organizationId=${encodeURIComponent(organizationId)}`);
}

export function listPageBacklinks(pageId: string): Promise<{ backlinks: PageBacklinkSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/backlinks`);
}

export function getPageLinkPreview(
  containerPageId: string,
  targetPageId: string,
): Promise<{ preview: PageLinkPreview }> {
  return request(
    `/api/pages/${encodeURIComponent(containerPageId)}/page-links/${encodeURIComponent(targetPageId)}/preview`,
  );
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
  input: { role: ShareLinkRole; expiresInDays: number | null },
): Promise<{ link: ShareLinkSummary; token: string }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/share-links`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function revokeShareLink(shareLinkId: string): Promise<{ ok: true; revokedAt: number }> {
  return request(`/api/share-links/${encodeURIComponent(shareLinkId)}`, { method: 'DELETE' });
}

export function getPageSite(pageId: string): Promise<{ site: SiteSummary | null }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/site`);
}

export function publishPageSite(
  pageId: string,
  input: { name: string; slug: string },
): Promise<{ site: SiteSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/site`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateSite(
  siteId: string,
  input: Partial<
    Pick<
      SiteSummary,
      | 'slug'
      | 'name'
      | 'theme'
      | 'faviconAttachmentId'
      | 'shareImageAttachmentId'
      | 'seoTitle'
      | 'seoDescription'
      | 'searchEnabled'
      | 'breadcrumbsEnabled'
      | 'watermarkEnabled'
      | 'searchEngineIndexing'
      | 'googleAnalyticsId'
    >
  >,
): Promise<{ site: SiteSummary }> {
  return request(`/api/sites/${encodeURIComponent(siteId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function unpublishSite(siteId: string): Promise<{ site: SiteSummary }> {
  return request(`/api/sites/${encodeURIComponent(siteId)}`, { method: 'DELETE' });
}

export function syncSitePages(siteId: string): Promise<{ site: SiteSummary }> {
  return request(`/api/sites/${encodeURIComponent(siteId)}/sync-pages`, { method: 'POST' });
}

export function updateSitePage(
  siteId: string,
  pageId: string,
  input: {
    slug?: string;
    isVisible?: boolean;
    inNavigation?: boolean;
    navigationLabel?: string | null;
    navigationOrder?: number;
  },
): Promise<{ site: SiteSummary }> {
  return request(`/api/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function getSiteAnalytics(siteId: string): Promise<{ days: SiteAnalyticsDay[] }> {
  return request(`/api/sites/${encodeURIComponent(siteId)}/analytics`);
}

export function getPublicSite(
  siteSlug: string,
  pageSlug?: string | null,
): Promise<{
  site: SiteSummary;
  currentPage: SiteSummary['pages'][number];
  ticket: string;
  expiresAt: number;
}> {
  const path = pageSlug
    ? `/api/public/sites/${encodeURIComponent(siteSlug)}/pages/${encodeURIComponent(pageSlug)}`
    : `/api/public/sites/${encodeURIComponent(siteSlug)}`;
  return request(path);
}

export function searchPublicSite(
  siteSlug: string,
  query: string,
): Promise<{ results: SiteSearchResult[] }> {
  return request(
    `/api/public/sites/${encodeURIComponent(siteSlug)}/search?q=${encodeURIComponent(query)}`,
  );
}

export function recordPublicSiteEvent(
  siteSlug: string,
  input: { type: 'page_view' | 'search'; pageId?: string; sessionId: string },
): Promise<{ ok: true }> {
  return request(`/api/public/sites/${encodeURIComponent(siteSlug)}/events`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPage(pageId: string): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`);
}

export async function getPageDatabase(pageId: string): Promise<DatabaseSnapshot | null> {
  const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/database`);
  if (response.status === 404) return null;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `数据库加载失败（${response.status}）`);
  }
  return (await response.json()) as DatabaseSnapshot;
}

export function createPageDatabase(
  pageId: string,
  titlePropertyName = '名称',
): Promise<DatabaseSnapshot> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/database`, {
    method: 'POST',
    body: JSON.stringify({ titlePropertyName }),
  });
}

export function getDatabase(databaseId: string): Promise<DatabaseSnapshot> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}`);
}

export function getArchivedDatabaseRows(databaseId: string): Promise<DatabaseSnapshot> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}?archived=true`);
}

export function listOrganizationDatabases(
  organizationId: string,
): Promise<{ databases: DatabaseSummary[] }> {
  return request(`/api/organizations/${encodeURIComponent(organizationId)}/databases`);
}

export function updateDatabase(
  databaseId: string,
  input: { title?: string; isLocked?: boolean },
): Promise<{ database: DatabaseSummary }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function createDatabaseProperty(
  databaseId: string,
  input: {
    name: string;
    type: DatabasePropertyType;
    config?: Record<string, JsonValue>;
  },
): Promise<{ property: DatabasePropertySummary }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/properties`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDatabaseProperty(
  databaseId: string,
  propertyId: string,
  input: { name?: string; config?: Record<string, JsonValue> },
): Promise<{ property: DatabasePropertySummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/properties/${encodeURIComponent(propertyId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function listDatabasePropertyGrants(
  databaseId: string,
  propertyId: string,
): Promise<{ grants: DatabasePropertyGrantSummary[] }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/properties/${encodeURIComponent(propertyId)}/grants`,
  );
}

export function putDatabasePropertyGrant(
  databaseId: string,
  propertyId: string,
  input: {
    principalType: 'user' | 'group' | 'organization';
    principalId: string;
    role: 'none' | 'viewer' | 'editor';
  },
): Promise<{ ok: true }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/properties/${encodeURIComponent(propertyId)}/grants`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function deleteDatabaseProperty(
  databaseId: string,
  propertyId: string,
): Promise<{ ok: true }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/properties/${encodeURIComponent(propertyId)}`,
    { method: 'DELETE' },
  );
}

export function createDatabaseView(
  databaseId: string,
  input: { name: string; type: DatabaseViewType; config?: Record<string, JsonValue> },
): Promise<{ view: DatabaseViewSummary }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/views`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDatabaseView(
  databaseId: string,
  viewId: string,
  input: {
    name?: string;
    type?: DatabaseViewType;
    config?: Record<string, JsonValue>;
  },
): Promise<{ view: DatabaseViewSummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/views/${encodeURIComponent(viewId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function deleteDatabaseView(databaseId: string, viewId: string): Promise<{ ok: true }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/views/${encodeURIComponent(viewId)}`,
    { method: 'DELETE' },
  );
}

export function listDatabaseFormLinks(
  databaseId: string,
): Promise<{ links: DatabaseFormLinkSummary[] }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/forms`);
}

export function createDatabaseFormLink(
  databaseId: string,
  viewId: string,
  expiresInDays: number | null,
): Promise<{ link: DatabaseFormLinkSummary; token: string; path: string }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/forms`, {
    method: 'POST',
    body: JSON.stringify({ viewId, expiresInDays }),
  });
}

export function revokeDatabaseFormLink(linkId: string): Promise<{ ok: true; revokedAt: number }> {
  return request(`/api/database-form-links/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}

export function getPublicDatabaseForm(
  token: string,
): Promise<{ form: PublicDatabaseFormDefinition }> {
  return request(`/api/public/forms/${encodeURIComponent(token)}`);
}

export function submitPublicDatabaseForm(
  token: string,
  values: Record<string, JsonValue>,
): Promise<{ ok: true; submissionId: string; message: string }> {
  return request(`/api/public/forms/${encodeURIComponent(token)}`, {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
}

export function createDatabaseRow(
  databaseId: string,
  values: Record<string, JsonValue>,
): Promise<{ row: DatabaseRowSummary }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/rows`, {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
}

export function updateDatabaseRow(
  databaseId: string,
  rowId: string,
  input: { values?: Record<string, JsonValue>; archived?: boolean },
): Promise<{ row?: DatabaseRowSummary; ok?: true; archived?: boolean }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/rows/${encodeURIComponent(rowId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function deleteDatabaseRow(
  databaseId: string,
  rowId: string,
): Promise<{ ok: true; archived: true }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/rows/${encodeURIComponent(rowId)}`,
    { method: 'DELETE' },
  );
}

export function duplicateDatabaseRow(
  databaseId: string,
  rowId: string,
): Promise<{ row: DatabaseRowSummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/rows/${encodeURIComponent(rowId)}/duplicate`,
    { method: 'POST' },
  );
}

export function executeDatabaseButton(
  databaseId: string,
  rowId: string,
  propertyId: string,
): Promise<{
  row?: DatabaseRowSummary;
  ok?: true;
  archived?: boolean;
  openUrl?: string;
}> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/rows/${encodeURIComponent(rowId)}/buttons/${encodeURIComponent(propertyId)}`,
    { method: 'POST' },
  );
}

export function listDatabaseAutomations(databaseId: string): Promise<{
  automations: DatabaseAutomationSummary[];
  runs: DatabaseAutomationRunSummary[];
}> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/automations`);
}

export function createDatabaseAutomation(
  databaseId: string,
  input: {
    name: string;
    triggerType: DatabaseAutomationTrigger;
    triggerConfig: Record<string, JsonValue>;
    actionType: DatabaseAutomationAction;
    actionConfig: Record<string, JsonValue>;
  },
): Promise<{ automation: DatabaseAutomationSummary }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/automations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDatabaseAutomation(
  databaseId: string,
  automationId: string,
  input: { name?: string; enabled?: boolean },
): Promise<{ automation: DatabaseAutomationSummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/automations/${encodeURIComponent(automationId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function deleteDatabaseAutomation(
  databaseId: string,
  automationId: string,
): Promise<{ ok: true }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/automations/${encodeURIComponent(automationId)}`,
    { method: 'DELETE' },
  );
}

export function runDatabaseAutomation(
  databaseId: string,
  automationId: string,
  rowId: string,
): Promise<{ run: DatabaseAutomationRunSummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/automations/${encodeURIComponent(automationId)}/run`,
    { method: 'POST', body: JSON.stringify({ rowId }) },
  );
}

export function createDatabaseTemplate(
  databaseId: string,
  input: { name: string; description?: string; sourceRowId: string; isDefault?: boolean },
): Promise<{ template: DatabaseTemplateSummary }> {
  return request(`/api/databases/${encodeURIComponent(databaseId)}/templates`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateDatabaseTemplate(
  databaseId: string,
  templateId: string,
  input: { name?: string; description?: string; isDefault?: boolean },
): Promise<{ template: DatabaseTemplateSummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/templates/${encodeURIComponent(templateId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function deleteDatabaseTemplate(
  databaseId: string,
  templateId: string,
): Promise<{ ok: true }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/templates/${encodeURIComponent(templateId)}`,
    { method: 'DELETE' },
  );
}

export function createDatabaseRowFromTemplate(
  databaseId: string,
  templateId: string,
  values: Record<string, JsonValue> = {},
): Promise<{ row: DatabaseRowSummary }> {
  return request(
    `/api/databases/${encodeURIComponent(databaseId)}/templates/${encodeURIComponent(templateId)}/rows`,
    { method: 'POST', body: JSON.stringify({ values }) },
  );
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

export type NotificationView = 'inbox' | 'unread' | 'archived';

export function listNotificationsView(
  organizationId: string | undefined,
  view: NotificationView,
): Promise<{
  notifications: NotificationSummary[];
  groups: NotificationGroupSummary[];
  unreadCount: number;
  resultCapReached: boolean;
}> {
  const query = new URLSearchParams({ view });
  if (organizationId) query.set('organizationId', organizationId);
  return request(`/api/notifications?${query.toString()}`);
}

export function updateNotifications(
  ids: string[],
  input: { read?: boolean; archived?: boolean },
): Promise<{ ok: true }> {
  return request('/api/notifications', {
    method: 'PATCH',
    body: JSON.stringify({ ids, ...input }),
  });
}

export function updateNotification(
  notificationId: string,
  input: { read?: boolean; archived?: boolean },
): Promise<{ ok: true }> {
  return request(`/api/notifications/${encodeURIComponent(notificationId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

function bulkNotificationAction(
  action: 'read-all' | 'archive-read' | 'archive-all',
  organizationId: string,
): Promise<{ ok: true }> {
  return request(`/api/notifications/${action}`, {
    method: 'POST',
    body: JSON.stringify({ organizationId }),
  });
}

export function markAllNotificationsRead(organizationId: string): Promise<{ ok: true }> {
  return bulkNotificationAction('read-all', organizationId);
}

export function archiveReadNotifications(organizationId: string): Promise<{ ok: true }> {
  return bulkNotificationAction('archive-read', organizationId);
}

export function archiveAllNotifications(organizationId: string): Promise<{ ok: true }> {
  return bulkNotificationAction('archive-all', organizationId);
}

export function getPageNotificationSettings(
  pageId: string,
): Promise<{ settings: PageNotificationSettings }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/notification-settings`);
}

export function setPageNotificationSettings(
  pageId: string,
  mode: PageNotificationMode,
): Promise<{ settings: PageNotificationSettings }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/notification-settings`, {
    method: 'PUT',
    body: JSON.stringify({ mode }),
  });
}

export function listPageReminders(
  pageId: string,
): Promise<{ reminders: PageReminderSummary[]; recipients: AuthUserSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/reminders`);
}

export interface PageReminderInput {
  recipientId: string;
  message: string;
  dueAt: number;
  remindAt: number;
  timezone: string;
  sourceType?: PageReminderSourceType;
  sourceId?: string | null;
}

export function createPageReminder(
  pageId: string,
  input: PageReminderInput,
): Promise<{ reminders: PageReminderSummary[]; recipients: AuthUserSummary[] }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/reminders`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePageReminder(
  reminderId: string,
  input: PageReminderInput,
): Promise<{ reminders: PageReminderSummary[]; recipients: AuthUserSummary[] }> {
  return request(`/api/reminders/${encodeURIComponent(reminderId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function cancelPageReminder(reminderId: string): Promise<{ ok: true }> {
  return request(`/api/reminders/${encodeURIComponent(reminderId)}`, { method: 'DELETE' });
}

export function cancelPageReminderSource(
  pageId: string,
  sourceType: 'inline' | 'database_date',
  sourceId: string,
): Promise<{ ok: true }> {
  const query = new URLSearchParams({ sourceType, sourceId });
  return request(`/api/pages/${encodeURIComponent(pageId)}/reminders/source?${query.toString()}`, {
    method: 'DELETE',
  });
}

async function readUploadResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
    const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(responseBody?.error ?? `上传失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

export async function uploadAttachment(
  pageId: string,
  file: File,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  options: { shareToken?: string } = {},
): Promise<{ attachment: AttachmentSummary }> {
  if (options.shareToken) {
    if (file.size > ATTACHMENT_DIRECT_UPLOAD_BYTES) {
      throw new Error('公开分享一次最多上传 8 MB 的附件');
    }
    onProgress?.(0, file.size);
    const response = await fetch(
      `/api/public/shares/${encodeURIComponent(options.shareToken)}/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-rdocs-file-name': encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    const result = await readUploadResponse<{ attachment: AttachmentSummary }>(response);
    onProgress?.(file.size, file.size);
    return result;
  }
  if (file.size <= ATTACHMENT_DIRECT_UPLOAD_BYTES) {
    onProgress?.(0, file.size);
    const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-rdocs-file-name': encodeURIComponent(file.name),
      },
      body: file,
    });
    const result = await readUploadResponse<{ attachment: AttachmentSummary }>(response);
    onProgress?.(file.size, file.size);
    return result;
  }

  const started = await readUploadResponse<{
    attachmentId: string;
    partSize: number;
  }>(
    await fetch(`/api/pages/${encodeURIComponent(pageId)}/attachments/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        byteSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        name: file.name,
      }),
    }),
  );

  const partSize = started.partSize || ATTACHMENT_PART_BYTES;
  const parts: Array<{ etag: string; partNumber: number }> = [];
  let uploaded = 0;
  onProgress?.(0, file.size);
  for (let start = 0, partNumber = 1; start < file.size; start += partSize, partNumber += 1) {
    const chunk = file.slice(start, Math.min(start + partSize, file.size));
    const part = await readUploadResponse<{ etag: string; partNumber: number }>(
      await fetch(
        `/api/pages/${encodeURIComponent(pageId)}/attachments/uploads/${encodeURIComponent(started.attachmentId)}/parts/${partNumber}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: chunk,
        },
      ),
    );
    parts.push(part);
    uploaded += chunk.size;
    onProgress?.(uploaded, file.size);
  }

  return readUploadResponse<{ attachment: AttachmentSummary }>(
    await fetch(
      `/api/pages/${encodeURIComponent(pageId)}/attachments/uploads/${encodeURIComponent(started.attachmentId)}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts }),
      },
    ),
  );
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
  options: { keepalive?: boolean; shareToken?: string } = {},
): Promise<{ page: PageSummary }> {
  if (options.shareToken) {
    return request(`/api/public/shares/${encodeURIComponent(options.shareToken)}`, {
      method: 'PATCH',
      keepalive: options.keepalive,
      body: JSON.stringify({ title }),
    });
  }
  return request(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    keepalive: options.keepalive,
    body: JSON.stringify({ title }),
  });
}

export function updatePageAppearance(
  pageId: string,
  input: {
    icon?: string | null;
    coverAttachmentId?: string | null;
    coverPosition?: 'top' | 'center' | 'bottom';
    fontStyle?: PageSummary['fontStyle'];
    isFullWidth?: boolean;
    isSmallText?: boolean;
    isLocked?: boolean;
  },
): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
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
  role: PageGrantRole,
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

export async function createSyncedBlock(
  pageId: string,
  snapshot?: Uint8Array,
): Promise<{ syncedBlock: SyncedBlockSummary }> {
  const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/synced-blocks`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: snapshot
      ? (snapshot.buffer.slice(
          snapshot.byteOffset,
          snapshot.byteOffset + snapshot.byteLength,
        ) as ArrayBuffer)
      : undefined,
  });
  const body = (await response.json().catch(() => null)) as
    { syncedBlock: SyncedBlockSummary } | { error?: string } | null;
  if (!response.ok) throw new Error(body && 'error' in body ? body.error : '同步块创建失败');
  return body as { syncedBlock: SyncedBlockSummary };
}

export function deleteOrphanSyncedBlock(blockId: string): Promise<{ ok: true }> {
  return request(`/api/synced-blocks/${encodeURIComponent(blockId)}/orphan`, {
    method: 'DELETE',
  });
}

export function getSyncedBlockTicket(
  pageId: string,
  blockId: string,
  actor: { name: string },
): Promise<CollabTicketResponse & { role: 'editor' | 'viewer'; syncedBlock: SyncedBlockSummary }> {
  return request(
    `/api/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(blockId)}/ticket`,
    { method: 'POST', body: JSON.stringify({ displayName: actor.name }) },
  );
}

export function getPublicSyncedBlockTicket(
  token: string,
  pageId: string,
  blockId: string,
): Promise<CollabTicketResponse & { role: 'viewer' }> {
  return request(
    `/api/public/shares/${encodeURIComponent(token)}/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(blockId)}/ticket`,
    { method: 'POST' },
  );
}

export function getPublicSiteSyncedBlockTicket(
  siteSlug: string,
  pageId: string,
  blockId: string,
): Promise<{
  ticket: string;
  expiresAt: number;
  generation: number;
  role: 'viewer';
  sourcePageId: string;
}> {
  return request(
    `/api/public/sites/${encodeURIComponent(siteSlug)}/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(blockId)}/ticket`,
    { method: 'POST' },
  );
}

export function listSyncedBlockReferences(
  pageId: string,
  blockId: string,
): Promise<{ references: SyncedBlockReferenceSummary[] }> {
  return request(
    `/api/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(blockId)}/references`,
  );
}

export function unsyncAllSyncedBlock(
  pageId: string,
  blockId: string,
): Promise<{ ok: true; mode: 'unsync'; pages: number; replacements: number }> {
  return request(
    `/api/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(blockId)}/unsync-all`,
    { method: 'POST' },
  );
}

export function deleteAllSyncedBlock(
  pageId: string,
  blockId: string,
): Promise<{
  ok: true;
  mode: 'delete';
  pages: number;
  replacements: number;
  deletion: { operationId: string; expiresAt: number };
}> {
  return request(
    `/api/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(blockId)}/delete-all`,
    { method: 'POST' },
  );
}

export function restoreDeletedSyncedBlock(
  operationId: string,
): Promise<{ ok: true; pages: number; replacements: number; syncedBlockId: string }> {
  return request(`/api/synced-block-deletions/${encodeURIComponent(operationId)}/restore`, {
    method: 'POST',
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
  input: { email: string; role: OrganizationAssignableRole },
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
  input: { role?: OrganizationAssignableRole; status?: 'active' | 'suspended' },
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
  role: SpaceGrantRole,
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

export function listApiTokens(organizationId: string) {
  return request<{ tokens: import('@rdocs/shared').ApiTokenSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/api-tokens`,
  );
}

export function createApiToken(
  organizationId: string,
  input: { name: string; scopes: import('@rdocs/shared').ApiTokenScope[] },
) {
  return request<{ token: import('@rdocs/shared').CreatedApiToken }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/api-tokens`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function revokeApiToken(organizationId: string, tokenId: string) {
  return request<{ ok: true }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/api-tokens/${encodeURIComponent(tokenId)}`,
    { method: 'DELETE' },
  );
}

export function createExportJob(
  organizationId: string,
  input: {
    kind: 'workspace' | 'space' | 'page';
    format: 'markdown' | 'json' | 'csv';
    scopeId?: string;
  },
) {
  return request<{ job: import('@rdocs/shared').ExportJobSummary }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/exports`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function listExportJobs(organizationId: string) {
  return request<{ jobs: import('@rdocs/shared').ExportJobSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/exports`,
  );
}

export function getEnterpriseSettings(organizationId: string) {
  return request<{ settings: import('@rdocs/shared').EnterpriseSettingsSummary }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/enterprise`,
  );
}

export function updateEnterpriseSettings(
  organizationId: string,
  input: Partial<import('@rdocs/shared').EnterpriseSettingsSummary> & {
    samlCertificate?: string;
    siemSecret?: string;
  },
) {
  return request<{ settings: import('@rdocs/shared').EnterpriseSettingsSummary }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/enterprise`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function createScimToken(organizationId: string) {
  return request<{ token: string; prefix: string }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/enterprise/scim-token`,
    { method: 'POST' },
  );
}

export function listLegalHolds(organizationId: string) {
  return request<{ holds: import('@rdocs/shared').LegalHoldSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/legal-holds`,
  );
}

export function createLegalHold(organizationId: string, input: { pageId: string; reason: string }) {
  return request<{ ok: true; id: string }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/legal-holds`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function releaseLegalHold(organizationId: string, holdId: string) {
  return request<{ ok: true }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/legal-holds/${encodeURIComponent(holdId)}`,
    { method: 'DELETE' },
  );
}

export function getAiSettings(organizationId: string) {
  return request<{ settings: import('@rdocs/shared').AiSettingsSummary }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/ai`,
  );
}

export function listCalendarConnections(organizationId: string) {
  return request<{ connections: import('@rdocs/shared').CalendarConnectionSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/calendar-connections`,
  );
}

export function createCalendarConnection(
  organizationId: string,
  input: { icsUrl: string; name?: string },
) {
  return request<{ id: string }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/calendar-connections`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function deleteCalendarConnection(organizationId: string, connectionId: string) {
  return request<{ ok: true }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/calendar-connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
  );
}

export function listCalendarEvents(organizationId: string, connectionId: string) {
  return request<{ events: import('@rdocs/shared').CalendarEventSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/calendar-connections/${encodeURIComponent(connectionId)}/events`,
  );
}

export async function transcribePageAudio(pageId: string, file: File): Promise<{ text: string }> {
  const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/transcribe`, {
    method: 'POST',
    body: (() => {
      const form = new FormData();
      form.set('file', file, file.name);
      return form;
    })(),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    text?: string;
  } | null;
  if (!response.ok || !body?.text) {
    if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
    throw new Error(body?.error ?? `转写失败（${response.status}）`);
  }
  return { text: body.text };
}

export async function runWorkspaceAi(organizationId: string, input: { prompt: string }) {
  const response = await fetch(
    `/api/organizations/${encodeURIComponent(organizationId)}/ai/research`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    job?: import('@rdocs/shared').AiJobSummary;
    error?: string;
  } | null;
  if (body?.job) return { job: body.job };
  if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
  throw new Error(body?.error ?? `AI 请求失败（${response.status}）`);
}

export function autofillDatabaseProperty(
  databaseId: string,
  input: { propertyId: string; prompt?: string },
) {
  return request<{ updated: number; job: import('@rdocs/shared').AiJobSummary }>(
    `/api/databases/${encodeURIComponent(databaseId)}/ai/autofill`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function runPageAi(
  pageId: string,
  input: {
    kind: import('@rdocs/shared').AiJobKind;
    prompt: string;
    selection?: string;
    pageExcerpt?: string;
  },
) {
  const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as {
    job?: import('@rdocs/shared').AiJobSummary;
    error?: string;
  } | null;
  if (body?.job) return { job: body.job };
  if (response.status === 401) window.dispatchEvent(new Event('rdocs:auth-required'));
  throw new Error(body?.error ?? `AI 请求失败（${response.status}）`);
}

export function listSessions() {
  return request<{ sessions: import('@rdocs/shared').SessionSummary[] }>('/api/me/sessions');
}

export function revokeSession(sessionId: string) {
  return request<{ ok: true }>(`/api/me/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export function listDevices() {
  return request<{ devices: import('@rdocs/shared').DeviceSummary[] }>('/api/me/devices');
}

export function revokeDevice(credentialId: string) {
  return request<{ ok: true }>(`/api/me/devices/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
  });
}

export function listWorkspaceTemplates(organizationId: string) {
  return request<{ templates: import('@rdocs/shared').WorkspaceTemplateSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/templates`,
  );
}

export function publishWorkspaceTemplate(
  organizationId: string,
  input: { description?: string; name: string; pageId: string },
) {
  return request<{ id: string }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/templates`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function instantiateWorkspaceTemplate(templateId: string) {
  return request<{ sourcePageId: string; spaceId: string; title: string }>(
    `/api/templates/${encodeURIComponent(templateId)}/instantiate`,
    { method: 'POST' },
  );
}

export function listWorkspaceSkills(organizationId: string) {
  return request<{ skills: import('@rdocs/shared').WorkspaceSkillSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/skills`,
  );
}

export function createWorkspaceSkill(
  organizationId: string,
  input: { name: string; prompt: string },
) {
  return request<{ id: string }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/skills`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function deleteWorkspaceSkill(organizationId: string, skillId: string) {
  return request<{ ok: true }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/skills/${encodeURIComponent(skillId)}`,
    { method: 'DELETE' },
  );
}

export function getNotificationPreferences(organizationId: string) {
  return request<{ preferences: import('@rdocs/shared').NotificationPreferences }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/notification-preferences`,
  );
}

export function updateNotificationPreferences(
  organizationId: string,
  input: Partial<import('@rdocs/shared').NotificationPreferences>,
) {
  return request<{ preferences: import('@rdocs/shared').NotificationPreferences }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/notification-preferences`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function listDirectory(organizationId: string, query = '') {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  return request<{ people: import('@rdocs/shared').DirectoryPerson[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/directory${suffix}`,
  );
}

export function listOAuthApps(organizationId: string) {
  return request<{ apps: import('@rdocs/shared').OAuthAppSummary[] }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/oauth-apps`,
  );
}

export function createOAuthApp(
  organizationId: string,
  input: { name: string; redirectUri: string },
) {
  return request<{ clientId: string; clientSecret: string; id: string }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/oauth-apps`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function getLinkedDatabase(pageId: string) {
  return request<{ databaseId: string | null }>(
    `/api/pages/${encodeURIComponent(pageId)}/linked-database`,
  );
}

export function setLinkedDatabase(pageId: string, databaseId: string) {
  return request<{ databaseId: string }>(
    `/api/pages/${encodeURIComponent(pageId)}/linked-database`,
    {
      method: 'PUT',
      body: JSON.stringify({ databaseId }),
    },
  );
}

export async function importDatabaseCsv(
  databaseId: string,
  file: File,
): Promise<{ imported: number }> {
  const response = await fetch(`/api/databases/${encodeURIComponent(databaseId)}/import/csv`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv; charset=utf-8' },
    body: await file.text(),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    imported?: number;
  } | null;
  if (!response.ok) throw new Error(body?.error ?? `导入失败（${response.status}）`);
  return { imported: body?.imported ?? 0 };
}

export function listOfflinePins(organizationId: string) {
  return request<{ pins: import('@rdocs/shared').OfflinePinSummary[] }>(
    `/api/offline-pins?organizationId=${encodeURIComponent(organizationId)}`,
  );
}

export function setOfflinePin(pageId: string, pinned: boolean) {
  return request<{ ok: true }>(`/api/pages/${encodeURIComponent(pageId)}/offline-pin`, {
    method: pinned ? 'PUT' : 'DELETE',
  });
}

export function addSiteDomain(siteId: string, hostname: string) {
  return request<{ domain: import('@rdocs/shared').SiteDomainSummary }>(
    `/api/sites/${encodeURIComponent(siteId)}/domains`,
    { method: 'POST', body: JSON.stringify({ hostname }) },
  );
}

export function verifySiteDomain(siteId: string, domainId: string) {
  return request<{ domains: import('@rdocs/shared').SiteDomainSummary[] }>(
    `/api/sites/${encodeURIComponent(siteId)}/domains/${encodeURIComponent(domainId)}/verify`,
    { method: 'POST' },
  );
}

export function publishSiteDatabaseView(
  siteId: string,
  input: { databaseId: string; viewId: string; published?: boolean },
) {
  return request<{ site: import('@rdocs/shared').SiteSummary }>(
    `/api/sites/${encodeURIComponent(siteId)}/database-views`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}
