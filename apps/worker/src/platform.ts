import {
  EDITOR_SCHEMA_VERSION,
  isPageId,
  type AiJobKind,
  type AiJobSummary,
  type AiSettingsSummary,
  type ApiTokenScope,
  type ApiTokenSummary,
  type AuthUserSummary,
  type CalendarConnectionSummary,
  type CreatedApiToken,
  type DatabasePropertyGrantRole,
  type DatabasePropertyGrantSummary,
  type EnterpriseSettingsSummary,
  type ExportJobSummary,
  type IntegrationWebhookSummary,
  type JsonValue,
  type LegalHoldSummary,
  type OfflinePinSummary,
  type PageSummary,
} from '@rdocs/shared';

import {
  canManageOrganization,
  findActiveMembership,
  requirePageAction,
  requireSpaceAction,
  type SpaceAction,
} from './access';
import type { Env } from './env';
import { handleDatabasesApi } from './databases';

const API_SCOPES = new Set<ApiTokenScope>([
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'search:read',
  'admin',
]);
const TOKEN_PREFIX = 'rdocs_';
const MAX_TOKENS_PER_USER = 20;
const MAX_EXPORT_PAGES = 400;
const MAX_AI_PROMPT = 8_000;

interface TokenRow {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes_json: string;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

interface PageExportRow {
  id: string;
  title: string;
  parent_id: string | null;
  space_id: string;
  updated_at: number;
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

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  return new Response(response.body, { status: response.status, headers });
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json<unknown>().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function authorizePage(
  env: Env,
  pageId: string,
  userId: string,
  action: SpaceAction,
): Promise<PageSummary | null> {
  const access = await requirePageAction(env, pageId, userId, action);
  if (!access) return null;
  const row = await env.DB.prepare(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title, p.icon,
            p.cover_attachment_id, p.font_style, p.is_full_width, p.is_small_text,
            p.is_locked, p.current_generation, p.editor_schema_version, p.updated_at,
            a.collaboration_enabled, a.acl_version
       FROM pages p JOIN page_access_state a ON a.page_id = p.id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(pageId)
    .first<{
      id: string;
      organization_id: string;
      space_id: string;
      parent_id: string | null;
      title: string;
      icon: string | null;
      cover_attachment_id: string | null;
      font_style: PageSummary['fontStyle'];
      is_full_width: number;
      is_small_text: number;
      is_locked: number;
      current_generation: number;
      editor_schema_version: number;
      updated_at: number;
      collaboration_enabled: number;
      acl_version: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    icon: row.icon,
    coverAttachmentId: row.cover_attachment_id,
    fontStyle: row.font_style,
    isFullWidth: Boolean(row.is_full_width),
    isSmallText: Boolean(row.is_small_text),
    isLocked: Boolean(row.is_locked),
    currentGeneration: Number(row.current_generation),
    editorSchemaVersion: Number(row.editor_schema_version),
    updatedAt: Number(row.updated_at),
    collaborationEnabled: Boolean(row.collaboration_enabled),
    aclVersion: Number(row.acl_version),
    role: access.spaceRole,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseScopes(value: unknown): ApiTokenScope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes = value.filter((item): item is ApiTokenScope =>
    API_SCOPES.has(item as ApiTokenScope),
  );
  return scopes.length === value.length && scopes.length > 0 ? [...new Set(scopes)] : null;
}

function tokenSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: JSON.parse(row.scopes_json) as ApiTokenScope[],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: Number(row.created_at),
  };
}

async function requireOrgManager(
  env: Env,
  organizationId: string,
  userId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof findActiveMembership>>> | null> {
  const membership = await findActiveMembership(env, organizationId, userId);
  if (!membership || !canManageOrganization(membership.role, 'manage_members')) return null;
  return membership;
}

async function audit(
  env: Env,
  organizationId: string,
  actorId: string,
  eventType: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events(
       id, organization_id, actor_id, event_type, target_type, target_id,
       request_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      actorId,
      eventType,
      targetType,
      targetId,
      JSON.stringify(metadata),
      Date.now(),
    )
    .run();
}

function hasScope(scopes: readonly ApiTokenScope[], needed: ApiTokenScope): boolean {
  return scopes.includes('admin') || scopes.includes(needed);
}

export async function pagesOnLegalHold(env: Env, pageIds: readonly string[]): Promise<string[]> {
  if (!pageIds.length) return [];
  const placeholders = pageIds.map(() => '?').join(', ');
  const rows = (
    await env.DB.prepare(
      `SELECT page_id FROM legal_holds WHERE released_at IS NULL AND page_id IN (${placeholders})`,
    )
      .bind(...pageIds)
      .all<{ page_id: string }>()
  ).results;
  const orgHold = await env.DB.prepare(
    `SELECT e.organization_id
         FROM enterprise_settings e
         JOIN pages p ON p.organization_id = e.organization_id
        WHERE e.legal_hold = 1 AND p.id IN (${placeholders})
        LIMIT 1`,
  )
    .bind(...pageIds)
    .first<{ organization_id: string }>();
  if (orgHold) return [...pageIds];
  return rows.map((row) => row.page_id);
}

function exportJobSummary(row: {
  id: string;
  organization_id: string;
  kind: ExportJobSummary['kind'];
  scope_id: string | null;
  format: ExportJobSummary['format'];
  status: ExportJobSummary['status'];
  page_count: number;
  result_json: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}): ExportJobSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    scopeId: row.scope_id,
    format: row.format,
    status: row.status,
    pageCount: Number(row.page_count),
    result: row.result_json ? (JSON.parse(row.result_json) as Record<string, JsonValue>) : null,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

async function createExportJob(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  kind: ExportJobSummary['kind'],
  format: ExportJobSummary['format'],
  scopeId: string | null,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership) return error('组织不存在或无权导出', 404);
  const now = Date.now();
  let sql = `SELECT id, title, parent_id, space_id, updated_at
               FROM pages
              WHERE organization_id = ? AND deleted_at IS NULL`;
  const binds: unknown[] = [organizationId];
  if (kind === 'space') {
    if (!scopeId) return error('缺少空间 ID', 400);
    sql += ' AND space_id = ?';
    binds.push(scopeId);
  } else if (kind === 'page') {
    if (!scopeId || !isPageId(scopeId)) return error('缺少页面 ID', 400);
    const authorized = await requirePageAction(env, scopeId, actor.id, 'export');
    if (!authorized) return error('页面不存在或无权导出', 404);
    sql += ' AND (id = ? OR parent_id = ?)';
    binds.push(scopeId, scopeId);
  }
  sql += ' ORDER BY space_id, parent_id, title LIMIT ?';
  binds.push(MAX_EXPORT_PAGES);
  const pages = (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<PageExportRow>()
  ).results;
  const visible: PageExportRow[] = [];
  for (const page of pages) {
    if (await requirePageAction(env, page.id, actor.id, 'view')) visible.push(page);
  }
  const files = visible.map((page) => ({
    path: `${page.space_id}/${page.id}.md`,
    title: page.title,
    pageId: page.id,
    markdown: `# ${page.title}\n\n<!-- rdocs:${page.id} -->\n`,
    updatedAt: Number(page.updated_at),
  }));
  const result =
    format === 'json'
      ? { pages: files }
      : format === 'csv'
        ? {
            csv: [
              'page_id,title,space_id,updated_at',
              ...files.map(
                (file) =>
                  `${file.pageId},"${file.title.replaceAll('"', '""')}",${file.path.split('/')[0]},${file.updatedAt}`,
              ),
            ].join('\n'),
          }
        : { files };
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO export_jobs(
       id, organization_id, actor_id, kind, scope_id, format, status, page_count,
       result_json, created_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      actor.id,
      kind,
      scopeId,
      format,
      files.length,
      JSON.stringify(result),
      now,
      now,
    )
    .run();
  await audit(env, organizationId, actor.id, 'export.created', 'organization', organizationId, {
    exportId: id,
    kind,
    format,
    pageCount: files.length,
  });
  const job = await env.DB.prepare(
    `SELECT id, organization_id, kind, scope_id, format, status, page_count, result_json,
            error_message, created_at, completed_at
       FROM export_jobs WHERE id = ?`,
  )
    .bind(id)
    .first<Parameters<typeof exportJobSummary>[0]>();
  return json({ job: job ? exportJobSummary(job) : null }, { status: 201 });
}

async function authenticateBearer(
  request: Request,
  env: Env,
): Promise<{ user: AuthUserSummary; scopes: ApiTokenScope[]; organizationId: string } | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 20) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT t.id, t.organization_id, t.user_id, t.name, t.token_hash, t.token_prefix,
            t.scopes_json, t.expires_at, t.last_used_at, t.revoked_at, t.created_at,
            u.email, u.display_name, u.avatar_url
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id AND u.status = 'active'
      WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
  )
    .bind(hash)
    .first<TokenRow>();
  if (!row) return null;
  if (row.expires_at !== null && Number(row.expires_at) <= Date.now()) return null;
  const membership = await findActiveMembership(env, row.organization_id, row.user_id);
  if (!membership) return null;
  await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
    .bind(Date.now(), row.id)
    .run();
  return {
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    scopes: JSON.parse(row.scopes_json) as ApiTokenScope[],
    organizationId: row.organization_id,
  };
}

