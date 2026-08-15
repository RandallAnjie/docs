import appHtml from '../../web/dist/index.html';

import {
  EDITOR_SCHEMA_VERSION,
  isPageId,
  MAX_HTTP_SYNC_BODY_BYTES,
  MAX_REVISION_SNAPSHOT_BYTES,
  type AuthUserSummary,
  type AttachmentSummary,
  type FavoritePageResult,
  type OrganizationRole,
  type PageSearchResult,
  type PageSummary,
  type RecentPageResult,
  type RevisionKind,
  type RevisionSummary,
  type ShareLinkSummary,
  type SpaceGrantPrincipalType,
  type SpaceRole,
  type TrashedPageSummary,
} from '@rdocs/shared';

import { DocumentRoom } from './document-room';
import type { Env } from './env';
import {
  requirePageAction as requireEffectivePageAction,
  requireDeletedPageAction,
  requireSpaceAction,
  type SpaceAction,
} from './access';
import { authenticateRequest, handleAuthApi, isTrustedMutationOrigin } from './auth';
import { handleCommentsAndNotificationsApi } from './comments';
import { handleDatabasesApi, handlePublicDatabaseFormsApi } from './databases';
import {
  cacheCollaborationPage,
  getCachedCollaborationPage,
  invalidateCollaborationPage,
} from './collaboration-access-cache';
import { isCollaborationOriginAllowed } from './origins';
import {
  markdownToYjsSnapshot,
  rewriteYjsAttachmentReferences,
  yjsSnapshotToMarkdown,
} from './markdown';
import { listPages } from './page-tree';
import { pageAccessSnapshot } from './page-access';
import { ftsMatchQuery, normalizeSearchText, searchIndexText } from './search-projection';
import { handleTenancyApi } from './tenancy';
import { signCollabTicket, verifyCollabTicket } from './tickets';

export { DocumentRoom };

const MAX_TITLE_LENGTH = 200;
const SYSTEM_USER_ID = 'usr_phase0_system';
const MAX_REVISION_LABEL_LENGTH = 100;
const MAX_REVISION_DESCRIPTION_LENGTH = 500;
const MAX_PAGE_TREE_SIZE = 500;
const MAX_REVISIONS_PER_PAGE = 100;
const MAX_GENERATION_INITIALIZATION_ATTEMPTS = 5;
const RESTORE_OPERATION_LEASE_MS = 60_000;
const COLLAB_AUTH_CACHE_MS = 2_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_NAME_LENGTH = 180;
const MAX_MARKDOWN_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_COPY_ATTACHMENTS = 200;
const MAX_PAGE_COPY_ATTACHMENT_BYTES = 250 * 1024 * 1024;

interface PageRow {
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  current_generation: number;
  editor_schema_version: number;
  updated_at: number;
  collaboration_enabled: number;
  acl_version: number;
}

interface TrashedPageRow extends PageRow {
  deleted_at: number;
}

interface SearchPageRow extends PageRow {
  normalized_body: string;
}

interface ActivityPageRow extends PageRow {
  activity_at: number;
}

interface AttachmentRow {
  id: string;
  organization_id: string;
  page_id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  status: 'pending' | 'ready' | 'quarantined' | 'deleted';
  created_by: string;
  created_at: number;
  deleted_at: number | null;
}

interface ShareLinkRow {
  id: string;
  organization_id: string;
  page_id: string;
  token_hash: string;
  role: 'viewer' | 'commenter';
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

interface RevisionRow {
  id: string;
  page_id: string;
  generation: number;
  collab_seq: number;
  kind: RevisionKind;
  label: string | null;
  description: string | null;
  snapshot_location: 'do' | 'r2';
  snapshot_ref: string;
  content_hash: string;
  created_by: string | null;
  created_at: number;
}

interface RestoreOperationRow {
  idempotency_key: string;
  organization_id: string;
  page_id: string;
  revision_id: string;
  actor_id: string | null;
  source_generation: number;
  target_generation: number | null;
  previous_revision_id: string;
  status: 'pending' | 'prepared' | 'completed' | 'failed';
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, { status });
}

function pageFromRow(row: PageRow): PageSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    currentGeneration: Number(row.current_generation),
    editorSchemaVersion: Number(row.editor_schema_version),
    updatedAt: Number(row.updated_at),
    collaborationEnabled: Boolean(row.collaboration_enabled),
    aclVersion: Number(row.acl_version),
  };
}

function trashedPageFromRow(row: TrashedPageRow): TrashedPageSummary {
  return { ...pageFromRow(row), deletedAt: Number(row.deleted_at) };
}

function revisionFromRow(row: RevisionRow): RevisionSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    generation: Number(row.generation),
    collabSeq: Number(row.collab_seq),
    kind: row.kind,
    label: row.label,
    description: row.description,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function documentRoom(env: Env, pageId: string, generation: number): DurableObjectStub {
  return env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${generation}`),
  );
}

async function findPage(env: Env, pageId: string): Promise<PageSummary | null> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
            p.current_generation, p.editor_schema_version, p.updated_at,
            a.collaboration_enabled, a.acl_version
       FROM pages p
       JOIN page_access_state a ON a.page_id = p.id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(pageId)
    .first<PageRow>();
  return row ? pageFromRow(row) : null;
}

async function isDatabaseRowPage(env: Env, pageId: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare('SELECT 1 AS found FROM database_rows WHERE page_id = ?')
      .bind(pageId)
      .first<{ found: number }>(),
  );
}

async function requirePageAction(
  env: Env,
  pageId: string,
  userId: string,
  action: SpaceAction,
): Promise<{ page: PageSummary; role: 'space_admin' | 'editor' | 'commenter' | 'viewer' } | null> {
  const page = await findPage(env, pageId);
  if (!page) return null;
  const access = await requireEffectivePageAction(env, pageId, userId, action);
  if (!access || access.organizationId !== page.organizationId) return null;
  return { page, role: access.spaceRole };
}

function escapedLike(value: string): string {
  return `%${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

function searchSnippet(body: string, query: string): string {
  if (!body) return '只匹配到页面标题';
  const index = body.indexOf(query);
  const start = Math.max(0, index < 0 ? 0 : index - 55);
  const end = Math.min(body.length, index < 0 ? 120 : index + query.length + 75);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

async function searchPages(
  env: Env,
  organizationId: string,
  actorId: string,
  rawQuery: string,
): Promise<Response> {
  const membership = await env.DB.prepare(
    `SELECT 1 AS found FROM organization_members
      WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
  )
    .bind(organizationId, actorId)
    .first<{ found: number }>();
  if (!membership) return error('组织不存在或无权搜索', 404);
  const query = normalizeSearchText(rawQuery).slice(0, 100);
  if (!query) return json({ results: [] });
  const like = escapedLike(query);
  const match = ftsMatchQuery(query);
  const baseSql = `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
                          p.current_generation, p.editor_schema_version, p.updated_at,
                          a.collaboration_enabled, a.acl_version,
                          projection.normalized_body
                     FROM page_search_projection projection
                     JOIN pages p ON p.id = projection.page_id
                     JOIN page_access_state a ON a.page_id = p.id
                    WHERE projection.organization_id = ? AND p.deleted_at IS NULL
                      AND (LOWER(p.title) LIKE ? ESCAPE '\\'
                           OR projection.normalized_body LIKE ? ESCAPE '\\'`;
  const statement = match
    ? env.DB.prepare(
        `${baseSql}
          OR p.id IN (
            SELECT page_id FROM page_search_fts WHERE page_search_fts MATCH ?
          )) ORDER BY p.updated_at DESC LIMIT 100`,
      ).bind(organizationId, like, like, match)
    : env.DB.prepare(`${baseSql}) ORDER BY p.updated_at DESC LIMIT 100`).bind(
        organizationId,
        like,
        like,
      );
  let rows: SearchPageRow[];
  try {
    rows = (await statement.all<SearchPageRow>()).results;
  } catch {
    rows = (
      await env.DB.prepare(`${baseSql}) ORDER BY p.updated_at DESC LIMIT 100`)
        .bind(organizationId, like, like)
        .all<SearchPageRow>()
    ).results;
  }
  const results: PageSearchResult[] = [];
  for (const row of rows) {
    const access = await requireEffectivePageAction(env, row.id, actorId, 'view');
    if (!access) continue;
    results.push({
      page: { ...pageFromRow(row), role: access.spaceRole },
      snippet: searchSnippet(row.normalized_body, query),
    });
    if (results.length >= 30) break;
  }
  return json({ results });
}

async function listPageActivity(
  env: Env,
  organizationId: string,
  actorId: string,
  kind: 'recent' | 'favorites',
): Promise<Response> {
  const membership = await env.DB.prepare(
    `SELECT 1 AS found FROM organization_members
      WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
  )
    .bind(organizationId, actorId)
    .first<{ found: number }>();
  if (!membership) return error('组织不存在或无权访问', 404);
  const activityTable = kind === 'recent' ? 'page_visits' : 'favorites';
  const activityColumn = kind === 'recent' ? 'visited_at' : 'created_at';
  const rows = (
    await env.DB.prepare(
      `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
              p.current_generation, p.editor_schema_version, p.updated_at,
              a.collaboration_enabled, a.acl_version,
              activity.${activityColumn} AS activity_at
         FROM ${activityTable} activity
         JOIN pages p ON p.id = activity.page_id
         JOIN page_access_state a ON a.page_id = p.id
        WHERE activity.user_id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
        ORDER BY activity.${activityColumn} DESC LIMIT 50`,
    )
      .bind(actorId, organizationId)
      .all<ActivityPageRow>()
  ).results;
  const recent: RecentPageResult[] = [];
  const favorites: FavoritePageResult[] = [];
  for (const row of rows) {
    const access = await requireEffectivePageAction(env, row.id, actorId, 'view');
    if (!access) continue;
    const page = { ...pageFromRow(row), role: access.spaceRole };
    if (kind === 'recent') recent.push({ page, visitedAt: Number(row.activity_at) });
    else favorites.push({ page, favoritedAt: Number(row.activity_at) });
  }
  return json(kind === 'recent' ? { pages: recent } : { pages: favorites });
}

async function recordPageVisit(env: Env, pageId: string, actorId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO page_visits(user_id, page_id, visited_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, page_id) DO UPDATE SET visited_at = excluded.visited_at`,
  )
    .bind(actorId, pageId, Date.now())
    .run();
}

async function setFavorite(
  env: Env,
  page: PageSummary,
  actorId: string,
  favorite: boolean,
): Promise<Response> {
  if (favorite) {
    await env.DB.prepare(
      `INSERT INTO favorites(user_id, page_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, page_id) DO NOTHING`,
    )
      .bind(actorId, page.id, Date.now())
      .run();
  } else {
    await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND page_id = ?')
      .bind(actorId, page.id)
      .run();
  }
  return json({ ok: true, favorite });
}

async function updateSearchProjectionTitle(env: Env, pageId: string, title: string): Promise<void> {
  let current = await env.DB.prepare(
    `SELECT organization_id, space_id, generation, collab_seq, normalized_body
       FROM page_search_projection WHERE page_id = ?`,
  )
    .bind(pageId)
    .first<{
      organization_id: string;
      space_id: string;
      generation: number;
      collab_seq: number;
      normalized_body: string;
    }>();
  if (!current) {
    const page = await env.DB.prepare(
      `SELECT organization_id, space_id, current_generation
         FROM pages WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(pageId)
      .first<{ organization_id: string; space_id: string; current_generation: number }>();
    if (!page) return;
    current = {
      organization_id: page.organization_id,
      space_id: page.space_id,
      generation: Number(page.current_generation),
      collab_seq: 0,
      normalized_body: '',
    };
    await env.DB.prepare(
      `INSERT INTO page_search_projection(
         page_id, organization_id, space_id, generation, collab_seq,
         title, normalized_body, updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, '', ?)`,
    )
      .bind(pageId, page.organization_id, page.space_id, page.current_generation, title, Date.now())
      .run();
  }
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE page_search_projection SET title = ?, updated_at = ? WHERE page_id = ?',
    ).bind(title, Date.now(), pageId),
    env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(pageId),
    env.DB.prepare(
      'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
    ).bind(pageId, searchIndexText(title), searchIndexText(`${title}\n${current.normalized_body}`)),
  ]);
}

