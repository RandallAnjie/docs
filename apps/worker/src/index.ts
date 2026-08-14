import appHtml from '../../web/dist/index.html';

import { EDITOR_SCHEMA_VERSION, isPageId, type PageSummary } from '@rdocs/shared';

import { DocumentRoom } from './document-room';
import type { Env } from './env';
import { signCollabTicket, verifyCollabTicket } from './tickets';

export { DocumentRoom };

const SYSTEM_USER_ID = 'usr_phase0_system';
const PHASE0_ORGANIZATION_ID = 'org_phase0';
const PHASE0_SPACE_ID = 'spc_phase0';
const MAX_TITLE_LENGTH = 200;

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

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number): Response {
  return json({ error: message }, { status });
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

async function createPage(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  const requestedTitle = typeof body.title === 'string' ? body.title.trim() : '';
  const title = (requestedTitle || '未命名页面').slice(0, MAX_TITLE_LENGTH);
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pages(
        id, organization_id, space_id, parent_id, title, sort_key,
        current_generation, editor_schema_version, created_by, updated_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      PHASE0_ORGANIZATION_ID,
      PHASE0_SPACE_ID,
      title,
      now.toString().padStart(20, '0'),
      EDITOR_SCHEMA_VERSION,
      SYSTEM_USER_ID,
      SYSTEM_USER_ID,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).bind(id, now),
  ]);

  const page = await findPage(env, id);
  return json({ page }, { status: 201 });
}

async function updatePage(request: Request, env: Env, pageId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== 'string') return error('title 必须是字符串', 400);
  const title = (body.title.trim() || '未命名页面').slice(0, MAX_TITLE_LENGTH);
  const result = await env.DB.prepare(
    `UPDATE pages SET title = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(title, SYSTEM_USER_ID, Date.now(), pageId)
    .run();
  if (!result.meta.changes) return error('页面不存在', 404);
  return json({ page: await findPage(env, pageId) });
}

async function issueTicket(request: Request, env: Env, pageId: string): Promise<Response> {
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
  const actorId = typeof body.actorId === 'string' ? body.actorId.slice(0, 100) : '';
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 60) : '';
  if (!actorId || !displayName) return error('协作者身份无效', 400);

  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60 * 1000;
  const ticket = await signCollabTicket(
    {
      version: 1,
      pageId,
      generation: page.currentGeneration,
      actorId,
      displayName,
      role: 'editor',
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

async function openCollaborationSocket(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return error('需要 WebSocket upgrade', 426);
  }

  const expectedOrigin = env.APP_ORIGIN || new URL(request.url).origin;
  if (request.headers.get('origin') !== expectedOrigin) return error('Origin 不允许', 403);

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

async function handleApi(request: Request, env: Env): Promise<Response> {
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

  if (url.pathname === '/api/pages' && request.method === 'POST') {
    return createPage(request, env);
  }

  const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
  if (pageMatch?.[1]) {
    const pageId = decodeURIComponent(pageMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (request.method === 'GET') {
      const page = await findPage(env, pageId);
      return page ? json({ page }) : error('页面不存在', 404);
    }
    if (request.method === 'PATCH') return updatePage(request, env, pageId);
  }

  const ticketMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collab-ticket$/);
  if (ticketMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(ticketMatch[1]);
    return isPageId(pageId) ? issueTicket(request, env, pageId) : error('页面 ID 无效', 400);
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
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env);

      const collabMatch = url.pathname.match(/^\/collab\/([^/]+)$/);
      if (collabMatch?.[1]) {
        const pageId = decodeURIComponent(collabMatch[1]);
        return isPageId(pageId)
          ? openCollaborationSocket(request, env, pageId)
          : error('页面 ID 无效', 400);
      }

      if (request.method === 'GET' || request.method === 'HEAD') return htmlResponse();
      return error('Method not allowed', 405);
    } catch (reason) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'request_failed',
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
      return error('服务暂时不可用', 500);
    }
  },
};