export async function handlePublicApi(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/')) return null;
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }
  const auth = await authenticateBearer(request, env);
  if (!auth) return cors(error('API 令牌无效或已过期', 401, 'invalid_token'));

  if (url.pathname === '/api/v1/users/me' && request.method === 'GET') {
    return cors(
      json({ user: auth.user, organizationId: auth.organizationId, scopes: auth.scopes }),
    );
  }

  const pageMatch = url.pathname.match(/^\/api\/v1\/pages\/([^/]+)$/);
  if (pageMatch?.[1]) {
    if (!hasScope(auth.scopes, request.method === 'GET' ? 'pages:read' : 'pages:write')) {
      return cors(error('令牌缺少页面权限', 403, 'insufficient_scope'));
    }
    const pageId = decodeURIComponent(pageMatch[1]);
    if (!isPageId(pageId)) return cors(error('页面 ID 无效', 400));
    if (request.method === 'GET') {
      const authorized = await authorizePage(env, pageId, auth.user.id, 'view');
      return cors(
        authorized ? json({ page: authorized }) : error('页面不存在或无权访问', 404),
      );
    }
    if (request.method === 'PATCH') {
      const authorized = await authorizePage(env, pageId, auth.user.id, 'edit_content');
      if (!authorized) return cors(error('页面不存在或无权编辑', 404));
      const body = await requestBody(request);
      const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 200) : '';
      if (!title) return cors(error('标题无效', 400));
      await env.DB.prepare(
        'UPDATE pages SET title = ?, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      )
        .bind(title, auth.user.id, Date.now(), pageId)
        .run();
      const updated = await authorizePage(env, pageId, auth.user.id, 'view');
      return cors(updated ? json({ page: updated }) : error('页面不存在', 404));
    }
    return cors(error('方法不允许', 405));
  }

  if (url.pathname === '/api/v1/pages' && request.method === 'POST') {
    if (!hasScope(auth.scopes, 'pages:write'))
      return cors(error('令牌缺少页面写权限', 403, 'insufficient_scope'));
    const body = await requestBody(request);
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 200) : '未命名页面';
    const spaceId = typeof body?.spaceId === 'string' ? body.spaceId : '';
    const parentId =
      typeof body?.parentId === 'string' && isPageId(body.parentId) ? body.parentId : null;
    if (!spaceId) return cors(error('缺少空间 ID', 400));
    const spaceAccess = await requireSpaceAction(env, spaceId, auth.user.id, 'create_child');
    if (!spaceAccess || spaceAccess.organizationId !== auth.organizationId) {
      return cors(error('空间不存在或无权创建页面', 404));
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
        auth.organizationId,
        spaceId,
        parentId,
        title,
        now.toString().padStart(20, '0'),
        EDITOR_SCHEMA_VERSION,
        auth.user.id,
        auth.user.id,
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
      ).bind(id, auth.organizationId, spaceId, title, now),
    ]);
    const authorized = await authorizePage(env, id, auth.user.id, 'view');
    return cors(
      authorized ? json({ page: authorized }, { status: 201 }) : error('页面创建失败', 500),
    );
  }

  const databaseMatch = url.pathname.match(/^\/api\/v1\/databases\/([^/]+)$/);
  if (databaseMatch?.[1] && request.method === 'GET') {
    if (!hasScope(auth.scopes, 'databases:read')) {
      return cors(error('令牌缺少数据库读权限', 403, 'insufficient_scope'));
    }
    const forwarded = new Request(`${url.origin}/api/databases/${databaseMatch[1]}${url.search}`, {
      method: 'GET',
      headers: request.headers,
    });
    return cors(
      (await handleDatabasesApi(forwarded, env, auth.user)) ?? error('数据库不存在', 404),
    );
  }

  if (url.pathname === '/api/v1/search' && request.method === 'GET') {
    if (!hasScope(auth.scopes, 'search:read'))
      return cors(error('令牌缺少搜索权限', 403, 'insufficient_scope'));
    const query = (url.searchParams.get('q') ?? '').trim();
    const organizationId = url.searchParams.get('organizationId') ?? auth.organizationId;
    if (organizationId !== auth.organizationId) return cors(error('不能搜索其他组织', 403));
    if (!query) return cors(json({ results: [] }));
    const rows = (
      await env.DB.prepare(
        `SELECT p.id, COALESCE(s.normalized_body, '') AS snippet
           FROM pages p
           LEFT JOIN page_search_projection s ON s.page_id = p.id
          WHERE p.organization_id = ? AND p.deleted_at IS NULL
            AND (p.title LIKE ? OR COALESCE(s.normalized_body, '') LIKE ?)
          ORDER BY p.updated_at DESC
          LIMIT 25`,
      )
        .bind(organizationId, `%${query}%`, `%${query}%`)
        .all<{ id: string; snippet: string }>()
    ).results;
    const results = [];
    for (const row of rows) {
      const authorized = await authorizePage(env, row.id, auth.user.id, 'view');
      if (authorized) {
        results.push({ page: authorized, snippet: row.snippet.slice(0, 180) });
      }
    }
    return cors(json({ results }));
  }

  void context;
  return cors(error('API 路径不存在', 404));
}