function attachmentFromRow(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    status: row.status,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function safeAttachmentName(value: string): string | null {
  const name = value
    .normalize('NFKC')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '-')
    .trim()
    .slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  return name && name !== '.' && name !== '..' ? name : null;
}

function safeAttachmentType(value: string | null): string {
  const type = (value ?? 'application/octet-stream').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    return 'application/octet-stream';
  }
  if (
    type === 'text/html' ||
    type === 'image/svg+xml' ||
    type === 'application/javascript' ||
    type === 'text/javascript'
  ) {
    return 'application/octet-stream';
  }
  return type;
}

async function listAttachments(env: Env, page: PageSummary): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, organization_id, page_id, r2_key, original_name, mime_type,
              byte_size, sha256, status, created_by, created_at, deleted_at
         FROM attachments
        WHERE organization_id = ? AND page_id = ? AND status = 'ready' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 200`,
    )
      .bind(page.organizationId, page.id)
      .all<AttachmentRow>()
  ).results;
  return json({ attachments: rows.map(attachmentFromRow) });
}

async function uploadAttachment(
  request: Request,
  env: Env,
  page: PageSummary,
  actorId: string,
): Promise<Response> {
  const encodedName = request.headers.get('x-rdocs-file-name') ?? '';
  let decodedName = encodedName;
  try {
    decodedName = decodeURIComponent(encodedName);
  } catch {
    return error('附件名编码无效', 400);
  }
  const name = safeAttachmentName(decodedName);
  if (!name) return error('附件名无效', 400);
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_ATTACHMENT_BYTES) return error('附件超过 25 MB 上限', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) return error('附件不能为空', 400);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return error('附件超过 25 MB 上限', 413);
  const id = crypto.randomUUID();
  const mimeType = safeAttachmentType(request.headers.get('content-type'));
  const digest = await sha256Hex(bytes);
  const r2Key = `organizations/${page.organizationId}/pages/${page.id}/attachments/${id}`;
  const now = Date.now();
  await env.ATTACHMENTS.put(r2Key, toArrayBuffer(bytes), {
    httpMetadata: { contentType: mimeType },
    customMetadata: { pageId: page.id, originalName: name, sha256: digest },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO attachments(
         id, organization_id, page_id, r2_key, original_name, mime_type,
         byte_size, sha256, status, created_by, created_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL)`,
    )
      .bind(
        id,
        page.organizationId,
        page.id,
        r2Key,
        name,
        mimeType,
        bytes.byteLength,
        digest,
        actorId,
        now,
      )
      .run();
  } catch (reason) {
    await env.ATTACHMENTS.delete(r2Key).catch(() => undefined);
    throw reason;
  }
  await pageAudit(env, page, actorId, 'attachment.created', {
    attachmentId: id,
    byteSize: bytes.byteLength,
    mimeType,
  });
  return json(
    {
      attachment: attachmentFromRow({
        id,
        organization_id: page.organizationId,
        page_id: page.id,
        r2_key: r2Key,
        original_name: name,
        mime_type: mimeType,
        byte_size: bytes.byteLength,
        sha256: digest,
        status: 'ready',
        created_by: actorId,
        created_at: now,
        deleted_at: null,
      }),
    },
    { status: 201 },
  );
}

async function findAttachment(env: Env, attachmentId: string): Promise<AttachmentRow | null> {
  return env.DB.prepare(
    `SELECT id, organization_id, page_id, r2_key, original_name, mime_type,
            byte_size, sha256, status, created_by, created_at, deleted_at
       FROM attachments WHERE id = ?`,
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
}

async function downloadAttachment(env: Env, attachment: AttachmentRow): Promise<Response> {
  if (attachment.status !== 'ready' || attachment.deleted_at !== null) {
    return error('附件不存在', 404);
  }
  const object = await env.ATTACHMENTS.get(attachment.r2_key);
  if (!object) return error('附件对象丢失', 500);
  return new Response(object.body, {
    headers: {
      'content-type': attachment.mime_type,
      'content-length': String(attachment.byte_size),
      'content-disposition': `${attachment.mime_type.startsWith('image/') ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function deleteAttachment(
  env: Env,
  attachment: AttachmentRow,
  page: PageSummary,
  actorId: string,
): Promise<Response> {
  const deletedAt = Date.now();
  await env.DB.prepare(
    `UPDATE attachments SET status = 'deleted', deleted_at = ?
      WHERE id = ? AND status <> 'deleted'`,
  )
    .bind(deletedAt, attachment.id)
    .run();
  await pageAudit(env, page, actorId, 'attachment.deleted', {
    attachmentId: attachment.id,
    retainedObject: true,
  });
  return json({ ok: true });
}

function shareLinkFromRow(row: ShareLinkRow): ShareLinkSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    role: row.role,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function randomShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function shareTokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function publicShareTokens(request: Request): string[] {
  const value = cookieValue(request, 'rdocs_public_shares');
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((token): token is string => typeof token === 'string' && token.length <= 512)
          .slice(-5)
      : [];
  } catch {
    return [];
  }
}

async function canPubliclyDownloadAttachment(
  request: Request,
  env: Env,
  attachment: AttachmentRow,
): Promise<boolean> {
  const now = Date.now();
  for (const token of publicShareTokens(request)) {
    const share = await env.DB.prepare(
      `SELECT 1 AS found FROM share_links
        WHERE page_id = ? AND token_hash = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    )
      .bind(attachment.page_id, await shareTokenHash(token), now)
      .first<{ found: number }>();
    if (share) return true;
  }
  return false;
}

async function listShareLinks(env: Env, page: PageSummary): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, organization_id, page_id, token_hash, role, expires_at,
              revoked_at, created_by, created_at
         FROM share_links WHERE page_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(page.id)
      .all<ShareLinkRow>()
  ).results;
  return json({ links: rows.map(shareLinkFromRow) });
}

async function createShareLink(
  request: Request,
  env: Env,
  page: PageSummary,
  actorId: string,
): Promise<Response> {
  const input = (await request.json().catch(() => null)) as {
    role?: unknown;
    expiresInDays?: unknown;
  } | null;
  const role = input?.role ?? 'viewer';
  if (role !== 'viewer') return error('当前仅支持只读公开分享', 400);
  const expiresInDays = input?.expiresInDays;
  if (
    expiresInDays !== null &&
    (typeof expiresInDays !== 'number' ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > 365)
  ) {
    return error('分享链接有效期必须为 1–365 天', 400);
  }
  const id = crypto.randomUUID();
  const token = randomShareToken();
  const now = Date.now();
  const expiresAt = expiresInDays === null ? null : now + Number(expiresInDays ?? 7) * 86_400_000;
  await env.DB.prepare(
    `INSERT INTO share_links(
       id, organization_id, page_id, token_hash, role, expires_at,
       revoked_at, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      id,
      page.organizationId,
      page.id,
      await shareTokenHash(token),
      role,
      expiresAt,
      actorId,
      now,
    )
    .run();
  await pageAudit(env, page, actorId, 'share_link.created', {
    shareLinkId: id,
    role,
    expiresAt,
  });
  return json(
    {
      link: {
        id,
        pageId: page.id,
        role,
        expiresAt,
        revokedAt: null,
        createdBy: actorId,
        createdAt: now,
      } satisfies ShareLinkSummary,
      token,
    },
    { status: 201 },
  );
}

async function revokeShareLink(
  env: Env,
  page: PageSummary,
  shareLinkId: string,
  actorId: string,
  context: ExecutionContext,
): Promise<Response> {
  const revokedAt = Date.now();
  const result = await env.DB.prepare(
    `UPDATE share_links SET revoked_at = ?
      WHERE id = ? AND page_id = ? AND revoked_at IS NULL`,
  )
    .bind(revokedAt, shareLinkId, page.id)
    .run();
  if (!result.meta.changes) return error('有效分享链接不存在', 404);
  await pageAudit(env, page, actorId, 'share_link.revoked', { shareLinkId });
  await bumpPageSubtreeAcl(env, page.id, context);
  return json({ ok: true, revokedAt });
}

async function resolvePublicShare(request: Request, env: Env, token: string): Promise<Response> {
  if (!token || token.length > 512) return error('分享链接无效', 404);
  const now = Date.now();
  const share = await env.DB.prepare(
    `SELECT id, organization_id, page_id, token_hash, role, expires_at,
            revoked_at, created_by, created_at
       FROM share_links
      WHERE token_hash = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(await shareTokenHash(token), now)
    .first<ShareLinkRow>();
  if (!share) return error('分享链接不存在、已过期或已撤销', 404);
  const page = await findPage(env, share.page_id);
  if (!page || !page.collaborationEnabled) return error('分享页面已不可用', 404);
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) {
    return error('协作服务尚未配置', 503);
  }
  const expiresAt = Math.min(now + 5 * 60 * 1_000, share.expires_at ?? Number.MAX_SAFE_INTEGER);
  const ticket = await signCollabTicket(
    {
      version: 1,
      pageId: page.id,
      generation: page.currentGeneration,
      actorId: `share_${share.id}`,
      displayName: '外部只读',
      role: 'viewer',
      aclVersion: page.aclVersion,
      issuedAt: now,
      expiresAt,
    },
    env.COLLAB_TICKET_SECRET,
  );
  const rememberedTokens = [
    ...publicShareTokens(request).filter((candidate) => candidate !== token),
    token,
  ].slice(-5);
  return json(
    {
      page: { ...page, role: 'viewer' },
      share: shareLinkFromRow(share),
      ticket,
      expiresAt,
      requestedFrom: new URL(request.url).origin,
    },
    {
      headers: {
        'set-cookie': `rdocs_public_shares=${encodeURIComponent(JSON.stringify(rememberedTokens))}; Path=/api/attachments/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`,
      },
    },
  );
}

async function captureRevision(
  env: Env,
  page: PageSummary,
  options: {
    kind: RevisionKind;
    label: string | null;
    description: string | null;
    revisionId?: string;
    createdBy?: string;
  },
): Promise<RevisionSummary> {
  if (options.revisionId) {
    const existing = await findRevision(env, options.revisionId);
    if (existing) return revisionFromRow(existing);
  }

  const snapshotResponse = await documentRoom(env, page.id, page.currentGeneration).fetch(
    'https://rdocs.internal/internal/export-snapshot',
    {
      method: 'POST',
      headers: { 'x-rdocs-actor-id': SYSTEM_USER_ID },
    },
  );
  if (!snapshotResponse.ok) {
    throw new Error(`revision_snapshot_export_${snapshotResponse.status}`);
  }

  const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
  if (snapshot.byteLength === 0 || snapshot.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
    throw new Error('revision_snapshot_size');
  }
  const collabSeq = Number(snapshotResponse.headers.get('x-rdocs-snapshot-seq') ?? -1);
  if (!Number.isSafeInteger(collabSeq) || collabSeq < 0) {
    throw new Error('revision_snapshot_seq');
  }
  const contentHash = await sha256Hex(snapshot);
  const exportedHash = snapshotResponse.headers.get('x-rdocs-content-hash');
  if (exportedHash !== contentHash) throw new Error('revision_snapshot_hash');

  const revisionId = options.revisionId ?? crypto.randomUUID();
  const createdBy = options.createdBy ?? SYSTEM_USER_ID;
  const snapshotRef = `organizations/${page.organizationId}/pages/${page.id}/revisions/${revisionId}.yjs`;
  const createdAt = Date.now();
  await env.ATTACHMENTS.put(snapshotRef, toArrayBuffer(snapshot), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      pageId: page.id,
      generation: String(page.currentGeneration),
      collabSeq: String(collabSeq),
      contentHash,
    },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO revisions(
          id, organization_id, page_id, generation, collab_seq, kind,
          label, description, snapshot_location, snapshot_ref, content_hash,
          created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'r2', ?, ?, ?, ?)`,
      ).bind(
        revisionId,
        page.organizationId,
        page.id,
        page.currentGeneration,
        collabSeq,
        options.kind,
        options.label,
        options.description,
        snapshotRef,
        contentHash,
        createdBy,
        createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events(
           id, organization_id, actor_id, event_type, target_type, target_id,
           request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'revision.created', 'page', ?, NULL, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        page.organizationId,
        createdBy,
        page.id,
        JSON.stringify({ revisionId, kind: options.kind, generation: page.currentGeneration }),
        createdAt,
      ),
    ]);
  } catch (reason) {
    await env.ATTACHMENTS.delete(snapshotRef).catch(() => undefined);
    throw reason;
  }

  return {
    id: revisionId,
    pageId: page.id,
    generation: page.currentGeneration,
    collabSeq,
    kind: options.kind,
    label: options.label,
    description: options.description,
    contentHash,
    createdBy,
    createdAt,
  };
}

async function listRevisions(env: Env, pageId: string): Promise<Response> {
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);
  const rows = (
    await env.DB.prepare(
      `SELECT id, page_id, generation, collab_seq, kind, label, description,
              snapshot_location, snapshot_ref, content_hash, created_by, created_at
         FROM revisions
        WHERE organization_id = ? AND page_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(page.organizationId, page.id, MAX_REVISIONS_PER_PAGE)
      .all<RevisionRow>()
  ).results;
  return json({ revisions: rows.map(revisionFromRow) });
}

async function createRevision(
  request: Request,
  env: Env,
  pageId: string,
  actorId: string,
): Promise<Response> {
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);
  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown;
    description?: unknown;
  };
  if (body.label !== undefined && typeof body.label !== 'string') {
    return error('版本名称必须是字符串', 400);
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return error('版本说明必须是字符串', 400);
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (label.length > MAX_REVISION_LABEL_LENGTH) return error('版本名称过长', 400);
  if (description.length > MAX_REVISION_DESCRIPTION_LENGTH) return error('版本说明过长', 400);

  const revision = await captureRevision(env, page, {
    kind: 'manual',
    label: label || null,
    description: description || null,
    createdBy: actorId,
  });
  return json({ revision }, { status: 201 });
}

async function exportPageMarkdown(env: Env, page: PageSummary, actorId: string): Promise<Response> {
  const revision = await captureRevision(env, page, {
    kind: 'pre_export',
    label: '导出前自动保存',
    description: 'Markdown 导出前生成',
    createdBy: actorId,
  });
  const row = await findRevision(env, revision.id);
  if (!row) return error('导出版本生成失败', 500);
  const object = await env.ATTACHMENTS.get(row.snapshot_ref);
  if (!object) return error('导出快照丢失', 500);
  const snapshot = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(snapshot)) !== row.content_hash) return error('导出快照校验失败', 500);
  const markdown = yjsSnapshotToMarkdown(snapshot, page.title);
  const filename = `${page.title.replace(/[\\/\u0000-\u001f]/g, '-').slice(0, 100) || 'Rdocs'}.md`;
  await pageAudit(env, page, actorId, 'page.markdown.exported', { revisionId: revision.id });
  return new Response(markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="rdocs.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'private, no-store',
    },
  });
}

async function importMarkdown(
  request: Request,
  env: Env,
  spaceId: string,
  actorId: string,
): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_MARKDOWN_IMPORT_BYTES) return error('Markdown 文件超过 2 MB', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_MARKDOWN_IMPORT_BYTES) {
    return error('Markdown 文件为空或超过 2 MB', 400);
  }
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return error('Markdown 文件不是有效的 UTF-8 文本', 400);
  }
  const imported = markdownToYjsSnapshot(markdown);
  let filename = 'Markdown 导入';
  try {
    filename = decodeURIComponent(request.headers.get('x-rdocs-file-name') ?? filename)
      .replace(/\.md$/i, '')
      .trim();
  } catch {
    return error('文件名编码无效', 400);
  }
  const title = (imported.title || filename || 'Markdown 导入').slice(0, MAX_TITLE_LENGTH);
  const access = await requireSpaceAction(env, spaceId, actorId, 'create_child');
  if (!access) return error('空间不存在或无权导入', 404);
  const id = crypto.randomUUID();
  const now = Date.now();
  const normalizedBody = normalizeSearchText(imported.plainText).slice(0, 500_000);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pages(
         id, organization_id, space_id, parent_id, title, sort_key,
         current_generation, editor_schema_version, created_by, updated_by,
         created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      access.organizationId,
      spaceId,
      title,
      now.toString().padStart(20, '0'),
      EDITOR_SCHEMA_VERSION,
      actorId,
      actorId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).bind(id, now),
    env.DB.prepare(
      `INSERT INTO page_search_projection(
         page_id, organization_id, space_id, generation, collab_seq,
         title, normalized_body, updated_at
       ) VALUES (?, ?, ?, 1, 0, ?, ?, ?)`,
    ).bind(id, access.organizationId, spaceId, title, normalizedBody, now),
    env.DB.prepare(
      'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
    ).bind(id, searchIndexText(title), searchIndexText(`${title}\n${normalizedBody}`)),
  ]);
  const contentHash = await sha256Hex(imported.snapshot);
  const initialized = await documentRoom(env, id, 1).fetch(
    'https://rdocs.internal/internal/initialize-generation',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-rdocs-page-id': id,
        'x-rdocs-generation': '1',
        'x-rdocs-revision-id': `import_${id}`,
        'x-rdocs-content-hash': contentHash,
        'x-rdocs-actor-id': actorId,
      },
      body: toArrayBuffer(imported.snapshot),
    },
  );
  if (!initialized.ok) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(id),
      env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id),
    ]);
    return error('Markdown 正文初始化失败', 500);
  }
  const page = await findPage(env, id);
  if (!page) return error('Markdown 页面创建失败', 500);
  await pageAudit(env, page, actorId, 'page.markdown.imported', { byteSize: bytes.byteLength });
  return json({ page }, { status: 201 });
}