interface PageSummaryRow {
  snippet?: string;
}

async function handleSessionPlatformApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response | null> {
  const url = new URL(request.url);

  const tokensMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/api-tokens$/);
  if (tokensMatch?.[1]) {
    const organizationId = decodeURIComponent(tokensMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理令牌', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT t.id, t.organization_id, t.user_id, t.name, t.token_hash, t.token_prefix,
                  t.scopes_json, t.expires_at, t.last_used_at, t.revoked_at, t.created_at,
                  u.email, u.display_name, u.avatar_url
             FROM api_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.organization_id = ? AND t.user_id = ?
            ORDER BY t.created_at DESC`,
        )
          .bind(organizationId, actor.id)
          .all<TokenRow>()
      ).results;
      return json({ tokens: rows.map(tokenSummary) });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '';
      const scopes = parseScopes(input?.scopes);
      if (!name || !scopes) return error('令牌名称或权限无效', 400);
      const count = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL',
      )
        .bind(actor.id)
        .first<{ count: number }>();
      if (Number(count?.count ?? 0) >= MAX_TOKENS_PER_USER) return error('令牌数量已达上限', 409);
      const raw = `${TOKEN_PREFIX}${[...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO api_tokens(
           id, organization_id, user_id, name, token_hash, token_prefix, scopes_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          organizationId,
          actor.id,
          name,
          await sha256Hex(raw),
          raw.slice(0, 12),
          JSON.stringify(scopes),
          now,
        )
        .run();
      await audit(env, organizationId, actor.id, 'api_token.created', 'api_token', id, {
        name,
        scopes,
      });
      const created: CreatedApiToken = {
        id,
        organizationId,
        name,
        tokenPrefix: raw.slice(0, 12),
        scopes,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        token: raw,
      };
      return json({ token: created }, { status: 201 });
    }
  }

  const tokenMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/api-tokens\/([^/]+)$/);
  if (tokenMatch?.[1] && tokenMatch[2] && request.method === 'DELETE') {
    const organizationId = decodeURIComponent(tokenMatch[1]);
    const tokenId = decodeURIComponent(tokenMatch[2]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理令牌', 404);
    const result = await env.DB.prepare(
      `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND organization_id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
      .bind(Date.now(), tokenId, organizationId, actor.id)
      .run();
    if (!result.meta.changes) return error('令牌不存在', 404);
    await audit(env, organizationId, actor.id, 'api_token.revoked', 'api_token', tokenId);
    return json({ ok: true });
  }

  const exportsMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/exports$/);
  if (exportsMatch?.[1]) {
    const organizationId = decodeURIComponent(exportsMatch[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权导出', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, organization_id, kind, scope_id, format, status, page_count, result_json,
                  error_message, created_at, completed_at
             FROM export_jobs WHERE organization_id = ? AND actor_id = ?
            ORDER BY created_at DESC LIMIT 20`,
        )
          .bind(organizationId, actor.id)
          .all<Parameters<typeof exportJobSummary>[0]>()
      ).results;
      return json({ jobs: rows.map(exportJobSummary) });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const kind = input?.kind;
      const format = input?.format;
      if (kind !== 'workspace' && kind !== 'space' && kind !== 'page')
        return error('导出范围无效', 400);
      if (format !== 'markdown' && format !== 'json' && format !== 'csv')
        return error('导出格式无效', 400);
      return createExportJob(
        env,
        actor,
        organizationId,
        kind,
        format,
        typeof input?.scopeId === 'string' ? input.scopeId : null,
      );
    }
  }

  const webhooksMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/webhooks$/);
  if (webhooksMatch?.[1]) {
    const organizationId = decodeURIComponent(webhooksMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理 Webhook', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, organization_id, name, url, events_json, enabled, created_at, updated_at
             FROM integration_webhooks WHERE organization_id = ? ORDER BY created_at DESC`,
        )
          .bind(organizationId)
          .all<{
            id: string;
            organization_id: string;
            name: string;
            url: string;
            events_json: string;
            enabled: number;
            created_at: number;
            updated_at: number;
          }>()
      ).results;
      return json({
        webhooks: rows.map((row): IntegrationWebhookSummary => ({
          id: row.id,
          organizationId: row.organization_id,
          name: row.name,
          url: row.url,
          events: JSON.parse(row.events_json) as string[],
          enabled: Boolean(row.enabled),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        })),
      });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '';
      const hookUrl = typeof input?.url === 'string' ? input.url.trim() : '';
      const events = Array.isArray(input?.events)
        ? input.events.filter((item): item is string => typeof item === 'string').slice(0, 20)
        : [];
      if (!name || !/^https:\/\//i.test(hookUrl) || !events.length) {
        return error('Webhook 名称、HTTPS 地址或事件无效', 400);
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      const secret = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      try {
        await env.DB.prepare(
          `INSERT INTO integration_webhooks(
             id, organization_id, name, url, secret, events_json, enabled, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
          .bind(
            id,
            organizationId,
            name,
            hookUrl,
            secret,
            JSON.stringify(events),
            actor.id,
            now,
            now,
          )
          .run();
      } catch {
        return error('已有同名 Webhook', 409);
      }
      return json(
        {
          webhook: {
            id,
            organizationId,
            name,
            url: hookUrl,
            events,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          } satisfies IntegrationWebhookSummary,
          secret,
        },
        { status: 201 },
      );
    }
  }

  const webhookMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/webhooks\/([^/]+)$/);
  if (webhookMatch?.[1] && webhookMatch[2] && request.method === 'DELETE') {
    const organizationId = decodeURIComponent(webhookMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理 Webhook', 404);
    const result = await env.DB.prepare(
      'DELETE FROM integration_webhooks WHERE id = ? AND organization_id = ?',
    )
      .bind(decodeURIComponent(webhookMatch[2]), organizationId)
      .run();
    if (!result.meta.changes) return error('Webhook 不存在', 404);
    return json({ ok: true });
  }

  const enterpriseMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/enterprise$/);
  if (enterpriseMatch?.[1]) {
    const organizationId = decodeURIComponent(enterpriseMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理企业设置', 404);
    if (request.method === 'GET')
      return json({ settings: await loadEnterpriseSettings(env, organizationId) });
    if (request.method === 'PATCH') {
      const input = await requestBody(request);
      if (!input) return error('请求格式无效', 400);
      const current = await loadEnterpriseSettings(env, organizationId, true);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO enterprise_settings(
           organization_id, saml_enabled, saml_entity_id, saml_sso_url, saml_certificate,
           scim_enabled, scim_token_hash, scim_token_prefix, verified_domain,
           domain_verification_token, domain_verified_at, session_max_age_hours,
           ip_allowlist_json, retention_days, legal_hold, siem_url, siem_secret,
           updated_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           saml_enabled = excluded.saml_enabled,
           saml_entity_id = excluded.saml_entity_id,
           saml_sso_url = excluded.saml_sso_url,
           saml_certificate = COALESCE(excluded.saml_certificate, enterprise_settings.saml_certificate),
           scim_enabled = excluded.scim_enabled,
           verified_domain = excluded.verified_domain,
           session_max_age_hours = excluded.session_max_age_hours,
           ip_allowlist_json = excluded.ip_allowlist_json,
           retention_days = excluded.retention_days,
           legal_hold = excluded.legal_hold,
           siem_url = excluded.siem_url,
           siem_secret = COALESCE(excluded.siem_secret, enterprise_settings.siem_secret),
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
        .bind(
          organizationId,
          input.samlEnabled === true ? 1 : current.samlEnabled ? 1 : 0,
          typeof input.samlEntityId === 'string'
            ? input.samlEntityId.trim() || null
            : current.samlEntityId,
          typeof input.samlSsoUrl === 'string'
            ? input.samlSsoUrl.trim() || null
            : current.samlSsoUrl,
          typeof input.samlCertificate === 'string' ? input.samlCertificate : null,
          input.scimEnabled === true ? 1 : current.scimEnabled ? 1 : 0,
          null,
          current.scimTokenPrefix,
          typeof input.verifiedDomain === 'string'
            ? input.verifiedDomain.trim().toLowerCase() || null
            : current.verifiedDomain,
          current.domainVerificationToken ?? crypto.randomUUID().replace(/-/g, ''),
          current.domainVerifiedAt,
          typeof input.sessionMaxAgeHours === 'number'
            ? Math.min(8760, Math.max(1, Math.floor(input.sessionMaxAgeHours)))
            : current.sessionMaxAgeHours,
          JSON.stringify(
            Array.isArray(input.ipAllowlist) ? input.ipAllowlist : current.ipAllowlist,
          ),
          typeof input.retentionDays === 'number'
            ? Math.max(1, Math.floor(input.retentionDays))
            : current.retentionDays,
          input.legalHold === true ? 1 : current.legalHold ? 1 : 0,
          typeof input.siemUrl === 'string' ? input.siemUrl.trim() || null : current.siemUrl,
          typeof input.siemSecret === 'string' ? input.siemSecret : null,
          actor.id,
          now,
        )
        .run();
      await audit(
        env,
        organizationId,
        actor.id,
        'enterprise.updated',
        'organization',
        organizationId,
      );
      return json({ settings: await loadEnterpriseSettings(env, organizationId) });
    }
  }

  const scimTokenMatch = url.pathname.match(
    /^\/api\/organizations\/([^/]+)\/enterprise\/scim-token$/,
  );
  if (scimTokenMatch?.[1] && request.method === 'POST') {
    const organizationId = decodeURIComponent(scimTokenMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理 SCIM', 404);
    const raw = `scim_${[...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO enterprise_settings(
         organization_id, scim_enabled, scim_token_hash, scim_token_prefix, updated_by, updated_at
       ) VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         scim_enabled = 1,
         scim_token_hash = excluded.scim_token_hash,
         scim_token_prefix = excluded.scim_token_prefix,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
      .bind(organizationId, await sha256Hex(raw), raw.slice(0, 10), actor.id, now)
      .run();
    return json({ token: raw, prefix: raw.slice(0, 10) }, { status: 201 });
  }

  const holdsMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/legal-holds$/);
  if (holdsMatch?.[1]) {
    const organizationId = decodeURIComponent(holdsMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理法务保全', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT h.id, h.organization_id, h.page_id, p.title AS page_title, h.reason,
                  h.created_by, h.created_at, h.released_at
             FROM legal_holds h JOIN pages p ON p.id = h.page_id
            WHERE h.organization_id = ?
            ORDER BY h.created_at DESC LIMIT 100`,
        )
          .bind(organizationId)
          .all<{
            id: string;
            organization_id: string;
            page_id: string;
            page_title: string;
            reason: string;
            created_by: string;
            created_at: number;
            released_at: number | null;
          }>()
      ).results;
      return json({
        holds: rows.map((row): LegalHoldSummary => ({
          id: row.id,
          organizationId: row.organization_id,
          pageId: row.page_id,
          pageTitle: row.page_title,
          reason: row.reason,
          createdBy: row.created_by,
          createdAt: Number(row.created_at),
          releasedAt: row.released_at === null ? null : Number(row.released_at),
        })),
      });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const pageId = typeof input?.pageId === 'string' ? input.pageId : '';
      const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, 300) : '';
      if (!isPageId(pageId) || !reason) return error('页面或保全原因无效', 400);
      const authorized = await requirePageAction(env, pageId, actor.id, 'view');
      if (!authorized || authorized.organizationId !== organizationId) {
        return error('页面不存在或无权保全', 404);
      }
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO legal_holds(id, organization_id, page_id, reason, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, organizationId, pageId, reason, actor.id, Date.now())
          .run();
      } catch {
        return error('该页面已处于法务保全', 409);
      }
      await audit(env, organizationId, actor.id, 'legal_hold.created', 'page', pageId, { reason });
      return json({ ok: true, id }, { status: 201 });
    }
  }

  const holdMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/legal-holds\/([^/]+)$/);
  if (holdMatch?.[1] && holdMatch[2] && request.method === 'DELETE') {
    const organizationId = decodeURIComponent(holdMatch[1]);
    const membership = await requireOrgManager(env, organizationId, actor.id);
    if (!membership) return error('组织不存在或无权管理法务保全', 404);
    const result = await env.DB.prepare(
      `UPDATE legal_holds SET released_at = ? WHERE id = ? AND organization_id = ? AND released_at IS NULL`,
    )
      .bind(Date.now(), decodeURIComponent(holdMatch[2]), organizationId)
      .run();
    if (!result.meta.changes) return error('保全记录不存在', 404);
    return json({ ok: true });
  }

  const aiSettingsMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/ai$/);
  if (aiSettingsMatch?.[1]) {
    const organizationId = decodeURIComponent(aiSettingsMatch[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    if (request.method === 'GET')
      return json({ settings: await loadAiSettings(env, organizationId) });
    if (request.method === 'PATCH') {
      if (!canManageOrganization(membership.role, 'manage_members'))
        return error('无权修改 AI 设置', 403);
      const input = await requestBody(request);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO ai_settings(organization_id, enabled, model, retention, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           enabled = excluded.enabled,
           model = excluded.model,
           retention = excluded.retention,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
        .bind(
          organizationId,
          input?.enabled === false ? 0 : 1,
          typeof input?.model === 'string' && input.model.trim()
            ? input.model.trim().slice(0, 80)
            : 'grok-4.5',
          input?.retention === '30d' || input?.retention === 'indefinite'
            ? input.retention
            : 'none',
          actor.id,
          now,
        )
        .run();
      return json({ settings: await loadAiSettings(env, organizationId) });
    }
  }

  const pageAiMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/ai$/);
  if (pageAiMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(pageAiMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    return runPageAi(request, env, pageId, actor);
  }

  const pinsMatch = url.pathname === '/api/offline-pins';
  if (pinsMatch && request.method === 'GET') {
    const organizationId = url.searchParams.get('organizationId') ?? '';
    if (!organizationId) return error('缺少组织 ID', 400);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    const rows = (
      await env.DB.prepare(
        `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title, p.icon,
                p.cover_attachment_id, p.font_style, p.is_full_width, p.is_small_text,
                p.is_locked, p.current_generation, p.editor_schema_version, p.updated_at,
                a.collaboration_enabled, a.acl_version, pin.created_at AS pinned_at
           FROM offline_pins pin
           JOIN pages p ON p.id = pin.page_id AND p.deleted_at IS NULL
           JOIN page_access_state a ON a.page_id = p.id
          WHERE pin.user_id = ? AND pin.organization_id = ?
          ORDER BY pin.created_at DESC LIMIT 100`,
      )
        .bind(actor.id, organizationId)
        .all<{
          id: string;
          organization_id: string;
          space_id: string;
          parent_id: string | null;
          title: string;
          icon: string | null;
          cover_attachment_id: string | null;
          font_style: PageSummary['fontStyle'];
          is_full_width: number;
          is_small_text: number;
          is_locked: number;
          current_generation: number;
          editor_schema_version: number;
          updated_at: number;
          collaboration_enabled: number;
          acl_version: number;
          pinned_at: number;
        }>()
    ).results;
    const pins: OfflinePinSummary[] = [];
    for (const row of rows) {
      const authorized = await authorizePage(env, row.id, actor.id, 'view');
      if (authorized) pins.push({ page: authorized, createdAt: Number(row.pinned_at) });
    }
    return json({ pins });
  }

  const pinMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/offline-pin$/);
  if (pinMatch?.[1] && (request.method === 'PUT' || request.method === 'DELETE')) {
    const pageId = decodeURIComponent(pinMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    const authorized = await authorizePage(env, pageId, actor.id, 'view');
    if (!authorized) return error('页面不存在或无权离线保存', 404);
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM offline_pins WHERE user_id = ? AND page_id = ?')
        .bind(actor.id, pageId)
        .run();
      return json({ ok: true });
    }
    await env.DB.prepare(
      `INSERT OR REPLACE INTO offline_pins(user_id, page_id, organization_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(actor.id, pageId, authorized.organizationId, Date.now())
      .run();
    return json({ ok: true });
  }

  const calendarMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/calendar-connections$/);
  if (calendarMatch?.[1]) {
    const organizationId = decodeURIComponent(calendarMatch[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, organization_id, provider, name, ics_url, status, error_message, created_at, updated_at
             FROM calendar_connections WHERE organization_id = ? AND user_id = ?
            ORDER BY created_at DESC`,
        )
          .bind(organizationId, actor.id)
          .all<{
            id: string;
            organization_id: string;
            provider: CalendarConnectionSummary['provider'];
            name: string;
            ics_url: string | null;
            status: CalendarConnectionSummary['status'];
            error_message: string | null;
            created_at: number;
            updated_at: number;
          }>()
      ).results;
      return json({
        connections: rows.map((row): CalendarConnectionSummary => ({
          id: row.id,
          organizationId: row.organization_id,
          provider: row.provider,
          name: row.name,
          icsUrl: row.ics_url,
          status: row.status,
          errorMessage: row.error_message,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        })),
      });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '日历';
      const icsUrl = typeof input?.icsUrl === 'string' ? input.icsUrl.trim() : '';
      if (!/^https:\/\//i.test(icsUrl)) return error('ICS 地址必须是 HTTPS', 400);
      const id = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO calendar_connections(
           id, organization_id, user_id, provider, name, ics_url, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'ics', ?, ?, 'configured', ?, ?)`,
      )
        .bind(id, organizationId, actor.id, name, icsUrl, now, now)
        .run();
      return json({ id }, { status: 201 });
    }
  }

  const propertyGrantsMatch = url.pathname.match(
    /^\/api\/databases\/([^/]+)\/properties\/([^/]+)\/grants$/,
  );
  if (propertyGrantsMatch?.[1] && propertyGrantsMatch[2]) {
    const databaseId = decodeURIComponent(propertyGrantsMatch[1]);
    const propertyId = decodeURIComponent(propertyGrantsMatch[2]);
    if (!isPageId(databaseId) || !isPageId(propertyId)) return error('数据库或属性 ID 无效', 400);
    const database = await env.DB.prepare(
      'SELECT id, organization_id, page_id FROM databases WHERE id = ?',
    )
      .bind(databaseId)
      .first<{ id: string; organization_id: string; page_id: string }>();
    if (!database) return error('数据库不存在', 404);
    const access = await requirePageAction(env, database.page_id, actor.id, 'manage_access');
    if (!access) return error('数据库不存在或无权管理列权限', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, database_id, property_id, principal_type, principal_id, role, created_at
             FROM database_property_grants WHERE database_id = ? AND property_id = ?`,
        )
          .bind(databaseId, propertyId)
          .all<{
            id: string;
            database_id: string;
            property_id: string;
            principal_type: DatabasePropertyGrantSummary['principalType'];
            principal_id: string;
            role: DatabasePropertyGrantRole;
            created_at: number;
          }>()
      ).results;
      return json({
        grants: rows.map((row): DatabasePropertyGrantSummary => ({
          id: row.id,
          databaseId: row.database_id,
          propertyId: row.property_id,
          principalType: row.principal_type,
          principalId: row.principal_id,
          role: row.role,
          createdAt: Number(row.created_at),
        })),
      });
    }
    if (request.method === 'PUT') {
      const input = await requestBody(request);
      const principalType = input?.principalType;
      const principalId = typeof input?.principalId === 'string' ? input.principalId : '';
      const role = input?.role;
      if (
        (principalType !== 'user' &&
          principalType !== 'group' &&
          principalType !== 'organization') ||
        !principalId ||
        (role !== 'none' && role !== 'viewer' && role !== 'editor')
      ) {
        return error('列权限主体或角色无效', 400);
      }
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO database_property_grants(
           id, organization_id, database_id, property_id, principal_type, principal_id, role, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(property_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`,
      )
        .bind(
          id,
          database.organization_id,
          databaseId,
          propertyId,
          principalType,
          principalId,
          role,
          Date.now(),
        )
        .run();
      return json({ ok: true });
    }
  }

  return null;
}

async function loadEnterpriseSettings(
  env: Env,
  organizationId: string,
  raw = false,
): Promise<EnterpriseSettingsSummary> {
  const row = await env.DB.prepare(
    `SELECT organization_id, saml_enabled, saml_entity_id, saml_sso_url, saml_certificate,
            scim_enabled, scim_token_prefix, verified_domain, domain_verification_token,
            domain_verified_at, session_max_age_hours, ip_allowlist_json, retention_days,
            legal_hold, siem_url, siem_secret, updated_at
       FROM enterprise_settings WHERE organization_id = ?`,
  )
    .bind(organizationId)
    .first<{
      organization_id: string;
      saml_enabled: number;
      saml_entity_id: string | null;
      saml_sso_url: string | null;
      saml_certificate: string | null;
      scim_enabled: number;
      scim_token_prefix: string | null;
      verified_domain: string | null;
      domain_verification_token: string | null;
      domain_verified_at: number | null;
      session_max_age_hours: number;
      ip_allowlist_json: string;
      retention_days: number | null;
      legal_hold: number;
      siem_url: string | null;
      siem_secret: string | null;
      updated_at: number;
    }>();
  void raw;
  return {
    organizationId,
    samlEnabled: Boolean(row?.saml_enabled),
    samlEntityId: row?.saml_entity_id ?? null,
    samlSsoUrl: row?.saml_sso_url ?? null,
    samlCertificateConfigured: Boolean(row?.saml_certificate),
    scimEnabled: Boolean(row?.scim_enabled),
    scimTokenPrefix: row?.scim_token_prefix ?? null,
    verifiedDomain: row?.verified_domain ?? null,
    domainVerificationToken: row?.domain_verification_token ?? null,
    domainVerifiedAt: row?.domain_verified_at ?? null,
    sessionMaxAgeHours: Number(row?.session_max_age_hours ?? 720),
    ipAllowlist: row ? (JSON.parse(row.ip_allowlist_json) as string[]) : [],
    retentionDays: row?.retention_days ?? null,
    legalHold: Boolean(row?.legal_hold),
    siemUrl: row?.siem_url ?? null,
    siemConfigured: Boolean(row?.siem_secret),
    updatedAt: Number(row?.updated_at ?? 0),
  };
}

async function loadAiSettings(env: Env, organizationId: string): Promise<AiSettingsSummary> {
  const row = await env.DB.prepare(
    'SELECT organization_id, enabled, model, retention, updated_at FROM ai_settings WHERE organization_id = ?',
  )
    .bind(organizationId)
    .first<{
      organization_id: string;
      enabled: number;
      model: string;
      retention: AiSettingsSummary['retention'];
      updated_at: number;
    }>();
  return {
    organizationId,
    enabled: row ? Boolean(row.enabled) : true,
    model: row?.model ?? 'grok-4.5',
    retention: row?.retention ?? 'none',
    configured: Boolean(env.XAI_API_KEY),
    updatedAt: Number(row?.updated_at ?? 0),
  };
}

async function runPageAi(
  request: Request,
  env: Env,
  pageId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const input = await requestBody(request);
  const kind = input?.kind as AiJobKind | undefined;
  const prompt =
    typeof input?.prompt === 'string' ? input.prompt.trim().slice(0, MAX_AI_PROMPT) : '';
  const allowed: AiJobKind[] = ['write', 'rewrite', 'summarize', 'ask', 'autofill', 'research'];
  if (!kind || !allowed.includes(kind) || !prompt) return error('AI 任务或提示无效', 400);
  const needsEdit = kind === 'write' || kind === 'rewrite' || kind === 'autofill';
  const authorized = await authorizePage(
    env,
    pageId,
    actor.id,
    needsEdit ? 'edit_content' : 'view',
  );
  if (!authorized) return error('页面不存在或无权使用 AI', 404);
  const settings = await loadAiSettings(env, authorized.organizationId);
  if (!settings.enabled) return error('组织已关闭 AI', 403, 'ai_disabled');
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const citations = [{ pageId: authorized.id, title: authorized.title }];
  if (!env.XAI_API_KEY) {
    await env.DB.prepare(
      `INSERT INTO ai_jobs(
         id, organization_id, actor_id, page_id, kind, status, prompt, result_text,
         citations_json, error_message, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'degraded', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        jobId,
        authorized.organizationId,
        actor.id,
        pageId,
        kind,
        prompt,
        null,
        JSON.stringify(citations),
        '未配置模型密钥，已安全降级',
        now,
        now,
      )
      .run();
    const job: AiJobSummary = {
      id: jobId,
      organizationId: authorized.organizationId,
      pageId,
      kind,
      status: 'degraded',
      prompt,
      resultText: null,
      citations,
      errorMessage: '未配置模型密钥。设置 XAI_API_KEY 后即可启用权限感知的写作、总结和问答。',
      createdAt: now,
      completedAt: now,
    };
    return json({ job }, { status: 503 });
  }

  const system = `You are Rdocs AI. Only use the provided page context. Never invent access to other pages. Cite page titles you used. Language: follow the user.`;
  const context = `Page: ${authorized.title} (${authorized.id})\nUser prompt (${kind}): ${prompt}`;
  let resultText = '';
  let status: AiJobSummary['status'] = 'succeeded';
  let errorMessage: string | null = null;
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.XAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model || 'grok-4.5',
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: context },
        ],
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      status = 'failed';
      errorMessage = payload?.error?.message ?? `模型请求失败（${response.status}）`;
    } else {
      resultText = payload?.choices?.[0]?.message?.content?.trim() ?? '';
      if (!resultText) {
        status = 'failed';
        errorMessage = '模型没有返回内容';
      }
    }
  } catch (reason) {
    status = 'failed';
    errorMessage = reason instanceof Error ? reason.message : '模型请求异常';
  }
  await env.DB.prepare(
    `INSERT INTO ai_jobs(
       id, organization_id, actor_id, page_id, kind, status, prompt, result_text,
       citations_json, error_message, created_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      jobId,
      authorized.organizationId,
      actor.id,
      pageId,
      kind,
      status,
      prompt,
      settings.retention === 'none' ? null : resultText || null,
      JSON.stringify(citations),
      errorMessage,
      now,
      Date.now(),
    )
    .run();
  const job: AiJobSummary = {
    id: jobId,
    organizationId: authorized.organizationId,
    pageId,
    kind,
    status,
    prompt,
    resultText: resultText || null,
    citations,
    errorMessage,
    createdAt: now,
    completedAt: Date.now(),
  };
  return json({ job }, { status: status === 'succeeded' ? 200 : 502 });
}

export async function handlePlatformApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response | null> {
  return handleSessionPlatformApi(request, env, actor);
}

export function webManifest(): Response {
  return new Response(
    JSON.stringify({
      name: 'Rdocs',
      short_name: 'Rdocs',
      start_url: '/',
      display: 'standalone',
      background_color: '#f4f2ed',
      theme_color: '#c85436',
      lang: 'zh-CN',
      icons: [
        {
          src: '/favicon.ico',
          sizes: '32x32',
          type: 'image/x-icon',
        },
      ],
    }),
    {
      headers: {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    },
  );
}

export function serviceWorkerScript(): Response {
  const script = `const CACHE='rdocs-shell-v1';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/'])));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/collab/')) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});`;
  return new Response(script, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

export function parseSimpleCron(expression: string, from: number): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minutePart, hourPart] = parts;
  const minute = minutePart === '*' ? 0 : Number(minutePart);
  const hour = hourPart === '*' ? 0 : Number(hourPart);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const date = new Date(from);
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(minute);
  date.setUTCHours(hour);
  if (date.getTime() <= from) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

export function automationConditionMatches(
  values: Record<string, JsonValue>,
  condition: Record<string, JsonValue> | null,
): boolean {
  if (!condition || typeof condition.propertyId !== 'string') return true;
  const current = values[condition.propertyId];
  const op = condition.op;
  if (op === 'is_empty')
    return current === null || current === undefined || current === '' || current === false;
  if (op === 'not_empty')
    return !(current === null || current === undefined || current === '' || current === false);
  if (op === 'eq') return JSON.stringify(current) === JSON.stringify(condition.value ?? null);
  if (op === 'neq') return JSON.stringify(current) !== JSON.stringify(condition.value ?? null);
  if (op === 'contains') {
    return typeof current === 'string' && typeof condition.value === 'string'
      ? current.includes(condition.value)
      : Array.isArray(current) && current.includes(condition.value as never);
  }
  return true;
}