async function copyPage(
  request: Request,
  env: Env,
  source: PageSummary,
  actorId: string,
): Promise<Response> {
  const input = (await request.json().catch(() => ({}))) as { parentId?: unknown; title?: unknown };
  const parentId = input.parentId === undefined ? source.parentId : input.parentId;
  if (parentId !== null && (typeof parentId !== 'string' || !isPageId(parentId))) {
    return error('副本父页面 ID 无效', 400);
  }
  if (parentId !== null) {
    const parent = await requirePageAction(env, parentId, actorId, 'create_child');
    if (!parent || parent.page.spaceId !== source.spaceId) {
      return error('副本目标父页面不存在或不在同一空间', 400);
    }
  } else if (!(await requireSpaceAction(env, source.spaceId, actorId, 'create_child'))) {
    return error('无权在空间根目录创建副本', 403);
  }
  const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const title = (requestedTitle || `${source.title} 副本`).slice(0, MAX_TITLE_LENGTH);
  const snapshotResponse = await documentRoom(env, source.id, source.currentGeneration).fetch(
    'https://rdocs.internal/internal/export-snapshot',
    { method: 'POST', headers: { 'x-rdocs-actor-id': actorId } },
  );
  if (!snapshotResponse.ok) return error('无法读取源页面正文', 502);
  const sourceSnapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
  if (!sourceSnapshot.byteLength || sourceSnapshot.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
    return error('源页面正文过大，无法复制', 413);
  }
  if (snapshotResponse.headers.get('x-rdocs-content-hash') !== (await sha256Hex(sourceSnapshot))) {
    return error('源页面正文校验失败', 500);
  }
  const projection = await env.DB.prepare(
    'SELECT normalized_body FROM page_search_projection WHERE page_id = ?',
  )
    .bind(source.id)
    .first<{ normalized_body: string }>();
  const id = crypto.randomUUID();
  const now = Date.now();
  const normalizedBody = projection?.normalized_body ?? '';
  const sourceAttachments = (
    await env.DB.prepare(
      `SELECT id, organization_id, page_id, r2_key, original_name, mime_type,
              byte_size, sha256, status, created_by, created_at, deleted_at
         FROM attachments
        WHERE organization_id = ? AND page_id = ? AND status = 'ready' AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
      .bind(source.organizationId, source.id, MAX_PAGE_COPY_ATTACHMENTS + 1)
      .all<AttachmentRow>()
  ).results;
  const attachmentBytes = sourceAttachments.reduce((total, row) => total + row.byte_size, 0);
  if (
    sourceAttachments.length > MAX_PAGE_COPY_ATTACHMENTS ||
    attachmentBytes > MAX_PAGE_COPY_ATTACHMENT_BYTES
  ) {
    return error('页面附件过多或总大小超过 250 MB，无法创建完整副本', 413);
  }

  const attachmentIds = new Map<string, string>();
  const copiedAttachmentKeys: string[] = [];
  const attachmentStatements: D1PreparedStatement[] = [];
  try {
    for (const attachment of sourceAttachments) {
      const object = await env.ATTACHMENTS.get(attachment.r2_key);
      if (!object) throw new Error(`copy_attachment_missing:${attachment.id}`);
      const attachmentId = crypto.randomUUID();
      const r2Key = `organizations/${source.organizationId}/pages/${id}/attachments/${attachmentId}`;
      await env.ATTACHMENTS.put(r2Key, object.body, {
        httpMetadata: { contentType: attachment.mime_type },
        customMetadata: {
          pageId: id,
          originalName: attachment.original_name,
          sha256: attachment.sha256,
          copiedFrom: attachment.id,
        },
      });
      copiedAttachmentKeys.push(r2Key);
      attachmentIds.set(attachment.id, attachmentId);
      attachmentStatements.push(
        env.DB.prepare(
          `INSERT INTO attachments(
             id, organization_id, page_id, r2_key, original_name, mime_type,
             byte_size, sha256, status, created_by, created_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL)`,
        ).bind(
          attachmentId,
          source.organizationId,
          id,
          r2Key,
          attachment.original_name,
          attachment.mime_type,
          attachment.byte_size,
          attachment.sha256,
          actorId,
          now,
        ),
      );
    }
  } catch (reason) {
    await Promise.all(copiedAttachmentKeys.map((key) => env.ATTACHMENTS.delete(key)));
    throw reason;
  }
  const snapshot = rewriteYjsAttachmentReferences(sourceSnapshot, attachmentIds);
  const contentHash = await sha256Hex(snapshot);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO pages(
         id, organization_id, space_id, parent_id, title, sort_key,
         current_generation, editor_schema_version, created_by, updated_by,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        source.organizationId,
        source.spaceId,
        parentId,
        title,
        now.toString().padStart(20, '0'),
        EDITOR_SCHEMA_VERSION,
        actorId,
        actorId,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES (?, 1, 1, ?)`,
      ).bind(id, now),
      env.DB.prepare(
        `INSERT INTO page_search_projection(
           page_id, organization_id, space_id, generation, collab_seq,
           title, normalized_body, updated_at
         ) VALUES (?, ?, ?, 1, 0, ?, ?, ?)`,
      ).bind(id, source.organizationId, source.spaceId, title, normalizedBody, now),
      env.DB.prepare(
        'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
      ).bind(id, searchIndexText(title), searchIndexText(`${title}\n${normalizedBody}`)),
      ...attachmentStatements,
    ]);
  } catch (reason) {
    await Promise.all(copiedAttachmentKeys.map((key) => env.ATTACHMENTS.delete(key)));
    throw reason;
  }
  const initialized = await documentRoom(env, id, 1).fetch(
    'https://rdocs.internal/internal/initialize-generation',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-rdocs-page-id': id,
        'x-rdocs-generation': '1',
        'x-rdocs-revision-id': `copy_${id}`,
        'x-rdocs-content-hash': contentHash,
        'x-rdocs-actor-id': actorId,
      },
      body: toArrayBuffer(snapshot),
    },
  );
  if (!initialized.ok) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(id),
      env.DB.prepare('DELETE FROM attachments WHERE page_id = ?').bind(id),
      env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id),
    ]);
    await Promise.all(copiedAttachmentKeys.map((key) => env.ATTACHMENTS.delete(key)));
    return error('页面副本正文初始化失败', 500);
  }
  const copied = await findPage(env, id);
  if (!copied) return error('页面副本创建失败', 500);
  await pageAudit(env, copied, actorId, 'page.copied', {
    sourcePageId: source.id,
    attachmentCount: sourceAttachments.length,
    attachmentBytes,
  });
  return json({ page: copied }, { status: 201 });
}

async function findRevision(env: Env, revisionId: string): Promise<RevisionRow | null> {
  return env.DB.prepare(
    `SELECT id, page_id, generation, collab_seq, kind, label, description,
            snapshot_location, snapshot_ref, content_hash, created_by, created_at
       FROM revisions
      WHERE id = ?`,
  )
    .bind(revisionId)
    .first<RevisionRow>();
}

async function revisionSnapshot(env: Env, revision: RevisionRow): Promise<Response> {
  if (revision.snapshot_location !== 'r2') return error('此版本尚未进入可预览存储', 409);
  const object = await env.ATTACHMENTS.get(revision.snapshot_ref);
  if (!object) return error('版本快照丢失', 500);
  const snapshot = new Uint8Array(await object.arrayBuffer());
  if (snapshot.byteLength === 0 || snapshot.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
    return error('版本快照大小异常', 500);
  }
  if ((await sha256Hex(snapshot)) !== revision.content_hash) {
    return error('版本快照完整性校验失败', 500);
  }
  return new Response(toArrayBuffer(snapshot), {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'private, no-store',
      'x-rdocs-content-hash': revision.content_hash,
    },
  });
}

async function findRestoreOperation(
  env: Env,
  idempotencyKey: string,
): Promise<RestoreOperationRow | null> {
  return env.DB.prepare(
    `SELECT idempotency_key, organization_id, page_id, revision_id, actor_id,
            source_generation, target_generation, previous_revision_id,
            status, lease_token, lease_expires_at, created_at, updated_at, completed_at
       FROM revision_restore_operations
      WHERE idempotency_key = ?`,
  )
    .bind(idempotencyKey)
    .first<RestoreOperationRow>();
}

async function failRestoreOperation(
  env: Env,
  idempotencyKey: string,
  leaseToken: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE revision_restore_operations
        SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status = 'pending' AND lease_token = ?`,
  )
    .bind(Date.now(), idempotencyKey, leaseToken)
    .run();
}

async function closeSourceGeneration(env: Env, operation: RestoreOperationRow): Promise<void> {
  if (operation.target_generation === null) return;
  try {
    await documentRoom(env, operation.page_id, Number(operation.source_generation)).fetch(
      'https://rdocs.internal/internal/rebase',
      {
        method: 'POST',
        headers: { 'x-rdocs-next-generation': String(operation.target_generation) },
      },
    );
  } catch (reason) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'revision_old_generation_close_failed',
        pageId: operation.page_id,
        generation: operation.source_generation,
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
  }
}

async function completedRestoreResponse(
  env: Env,
  operation: RestoreOperationRow,
  replay: boolean,
  context: ExecutionContext,
): Promise<Response> {
  const [page, previousRevision] = await Promise.all([
    findPage(env, operation.page_id),
    findRevision(env, operation.previous_revision_id),
  ]);
  if (!page || !previousRevision) throw new Error('revision_restore_result_missing');
  context.waitUntil(closeSourceGeneration(env, operation));
  return json(
    {
      page,
      restoredRevisionId: operation.revision_id,
      previousRevision: revisionFromRow(previousRevision),
      idempotencyKey: operation.idempotency_key,
    },
    replay ? { headers: { 'x-rdocs-idempotent-replay': '1' } } : undefined,
  );
}

async function finalizeRestoreOperation(
  env: Env,
  operation: RestoreOperationRow,
  replay: boolean,
  context: ExecutionContext,
): Promise<Response> {
  if (operation.target_generation === null) throw new Error('revision_restore_target_missing');

  let page = await findPage(env, operation.page_id);
  if (!page) return error('页面不存在', 404);
  if (page.currentGeneration === Number(operation.source_generation)) {
    await env.DB.prepare(
      `UPDATE pages
          SET current_generation = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND current_generation = ? AND deleted_at IS NULL`,
    )
      .bind(
        operation.target_generation,
        operation.actor_id ?? SYSTEM_USER_ID,
        Date.now(),
        operation.page_id,
        operation.organization_id,
        operation.source_generation,
      )
      .run();
    page = await findPage(env, operation.page_id);
  }

  if (!page || page.currentGeneration !== Number(operation.target_generation)) {
    await env.DB.prepare(
      `UPDATE revision_restore_operations
          SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status != 'completed'`,
    )
      .bind(Date.now(), operation.idempotency_key)
      .run();
    return error('页面已被其他恢复操作更新，请刷新后重试', 409);
  }

  const completedAt = Date.now();
  const completion = await env.DB.prepare(
    `UPDATE revision_restore_operations
        SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
            updated_at = ?, completed_at = ?
      WHERE idempotency_key = ? AND status = 'prepared'`,
  )
    .bind(completedAt, completedAt, operation.idempotency_key)
    .run();
  if (completion.meta.changes) {
    await pageAudit(env, page, operation.actor_id ?? SYSTEM_USER_ID, 'revision.restored', {
      revisionId: operation.revision_id,
      sourceGeneration: operation.source_generation,
      targetGeneration: operation.target_generation,
    });
  }
  invalidateCollaborationPage(operation.page_id);
  const completed = await findRestoreOperation(env, operation.idempotency_key);
  if (!completed || completed.status !== 'completed') {
    throw new Error('revision_restore_completion_missing');
  }
  return completedRestoreResponse(env, completed, replay, context);
}

async function restoreRevision(
  request: Request,
  env: Env,
  revisionId: string,
  actorId: string,
  context: ExecutionContext,
): Promise<Response> {
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (!isPageId(idempotencyKey)) {
    return error('恢复版本需要有效的 Idempotency-Key', 400);
  }

  const targetRevision = await findRevision(env, revisionId);
  if (!targetRevision) return error('版本不存在', 404);
  const page = await findPage(env, targetRevision.page_id);
  if (!page) return error('页面不存在', 404);
  if (targetRevision.snapshot_location !== 'r2') {
    return error('此版本的快照位置暂不支持恢复', 409);
  }

  const now = Date.now();
  const leaseToken = crypto.randomUUID();
  const previousRevisionId = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO revision_restore_operations(
      idempotency_key, organization_id, page_id, revision_id, actor_id, source_generation,
      target_generation, previous_revision_id, status, lease_token, lease_expires_at,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?, NULL)`,
  )
    .bind(
      idempotencyKey,
      page.organizationId,
      page.id,
      targetRevision.id,
      actorId,
      page.currentGeneration,
      previousRevisionId,
      leaseToken,
      now + RESTORE_OPERATION_LEASE_MS,
      now,
      now,
    )
    .run();

  let operation = await findRestoreOperation(env, idempotencyKey);
  if (!operation) throw new Error('revision_restore_operation_missing');
  if (
    operation.organization_id !== page.organizationId ||
    operation.page_id !== page.id ||
    operation.revision_id !== targetRevision.id ||
    (operation.actor_id !== null && operation.actor_id !== actorId)
  ) {
    return error('Idempotency-Key 已用于另一项恢复操作', 409);
  }
  if (operation.status === 'completed') {
    return completedRestoreResponse(env, operation, true, context);
  }
  if (operation.status === 'prepared') {
    return finalizeRestoreOperation(env, operation, true, context);
  }

  const ownsNewOperation = Boolean(inserted.meta.changes);
  if (!ownsNewOperation) {
    if (
      operation.status === 'pending' &&
      operation.lease_expires_at !== null &&
      Number(operation.lease_expires_at) > now
    ) {
      return json(
        { error: '恢复操作仍在进行，请稍后使用同一请求重试' },
        { status: 409, headers: { 'retry-after': '2' } },
      );
    }
    const claimed = await env.DB.prepare(
      `UPDATE revision_restore_operations
          SET status = 'pending', lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE idempotency_key = ?
          AND (status = 'failed' OR (status = 'pending' AND lease_expires_at <= ?))`,
    )
      .bind(leaseToken, now + RESTORE_OPERATION_LEASE_MS, now, idempotencyKey, now)
      .run();
    if (!claimed.meta.changes) {
      return json(
        { error: '恢复操作状态已变化，请稍后使用同一请求重试' },
        { status: 409, headers: { 'retry-after': '2' } },
      );
    }
    operation = await findRestoreOperation(env, idempotencyKey);
    if (!operation) throw new Error('revision_restore_claim_missing');
  }

  try {
    const currentPage = await findPage(env, operation.page_id);
    if (!currentPage || currentPage.currentGeneration !== Number(operation.source_generation)) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('页面已被其他恢复操作更新，请刷新后重试', 409);
    }

    const snapshotObject = await env.ATTACHMENTS.get(targetRevision.snapshot_ref);
    if (!snapshotObject) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('版本快照不存在', 409);
    }
    if (snapshotObject.size > MAX_REVISION_SNAPSHOT_BYTES) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('版本快照过大', 413);
    }
    const snapshot = new Uint8Array(await snapshotObject.arrayBuffer());
    if ((await sha256Hex(snapshot)) !== targetRevision.content_hash) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('版本快照校验失败', 409);
    }

    await captureRevision(env, currentPage, {
      kind: 'restore',
      label: '恢复前自动版本',
      description: `恢复版本 ${targetRevision.id} 前自动保存`,
      revisionId: operation.previous_revision_id,
      createdBy: operation.actor_id ?? actorId,
    });

    let nextGeneration: number | null = null;
    const firstCandidate = operation.target_generation ?? Number(operation.source_generation) + 1;
    for (let attempt = 0; attempt < MAX_GENERATION_INITIALIZATION_ATTEMPTS; attempt += 1) {
      const candidate = firstCandidate + attempt;
      await env.DB.prepare(
        `UPDATE revision_restore_operations
            SET target_generation = ?, lease_expires_at = ?, updated_at = ?
          WHERE idempotency_key = ? AND status = 'pending' AND lease_token = ?`,
      )
        .bind(
          candidate,
          Date.now() + RESTORE_OPERATION_LEASE_MS,
          Date.now(),
          idempotencyKey,
          leaseToken,
        )
        .run();
      const initializeResponse = await documentRoom(env, currentPage.id, candidate).fetch(
        'https://rdocs.internal/internal/initialize-generation',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-rdocs-page-id': currentPage.id,
            'x-rdocs-generation': String(candidate),
            'x-rdocs-revision-id': targetRevision.id,
            'x-rdocs-content-hash': targetRevision.content_hash,
            'x-rdocs-actor-id': SYSTEM_USER_ID,
          },
          body: toArrayBuffer(snapshot),
        },
      );
      if (initializeResponse.status === 409) continue;
      if (!initializeResponse.ok) {
        throw new Error(`revision_generation_initialize_${initializeResponse.status}`);
      }
      nextGeneration = candidate;
      break;
    }
    if (nextGeneration === null) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('无法分配新的文档 generation', 409);
    }

    await env.DB.prepare(
      `UPDATE revision_restore_operations
          SET target_generation = ?, status = 'prepared', lease_token = NULL,
              lease_expires_at = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status = 'pending' AND lease_token = ?`,
    )
      .bind(nextGeneration, Date.now(), idempotencyKey, leaseToken)
      .run();
    const prepared = await findRestoreOperation(env, idempotencyKey);
    if (!prepared || prepared.status !== 'prepared') {
      throw new Error('revision_restore_prepare_missing');
    }
    return finalizeRestoreOperation(env, prepared, false, context);
  } catch (reason) {
    await failRestoreOperation(env, idempotencyKey, leaseToken).catch(() => undefined);
    throw reason;
  }
}

async function findPageForCollaboration(env: Env, pageId: string): Promise<PageSummary | null> {
  const cached = getCachedCollaborationPage(pageId, COLLAB_AUTH_CACHE_MS);
  if (cached) return cached;
  const page = await findPage(env, pageId);
  if (page) cacheCollaborationPage(page);
  return page;
}

async function createPage(request: Request, env: Env, actorId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    title?: unknown;
    parentId?: unknown;
    spaceId?: unknown;
  };
  const requestedTitle = typeof body.title === 'string' ? body.title.trim() : '';
  const title = (requestedTitle || '未命名页面').slice(0, MAX_TITLE_LENGTH);
  const parentId = body.parentId === null || body.parentId === undefined ? null : body.parentId;
  if (parentId !== null && (typeof parentId !== 'string' || !isPageId(parentId))) {
    return error('父页面 ID 无效', 400);
  }
  let spaceId = typeof body.spaceId === 'string' ? body.spaceId : null;
  let parent: PageSummary | null = null;
  if (parentId !== null) {
    const parentAccess = await requirePageAction(env, parentId, actorId, 'create_child');
    parent = parentAccess?.page ?? null;
    if (!parent) return error('父页面不存在或无权创建子页面', 404);
    if (spaceId && parent.spaceId !== spaceId) return error('父页面不属于目标空间', 400);
    spaceId = parent.spaceId;
  }
  if (!spaceId) return error('缺少目标空间', 400);
  const access = await requireSpaceAction(env, spaceId, actorId, 'create_child');
  if (!access || (parent && parent.organizationId !== access.organizationId)) {
    return error('空间或父页面不存在', 404);
  }
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pages(
        id, organization_id, space_id, parent_id, title, sort_key,
        current_generation, editor_schema_version, created_by, updated_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      access.organizationId,
      spaceId,
      parentId,
      title,
      now.toString().padStart(20, '0'),
      EDITOR_SCHEMA_VERSION,
      actorId,
      actorId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).bind(id, now),
    env.DB.prepare(
      `INSERT INTO page_search_projection(
         page_id, organization_id, space_id, generation, collab_seq,
         title, normalized_body, updated_at
       ) VALUES (?, ?, ?, 1, 0, ?, '', ?)`,
    ).bind(id, access.organizationId, spaceId, title, now),
    env.DB.prepare(
      'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
    ).bind(id, searchIndexText(title), searchIndexText(title)),
  ]);

  const page = await findPage(env, id);
  if (page) await pageAudit(env, page, actorId, 'page.created', { parentId });
  return json({ page }, { status: 201 });
}

async function updatePage(
  request: Request,
  env: Env,
  pageId: string,
  actorId: string,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== 'string') return error('title 必须是字符串', 400);
  const title = (body.title.trim() || '未命名页面').slice(0, MAX_TITLE_LENGTH);
  const result = await env.DB.prepare(
    `UPDATE pages SET title = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(title, actorId, Date.now(), pageId)
    .run();
  if (!result.meta.changes) return error('页面不存在', 404);
  await updateSearchProjectionTitle(env, pageId, title);
  const page = await findPage(env, pageId);
  if (page) await pageAudit(env, page, actorId, 'page.title.updated', { title });
  return json({ page });
}

async function pageAudit(
  env: Env,
  page: PageSummary,
  actorId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events(
       id, organization_id, actor_id, event_type, target_type, target_id,
       request_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, 'page', ?, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      page.organizationId,
      actorId,
      eventType,
      page.id,
      JSON.stringify(metadata),
      Date.now(),
    )
    .run();
}

async function closePageConnections(
  env: Env,
  pages: PageSummary[],
  context: ExecutionContext,
): Promise<void> {
  const notifications = pages.map(async (page) => {
    invalidateCollaborationPage(page.id);
    const room = documentRoom(env, page.id, page.currentGeneration);
    await room.fetch('https://rdocs.internal/internal/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        aclVersion: page.aclVersion + 1,
        closeConnections: true,
      }),
    });
  });
  context.waitUntil(Promise.all(notifications).then(() => undefined));
}

async function movePage(
  request: Request,
  env: Env,
  page: PageSummary,
  actorId: string,
): Promise<Response> {
  const input = (await request.json().catch(() => null)) as {
    parentId?: unknown;
    beforePageId?: unknown;
  } | null;
  if (!input || !Object.prototype.hasOwnProperty.call(input, 'parentId')) {
    return error('缺少 parentId', 400);
  }
  const parentId = input.parentId;
  if (parentId !== null && (typeof parentId !== 'string' || !isPageId(parentId))) {
    return error('父页面 ID 无效', 400);
  }
  const beforePageId = input.beforePageId ?? null;
  if (
    beforePageId !== null &&
    (typeof beforePageId !== 'string' || !isPageId(beforePageId) || beforePageId === page.id)
  ) {
    return error('排序锚点页面无效', 400);
  }

  if (parentId !== null) {
    const parentAccess = await requirePageAction(env, parentId, actorId, 'create_child');
    if (!parentAccess || parentAccess.page.spaceId !== page.spaceId) {
      return error('目标父页面不存在或不在同一空间', 400);
    }
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM pages WHERE parent_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.id FROM pages p JOIN descendants d ON p.parent_id = d.id
          WHERE p.deleted_at IS NULL
       ) SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1`,
    )
      .bind(page.id, parentId)
      .first<{ found: number }>();
    if (cycle || parentId === page.id) return error('不能将页面移入自己的子树', 409);
  } else if (!(await requireSpaceAction(env, page.spaceId, actorId, 'create_child'))) {
    return error('无权移到空间根目录', 403);
  }

  const siblings = (
    await env.DB.prepare(
      `SELECT id FROM pages
        WHERE space_id = ? AND parent_id IS ? AND deleted_at IS NULL AND id <> ?
        ORDER BY sort_key ASC, id ASC LIMIT ?`,
    )
      .bind(page.spaceId, parentId, page.id, MAX_PAGE_TREE_SIZE)
      .all<{ id: string }>()
  ).results;
  let insertionIndex = siblings.length;
  if (beforePageId !== null) {
    insertionIndex = siblings.findIndex((sibling) => sibling.id === beforePageId);
    if (insertionIndex < 0) return error('排序锚点不在目标目录', 400);
  }
  siblings.splice(insertionIndex, 0, { id: page.id });
  const now = Date.now();
  const statements = siblings.map((sibling, index) =>
    env.DB.prepare(
      sibling.id === page.id
        ? `UPDATE pages SET parent_id = ?, sort_key = ?, updated_by = ?, updated_at = ? WHERE id = ?`
        : `UPDATE pages SET sort_key = ? WHERE id = ?`,
    ).bind(
      ...(sibling.id === page.id
        ? [parentId, String((index + 1) * 1024).padStart(20, '0'), actorId, now, sibling.id]
        : [String((index + 1) * 1024).padStart(20, '0'), sibling.id]),
    ),
  );
  await env.DB.batch(statements);
  await pageAudit(env, page, actorId, 'page.moved', { parentId, beforePageId });
  return json({ page: await findPage(env, page.id) });
}

async function deletePage(
  env: Env,
  page: PageSummary,
  actorId: string,
  context: ExecutionContext,
): Promise<Response> {
  const subtreeRows = (
    await env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          WHERE p.deleted_at IS NULL
       )
       SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
              p.current_generation, p.editor_schema_version, p.updated_at,
              a.collaboration_enabled, a.acl_version
         FROM pages p JOIN page_access_state a ON a.page_id = p.id
        WHERE p.id IN (SELECT id FROM subtree)
        LIMIT ?`,
    )
      .bind(page.id, MAX_PAGE_TREE_SIZE + 1)
      .all<PageRow>()
  ).results.map(pageFromRow);
  if (subtreeRows.length > MAX_PAGE_TREE_SIZE) return error('页面子树过大，无法一次删除', 409);
  for (const descendant of subtreeRows) {
    if (!(await requirePageAction(env, descendant.id, actorId, 'delete'))) {
      return error('子树包含无权删除的限制页面', 403);
    }
  }

  await captureRevision(env, page, {
    kind: 'pre_delete',
    label: '删除前自动保存',
    description: '移入回收站前生成',
    createdBy: actorId,
  });
  const deletedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          WHERE p.deleted_at IS NULL
       ) UPDATE pages SET deleted_at = ?, updated_by = ?, updated_at = ?
          WHERE id IN (SELECT id FROM subtree)`,
    ).bind(page.id, deletedAt, actorId, deletedAt),
    env.DB.prepare(
      `UPDATE page_access_state
          SET collaboration_enabled = 0, acl_version = acl_version + 1, updated_at = ?
        WHERE page_id IN (
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM pages WHERE id = ?
            UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          ) SELECT id FROM subtree
        )`,
    ).bind(deletedAt, page.id),
  ]);
  await pageAudit(env, page, actorId, 'page.deleted', {
    deletedAt,
    deletedCount: subtreeRows.length,
  });
  await closePageConnections(env, subtreeRows, context);
  return json({ ok: true, deletedAt, deletedCount: subtreeRows.length });
}

async function listTrash(env: Env, spaceId: string, actorId: string): Promise<Response> {
  const access = await requireSpaceAction(env, spaceId, actorId, 'restore');
  if (!access) return error('空间不存在或无权查看回收站', 404);
  const rows = (
    await env.DB.prepare(
      `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
              p.current_generation, p.editor_schema_version, p.updated_at, p.deleted_at,
              a.collaboration_enabled, a.acl_version
         FROM pages p
         JOIN page_access_state a ON a.page_id = p.id
         LEFT JOIN pages parent ON parent.id = p.parent_id
        WHERE p.space_id = ? AND p.organization_id = ? AND p.deleted_at IS NOT NULL
          AND (parent.id IS NULL OR parent.deleted_at IS NULL OR parent.deleted_at <> p.deleted_at)
        ORDER BY p.deleted_at DESC LIMIT ?`,
    )
      .bind(spaceId, access.organizationId, MAX_PAGE_TREE_SIZE)
      .all<TrashedPageRow>()
  ).results;
  const pages: TrashedPageSummary[] = [];
  for (const row of rows) {
    if (await requireDeletedPageAction(env, row.id, actorId, 'restore')) {
      pages.push(trashedPageFromRow(row));
    }
  }
  return json({ pages });
}

async function restorePage(env: Env, pageId: string, actorId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
            p.current_generation, p.editor_schema_version, p.updated_at, p.deleted_at,
            a.collaboration_enabled, a.acl_version
       FROM pages p JOIN page_access_state a ON a.page_id = p.id
      WHERE p.id = ? AND p.deleted_at IS NOT NULL`,
  )
    .bind(pageId)
    .first<TrashedPageRow>();
  if (!row || !(await requireSpaceAction(env, row.space_id, actorId, 'restore'))) {
    return error('页面不存在或无权恢复', 404);
  }
  let parentId = row.parent_id;
  if (parentId) {
    const parent = await env.DB.prepare(
      `SELECT 1 AS found FROM pages
        WHERE id = ? AND space_id = ? AND deleted_at IS NULL`,
    )
      .bind(parentId, row.space_id)
      .first<{ found: number }>();
    if (!parent) parentId = null;
  }
  const restoredAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND deleted_at = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          WHERE p.deleted_at = ?
       ) UPDATE pages SET deleted_at = NULL, updated_by = ?, updated_at = ?
          WHERE id IN (SELECT id FROM subtree)`,
    ).bind(pageId, row.deleted_at, row.deleted_at, actorId, restoredAt),
    env.DB.prepare('UPDATE pages SET parent_id = ? WHERE id = ?').bind(parentId, pageId),
    env.DB.prepare(
      `UPDATE page_access_state
          SET collaboration_enabled = 1, acl_version = acl_version + 1, updated_at = ?
        WHERE page_id IN (
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM pages WHERE id = ?
            UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          ) SELECT id FROM subtree
        )`,
    ).bind(restoredAt, pageId),
  ]);
  const restored = await findPage(env, pageId);
  if (!restored) return error('页面恢复失败', 500);
  await pageAudit(env, restored, actorId, 'page.restored', { parentId });
  return json({ page: restored });
}

async function listPageAccess(env: Env, page: PageSummary, actorId: string): Promise<Response> {
  if (!(await requirePageAction(env, page.id, actorId, 'manage_access'))) {
    return error('无权查看页面权限', 403);
  }
  return pageAccessSnapshot(env, page.id);
}

async function bumpPageSubtreeAcl(
  env: Env,
  pageId: string,
  context: ExecutionContext,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE page_access_state
        SET acl_version = acl_version + 1, updated_at = ?
      WHERE page_id IN (
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL
          UNION ALL
          SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
           WHERE p.deleted_at IS NULL
        ) SELECT id FROM subtree
      )`,
  )
    .bind(now, pageId)
    .run();
  const rows = (
    await env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
          WHERE p.deleted_at IS NULL
       )
       SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
              p.current_generation, p.editor_schema_version, p.updated_at,
              a.collaboration_enabled, a.acl_version
         FROM pages p JOIN page_access_state a ON a.page_id = p.id
        WHERE p.id IN (SELECT id FROM subtree) LIMIT ?`,
    )
      .bind(pageId, MAX_PAGE_TREE_SIZE)
      .all<PageRow>()
  ).results;
  const notifications = rows.map(async (row) => {
    const page = pageFromRow(row);
    invalidateCollaborationPage(page.id);
    await documentRoom(env, page.id, page.currentGeneration).fetch(
      'https://rdocs.internal/internal/access',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: page.collaborationEnabled,
          aclVersion: page.aclVersion,
          closeConnections: true,
        }),
      },
    );
  });
  context.waitUntil(Promise.all(notifications).then(() => undefined));
}

async function updatePageAccessMode(
  request: Request,
  env: Env,
  page: PageSummary,
  actorId: string,
  context: ExecutionContext,
): Promise<Response> {
  if (!(await requirePageAction(env, page.id, actorId, 'manage_access'))) {
    return error('无权管理页面权限', 403);
  }
  const input = (await request.json().catch(() => null)) as { mode?: unknown } | null;
  if (input?.mode !== 'inherit' && input?.mode !== 'restricted') {
    return error('页面权限模式无效', 400);
  }
  await env.DB.prepare(
    'UPDATE page_access_state SET access_mode = ?, updated_at = ? WHERE page_id = ?',
  )
    .bind(input.mode, Date.now(), page.id)
    .run();
  await pageAudit(env, page, actorId, 'page.access.mode.updated', { mode: input.mode });
  await bumpPageSubtreeAcl(env, page.id, context);
  return pageAccessSnapshot(env, page.id);
}

async function validPageGrantPrincipal(
  env: Env,
  page: PageSummary,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
): Promise<boolean> {
  if (principalType === 'organization') return principalId === page.organizationId;
  if (principalType === 'user') {
    return Boolean(
      await env.DB.prepare(
        `SELECT 1 AS found FROM organization_members
          WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
      )
        .bind(page.organizationId, principalId)
        .first<{ found: number }>(),
    );
  }
  return Boolean(
    await env.DB.prepare('SELECT 1 AS found FROM groups WHERE organization_id = ? AND id = ?')
      .bind(page.organizationId, principalId)
      .first<{ found: number }>(),
  );
}

async function putPageGrant(
  request: Request,
  env: Env,
  page: PageSummary,
  actorId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
  context: ExecutionContext,
): Promise<Response> {
  if (!(await requirePageAction(env, page.id, actorId, 'manage_access'))) {
    return error('无权管理页面权限', 403);
  }
  const input = (await request.json().catch(() => null)) as { role?: unknown } | null;
  if (
    input?.role !== 'none' &&
    input?.role !== 'space_admin' &&
    input?.role !== 'editor' &&
    input?.role !== 'commenter' &&
    input?.role !== 'viewer'
  ) {
    return error('页面角色无效', 400);
  }
  if (!(await validPageGrantPrincipal(env, page, principalType, principalId))) {
    return error('授权主体不属于此组织', 400);
  }
  if (principalType === 'user' && input.role !== 'none' && input.role !== 'viewer') {
    const membership = await env.DB.prepare(
      `SELECT role FROM organization_members
        WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
    )
      .bind(page.organizationId, principalId)
      .first<{ role: OrganizationRole }>();
    if (membership?.role === 'guest') {
      return error('历史外部只读成员最高只能获得只读权限', 400, 'guest_read_only');
    }
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM page_grants
      WHERE organization_id = ? AND page_id = ? AND principal_type = ? AND principal_id = ?`,
  )
    .bind(page.organizationId, page.id, principalType, principalId)
    .first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO page_grants(
       id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, page_id, principal_type, principal_id)
     DO UPDATE SET role = excluded.role, created_by = excluded.created_by,
                   created_at = excluded.created_at`,
  )
    .bind(id, page.organizationId, page.id, principalType, principalId, input.role, actorId, now)
    .run();
  await pageAudit(env, page, actorId, 'page.grant.updated', {
    principalType,
    principalId,
    role: input.role,
  });
  await bumpPageSubtreeAcl(env, page.id, context);
  return pageAccessSnapshot(env, page.id);
}

async function deletePageGrant(
  env: Env,
  page: PageSummary,
  actorId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
  context: ExecutionContext,
): Promise<Response> {
  if (!(await requirePageAction(env, page.id, actorId, 'manage_access'))) {
    return error('无权管理页面权限', 403);
  }
  const result = await env.DB.prepare(
    `DELETE FROM page_grants
      WHERE organization_id = ? AND page_id = ? AND principal_type = ? AND principal_id = ?`,
  )
    .bind(page.organizationId, page.id, principalType, principalId)
    .run();
  if (!result.meta.changes) return error('页面授权不存在', 404);
  await pageAudit(env, page, actorId, 'page.grant.removed', { principalType, principalId });
  await bumpPageSubtreeAcl(env, page.id, context);
  return pageAccessSnapshot(env, page.id);
}

function pageGrantPrincipalType(value: string): SpaceGrantPrincipalType | null {
  return value === 'organization' || value === 'user' || value === 'group' ? value : null;
}

async function issueTicket(
  request: Request,
  env: Env,
  pageId: string,
  authenticatedUser: AuthUserSummary,
): Promise<Response> {
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) {
    return error('协作服务尚未配置', 503);
  }
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);
  if (!page.collaborationEnabled) return error('此页面已停止协作', 403);

  const body = (await request.json().catch(() => ({}))) as {
    actorId?: unknown;
    displayName?: unknown;
  };
  const actorId = authenticatedUser.id;
  const displayName =
    authenticatedUser.displayName ||
    (typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 60) : '');
  if (!actorId || !displayName) return error('协作者身份无效', 400);
  const authorized = await requirePageAction(env, pageId, actorId, 'view');
  if (!authorized) {
    return error('页面不存在或无权访问', 404);
  }
  const ticketRole =
    authorized.role === 'space_admin' || authorized.role === 'editor' ? 'editor' : 'viewer';

  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60 * 1000;
  const ticket = await signCollabTicket(
    {
      version: 1,
      pageId,
      generation: page.currentGeneration,
      actorId,
      displayName,
      role: ticketRole,
      aclVersion: page.aclVersion,
      issuedAt,
      expiresAt,
    },
    env.COLLAB_TICKET_SECRET,
  );
  return json({ ticket, expiresAt, generation: page.currentGeneration });
}

async function setCollaborationAccess(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  if (
    !env.PHASE0_ADMIN_SECRET ||
    request.headers.get('authorization') !== `Bearer ${env.PHASE0_ADMIN_SECRET}`
  ) {
    return error('无权修改协作状态', 401);
  }
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') return error('enabled 必须是布尔值', 400);
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);

  const nextVersion = page.aclVersion + 1;
  await env.DB.prepare(
    `UPDATE page_access_state
        SET collaboration_enabled = ?, acl_version = ?, updated_at = ?
      WHERE page_id = ?`,
  )
    .bind(body.enabled ? 1 : 0, nextVersion, Date.now(), pageId)
    .run();
  invalidateCollaborationPage(pageId);

  const room = env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${page.currentGeneration}`),
  );
  await room.fetch('https://rdocs.internal/internal/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: body.enabled, aclVersion: nextVersion }),
  });
  return json({ page: await findPage(env, pageId) });
}

async function syncCollaborationOverHttp(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && !isCollaborationOriginAllowed(request.url, origin, env.APP_ORIGIN)) {
    return error('Origin 不允许', 403);
  }

  const authorization = request.headers.get('authorization') ?? '';
  const ticketValue = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!ticketValue || !env.COLLAB_TICKET_SECRET) return error('缺少协作凭证', 401);
  const ticket = await verifyCollabTicket(ticketValue, env.COLLAB_TICKET_SECRET);
  if (!ticket || ticket.pageId !== pageId) return error('协作凭证无效或已过期', 401);

  const page = await findPageForCollaboration(env, pageId);
  if (page && page.currentGeneration !== ticket.generation) {
    return json(
      {
        error: '文档已恢复到新的 generation',
        code: 'document_rebased',
        generation: page.currentGeneration,
      },
      {
        status: 409,
        headers: { 'x-rdocs-document-generation': String(page.currentGeneration) },
      },
    );
  }
  if (!page || !page.collaborationEnabled || page.aclVersion !== ticket.aclVersion) {
    return error('页面权限已变化', 403);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_HTTP_SYNC_BODY_BYTES) return error('同步请求过大', 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_HTTP_SYNC_BODY_BYTES) return error('同步请求过大', 413);

  const room = env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${ticket.generation}`),
  );
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'x-rdocs-page-id': pageId,
    'x-rdocs-generation': String(ticket.generation),
    'x-rdocs-actor-id': ticket.actorId,
    'x-rdocs-display-name': ticket.displayName,
    'x-rdocs-role': ticket.role,
    'x-rdocs-acl-version': String(ticket.aclVersion),
    'x-rdocs-editing-enabled': '1',
  });
  const response = await room.fetch('https://rdocs.internal/internal/http-sync', {
    method: 'POST',
    headers,
    body,
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

async function openCollaborationSocket(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return error('需要 WebSocket upgrade', 426);
  }

  if (!isCollaborationOriginAllowed(request.url, request.headers.get('origin'), env.APP_ORIGIN)) {
    return error('Origin 不允许', 403);
  }

  const ticketValue = new URL(request.url).searchParams.get('ticket');
  if (!ticketValue || !env.COLLAB_TICKET_SECRET) return error('缺少协作凭证', 401);
  const ticket = await verifyCollabTicket(ticketValue, env.COLLAB_TICKET_SECRET);
  if (!ticket || ticket.pageId !== pageId) return error('协作凭证无效或已过期', 401);

  const page = await findPage(env, pageId);
  if (
    !page ||
    !page.collaborationEnabled ||
    page.currentGeneration !== ticket.generation ||
    page.aclVersion !== ticket.aclVersion
  ) {
    return error('页面权限或 generation 已变化', 403);
  }

  const room = env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${ticket.generation}`),
  );
  const headers = new Headers(request.headers);
  headers.set('x-rdocs-page-id', pageId);
  headers.set('x-rdocs-generation', String(ticket.generation));
  headers.set('x-rdocs-actor-id', ticket.actorId);
  headers.set('x-rdocs-display-name', ticket.displayName);
  headers.set('x-rdocs-role', ticket.role);
  headers.set('x-rdocs-acl-version', String(ticket.aclVersion));
  headers.set('x-rdocs-editing-enabled', '1');
  return room.fetch(new Request(request, { headers }));
}

async function handleApi(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return json({
      ok: database?.ok === 1,
      product: 'Rdocs',
      environment: env.ENVIRONMENT ?? 'unknown',
      release: env.RELEASE_SHA ?? 'local',
      platform: 'randallflare',
    });
  }

  const publicShareMatch = url.pathname.match(/^\/api\/public\/shares\/([^/]+)$/);
  if (publicShareMatch?.[1] && request.method === 'GET') {
    return resolvePublicShare(request, env, decodeURIComponent(publicShareMatch[1]));
  }

  const publicFormResponse = await handlePublicDatabaseFormsApi(request, env);
  if (publicFormResponse) return publicFormResponse;

  const ticketedSyncMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collaboration-sync$/);
  if (ticketedSyncMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(ticketedSyncMatch[1]);
    return isPageId(pageId)
      ? syncCollaborationOverHttp(request, env, pageId)
      : error('页面 ID 无效', 400);
  }

  const publicAttachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (publicAttachmentMatch?.[1] && request.method === 'GET') {
    const attachmentId = decodeURIComponent(publicAttachmentMatch[1]);
    if (!isPageId(attachmentId)) return error('附件 ID 无效', 400);
    const attachment = await findAttachment(env, attachmentId);
    if (attachment && (await canPubliclyDownloadAttachment(request, env, attachment))) {
      return downloadAttachment(env, attachment);
    }
  }

  const authResponse = await handleAuthApi(request, env, context);
  if (authResponse) return authResponse;
  const auth = await authenticateRequest(request, env, context);
  if (!auth.user) return error('请先使用设备密钥登录', 401);
  if (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
    !isTrustedMutationOrigin(request, env)
  ) {
    return error('请求来源不允许', 403);
  }
  const actorId = auth.user.id;
  const actor = auth.user;

  const tenancyResponse = await handleTenancyApi(request, env, actor, context);
  if (tenancyResponse) return tenancyResponse;
  const commentsResponse = await handleCommentsAndNotificationsApi(request, env, actor);
  if (commentsResponse) return commentsResponse;
  const databasesResponse = await handleDatabasesApi(request, env, actor);
  if (databasesResponse) return databasesResponse;

  if (url.pathname === '/api/search' && request.method === 'GET') {
    const organizationId = url.searchParams.get('organizationId') ?? '';
    return organizationId
      ? searchPages(env, organizationId, actorId, url.searchParams.get('q') ?? '')
      : error('缺少组织 ID', 400);
  }

  if (url.pathname === '/api/recent' && request.method === 'GET') {
    const organizationId = url.searchParams.get('organizationId') ?? '';
    return organizationId
      ? listPageActivity(env, organizationId, actorId, 'recent')
      : error('缺少组织 ID', 400);
  }

  if (url.pathname === '/api/favorites' && request.method === 'GET') {
    const organizationId = url.searchParams.get('organizationId') ?? '';
    return organizationId
      ? listPageActivity(env, organizationId, actorId, 'favorites')
      : error('缺少组织 ID', 400);
  }

  if (url.pathname === '/api/pages' && request.method === 'POST') {
    return createPage(request, env, actorId);
  }

  if (url.pathname === '/api/pages' && request.method === 'GET') {
    const spaceId = url.searchParams.get('spaceId') ?? '';
    return spaceId ? listPages(env, spaceId, actorId) : error('缺少目标空间', 400);
  }

  const spaceTreeMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)\/tree$/);
  if (spaceTreeMatch?.[1] && request.method === 'GET') {
    return listPages(env, decodeURIComponent(spaceTreeMatch[1]), actorId);
  }

  const spaceTrashMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)\/trash$/);
  if (spaceTrashMatch?.[1] && request.method === 'GET') {
    return listTrash(env, decodeURIComponent(spaceTrashMatch[1]), actorId);
  }

  const markdownImportMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)\/import\/markdown$/);
  if (markdownImportMatch?.[1] && request.method === 'POST') {
    return importMarkdown(request, env, decodeURIComponent(markdownImportMatch[1]), actorId);
  }

  const restorePageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/restore$/);
  if (restorePageMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(restorePageMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    return (await requireDeletedPageAction(env, pageId, actorId, 'restore'))
      ? restorePage(env, pageId, actorId)
      : error('页面不存在或无权恢复', 404);
  }

  const movePageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/move$/);
  if (movePageMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(movePageMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (await isDatabaseRowPage(env, pageId)) {
      return error('数据库记录必须在数据库视图中移动', 409, 'database_row_managed');
    }
    const authorized = await requirePageAction(env, pageId, actorId, 'move');
    return authorized
      ? movePage(request, env, authorized.page, actorId)
      : error('页面不存在或无权移动', 404);
  }

  const copyPageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/copy$/);
  if (copyPageMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(copyPageMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (await isDatabaseRowPage(env, pageId)) {
      return error('请在数据库视图中复制记录', 409, 'database_row_managed');
    }
    const authorized = await requirePageAction(env, pageId, actorId, 'view');
    return authorized
      ? copyPage(request, env, authorized.page, actorId)
      : error('页面不存在或无权复制', 404);
  }

  const pageAccessMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/access$/);
  if (pageAccessMatch?.[1]) {
    const pageId = decodeURIComponent(pageAccessMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    const authorized = await requirePageAction(env, pageId, actorId, 'manage_access');
    if (!authorized) return error('页面不存在或无权管理访问', 404);
    if (request.method === 'GET') return listPageAccess(env, authorized.page, actorId);
    if (request.method === 'PATCH') {
      return updatePageAccessMode(request, env, authorized.page, actorId, context);
    }
  }

  const pageGrantMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/grants\/([^/]+)\/([^/]+)$/);
  if (pageGrantMatch?.[1] && pageGrantMatch[2] && pageGrantMatch[3]) {
    const pageId = decodeURIComponent(pageGrantMatch[1]);
    const type = pageGrantPrincipalType(decodeURIComponent(pageGrantMatch[2]));
    const principalId = decodeURIComponent(pageGrantMatch[3]);
    if (!isPageId(pageId) || !type || !/^[a-z0-9][a-z0-9_-]{2,100}$/i.test(principalId)) {
      return error('页面授权主体无效', 400);
    }
    const authorized = await requirePageAction(env, pageId, actorId, 'manage_access');
    if (!authorized) return error('页面不存在或无权管理访问', 404);
    if (request.method === 'PUT') {
      return putPageGrant(request, env, authorized.page, actorId, type, principalId, context);
    }
    if (request.method === 'DELETE') {
      return deletePageGrant(env, authorized.page, actorId, type, principalId, context);
    }
  }

  const pageAttachmentsMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/attachments$/);
  if (pageAttachmentsMatch?.[1]) {
    const pageId = decodeURIComponent(pageAttachmentsMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    const action: SpaceAction = request.method === 'POST' ? 'edit_content' : 'view';
    const authorized = await requirePageAction(env, pageId, actorId, action);
    if (!authorized) return error('页面不存在或无权访问附件', 404);
    if (request.method === 'GET') return listAttachments(env, authorized.page);
    if (request.method === 'POST') {
      return uploadAttachment(request, env, authorized.page, actorId);
    }
  }

  const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch?.[1] && (request.method === 'GET' || request.method === 'DELETE')) {
    const attachmentId = decodeURIComponent(attachmentMatch[1]);
    if (!isPageId(attachmentId)) return error('附件 ID 无效', 400);
    const attachment = await findAttachment(env, attachmentId);
    if (!attachment) return error('附件不存在', 404);
    const action: SpaceAction = request.method === 'GET' ? 'download_attachment' : 'edit_content';
    const authorized = await requirePageAction(env, attachment.page_id, actorId, action);
    if (!authorized) return error('附件不存在或无权访问', 404);
    return request.method === 'GET'
      ? downloadAttachment(env, attachment)
      : deleteAttachment(env, attachment, authorized.page, actorId);
  }

  const pageShareLinksMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/share-links$/);
  if (pageShareLinksMatch?.[1]) {
    const pageId = decodeURIComponent(pageShareLinksMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    const authorized = await requirePageAction(env, pageId, actorId, 'manage_access');
    if (!authorized) return error('页面不存在或无权管理分享', 404);
    if (request.method === 'GET') return listShareLinks(env, authorized.page);
    if (request.method === 'POST') {
      return createShareLink(request, env, authorized.page, actorId);
    }
  }

  const shareLinkMatch = url.pathname.match(/^\/api\/share-links\/([^/]+)$/);
  if (shareLinkMatch?.[1] && request.method === 'DELETE') {
    const shareLinkId = decodeURIComponent(shareLinkMatch[1]);
    if (!isPageId(shareLinkId)) return error('分享链接 ID 无效', 400);
    const share = await env.DB.prepare('SELECT page_id FROM share_links WHERE id = ?')
      .bind(shareLinkId)
      .first<{ page_id: string }>();
    if (!share) return error('分享链接不存在', 404);
    const authorized = await requirePageAction(env, share.page_id, actorId, 'manage_access');
    if (!authorized) return error('分享链接不存在或无权管理', 404);
    return revokeShareLink(env, authorized.page, shareLinkId, actorId, context);
  }

  const pageRevisionsMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/revisions$/);
  if (pageRevisionsMatch?.[1]) {
    const pageId = decodeURIComponent(pageRevisionsMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (request.method === 'GET') {
      return (await requirePageAction(env, pageId, actorId, 'view'))
        ? listRevisions(env, pageId)
        : error('页面不存在或无权访问', 404);
    }
    if (request.method === 'POST') {
      return (await requirePageAction(env, pageId, actorId, 'create_revision'))
        ? createRevision(request, env, pageId, actorId)
        : error('页面不存在或无权创建版本', 404);
    }
  }

  const markdownExportMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/export\/markdown$/);
  if (markdownExportMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(markdownExportMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    const authorized = await requirePageAction(env, pageId, actorId, 'export');
    return authorized
      ? exportPageMarkdown(env, authorized.page, actorId)
      : error('页面不存在或无权导出', 404);
  }

  const favoriteMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/favorite$/);
  if (favoriteMatch?.[1] && (request.method === 'PUT' || request.method === 'DELETE')) {
    const pageId = decodeURIComponent(favoriteMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    const authorized = await requirePageAction(env, pageId, actorId, 'view');
    return authorized
      ? setFavorite(env, authorized.page, actorId, request.method === 'PUT')
      : error('页面不存在或无权收藏', 404);
  }

  const restoreRevisionMatch = url.pathname.match(/^\/api\/revisions\/([^/]+)\/restore$/);
  if (restoreRevisionMatch?.[1] && request.method === 'POST') {
    const revisionId = decodeURIComponent(restoreRevisionMatch[1]);
    if (!isPageId(revisionId)) return error('版本 ID 无效', 400);
    const revision = await findRevision(env, revisionId);
    if (!revision || !(await requirePageAction(env, revision.page_id, actorId, 'restore'))) {
      return error('版本不存在或无权恢复', 404);
    }
    return restoreRevision(request, env, revisionId, actorId, context);
  }

  const revisionSnapshotMatch = url.pathname.match(/^\/api\/revisions\/([^/]+)\/snapshot$/);
  if (revisionSnapshotMatch?.[1] && request.method === 'GET') {
    const revisionId = decodeURIComponent(revisionSnapshotMatch[1]);
    if (!isPageId(revisionId)) return error('版本 ID 无效', 400);
    const revision = await findRevision(env, revisionId);
    if (!revision || !(await requirePageAction(env, revision.page_id, actorId, 'view'))) {
      return error('版本不存在或无权预览', 404);
    }
    return revisionSnapshot(env, revision);
  }

  const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
  if (pageMatch?.[1]) {
    const pageId = decodeURIComponent(pageMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (request.method === 'GET') {
      const authorized = await requirePageAction(env, pageId, actorId, 'view');
      if (authorized) context.waitUntil(recordPageVisit(env, pageId, actorId));
      return authorized
        ? json({ page: { ...authorized.page, role: authorized.role } })
        : error('页面不存在或无权访问', 404);
    }
    if (request.method === 'PATCH') {
      return (await requirePageAction(env, pageId, actorId, 'edit_content'))
        ? updatePage(request, env, pageId, actorId)
        : error('页面不存在或无权编辑', 404);
    }
    if (request.method === 'DELETE') {
      if (await isDatabaseRowPage(env, pageId)) {
        return error('请在数据库视图中归档记录', 409, 'database_row_managed');
      }
      const authorized = await requirePageAction(env, pageId, actorId, 'delete');
      return authorized
        ? deletePage(env, authorized.page, actorId, context)
        : error('页面不存在或无权删除', 404);
    }
  }

  const ticketMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collab-ticket$/);
  if (ticketMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(ticketMatch[1]);
    return isPageId(pageId)
      ? issueTicket(request, env, pageId, auth.user)
      : error('页面 ID 无效', 400);
  }

  const httpSyncMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collaboration-sync$/);
  if (httpSyncMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(httpSyncMatch[1]);
    return isPageId(pageId)
      ? syncCollaborationOverHttp(request, env, pageId)
      : error('页面 ID 无效', 400);
  }

  const accessMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collaboration-access$/);
  if (accessMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(accessMatch[1]);
    return isPageId(pageId)
      ? setCollaborationAccess(request, env, pageId)
      : error('页面 ID 无效', 400);
  }

  return error('API 路径不存在', 404);
}

function htmlResponse(): Response {
  return new Response(appHtml, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'permissions-policy': 'publickey-credentials-create=(self), publickey-credentials-get=(self)',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    const route = url.pathname.startsWith('/api/')
      ? '/api/*'
      : url.pathname.startsWith('/collab/')
        ? '/collab/*'
        : 'spa';
    try {
      let response: Response;
      if (url.pathname.startsWith('/api/')) {
        response = await handleApi(request, env, context);
      } else {
        const collabMatch = url.pathname.match(/^\/collab\/([^/]+)$/);
        if (collabMatch?.[1]) {
          const pageId = decodeURIComponent(collabMatch[1]);
          response = isPageId(pageId)
            ? await openCollaborationSocket(request, env, pageId)
            : error('页面 ID 无效', 400);
        } else if (request.method === 'GET' || request.method === 'HEAD') {
          response = htmlResponse();
        } else {
          response = error('Method not allowed', 405);
        }
      }

      if (response.status !== 101) {
        try {
          response.headers.set('x-request-id', requestId);
        } catch {
          // Some runtime-owned responses expose immutable headers.
        }
      }
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'request_completed',
          requestId,
          environment: env.ENVIRONMENT ?? 'unknown',
          method: request.method,
          route,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          outcome: response.ok || response.status === 101 ? 'ok' : 'error',
        }),
      );
      return response;
    } catch (reason) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'request_failed',
          requestId,
          environment: env.ENVIRONMENT ?? 'unknown',
          method: request.method,
          route,
          latencyMs: Date.now() - startedAt,
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
      const response = error('服务暂时不可用', 500);
      response.headers.set('x-request-id', requestId);
      return response;
    }
  },
};
