import type {
  AuthUserSummary,
  DeviceSummary,
  DirectoryPerson,
  NotificationPreferences,
  OAuthAppSummary,
  SessionSummary,
  WorkspaceSkillSummary,
  WorkspaceTemplateSummary,
} from '@rdocs/shared';

import { findActiveMembership, requirePageAction } from './access';
import type { Env } from './env';

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, { status });
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json<unknown>().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export async function notificationPreferences(
  env: Env,
  organizationId: string,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await env.DB.prepare(
    `SELECT email_mentions, email_reminders, email_digest, digest_hour
       FROM user_notification_preferences
      WHERE user_id = ? AND organization_id = ?`,
  )
    .bind(userId, organizationId)
    .first<{
      digest_hour: number;
      email_digest: number;
      email_mentions: number;
      email_reminders: number;
    }>();
  return {
    digestHour: Number(row?.digest_hour ?? 9),
    emailDigest: Boolean(row?.email_digest),
    emailMentions: row ? Boolean(row.email_mentions) : true,
    emailReminders: row ? Boolean(row.email_reminders) : true,
  };
}

export async function handleWorkspaceExtrasApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  sessionId: string | null = null,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/api/me/sessions' && request.method === 'GET') {
    const rows = (
      await env.DB.prepare(
        `SELECT id, created_at, last_seen_at, expires_at
           FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY last_seen_at DESC LIMIT 50`,
      )
        .bind(actor.id, Date.now())
        .all<{ created_at: number; expires_at: number; id: string; last_seen_at: number }>()
    ).results;
    const sessions: SessionSummary[] = rows.map((row) => ({
      createdAt: Number(row.created_at),
      current: row.id === sessionId,
      expiresAt: Number(row.expires_at),
      id: row.id,
      lastSeenAt: Number(row.last_seen_at),
    }));
    return json({ sessions });
  }

  const sessionMatch = url.pathname.match(/^\/api\/me\/sessions\/([^/]+)$/);
  if (sessionMatch?.[1] && request.method === 'DELETE') {
    const result = await env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
      .bind(Date.now(), decodeURIComponent(sessionMatch[1]), actor.id)
      .run();
    if (!result.meta.changes) return error('会话不存在', 404);
    return json({ ok: true });
  }

  if (url.pathname === '/api/me/devices' && request.method === 'GET') {
    const rows = (
      await env.DB.prepare(
        `SELECT credential_id, device_type, backed_up, label, created_at, last_used_at
           FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC`,
      )
        .bind(actor.id)
        .all<{
          backed_up: number;
          created_at: number;
          credential_id: string;
          device_type: DeviceSummary['deviceType'];
          label: string | null;
          last_used_at: number | null;
        }>()
    ).results;
    const devices: DeviceSummary[] = rows.map((row) => ({
      backedUp: Boolean(row.backed_up),
      createdAt: Number(row.created_at),
      credentialId: row.credential_id,
      deviceType: row.device_type,
      label: row.label || '设备密钥',
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    }));
    return json({ devices });
  }

  const deviceMatch = url.pathname.match(/^\/api\/me\/devices\/([^/]+)$/);
  if (deviceMatch?.[1] && request.method === 'DELETE') {
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?',
    )
      .bind(actor.id)
      .first<{ count: number }>();
    if (Number(count?.count ?? 0) <= 1) return error('至少保留一把设备密钥', 409);
    const result = await env.DB.prepare(
      'DELETE FROM passkey_credentials WHERE credential_id = ? AND user_id = ?',
    )
      .bind(decodeURIComponent(deviceMatch[1]), actor.id)
      .run();
    if (!result.meta.changes) return error('设备不存在', 404);
    return json({ ok: true });
  }

  const templateList = url.pathname.match(/^\/api\/organizations\/([^/]+)\/templates$/);
  if (templateList?.[1]) {
    const organizationId = decodeURIComponent(templateList[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, space_id, page_id, name, description, created_by, created_at
             FROM workspace_templates WHERE organization_id = ?
            ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(organizationId)
          .all<{
            created_at: number;
            created_by: string;
            description: string;
            id: string;
            name: string;
            page_id: string;
            space_id: string;
          }>()
      ).results;
      return json({
        templates: rows.map((row): WorkspaceTemplateSummary => ({
          createdAt: Number(row.created_at),
          createdBy: row.created_by,
          description: row.description,
          id: row.id,
          name: row.name,
          pageId: row.page_id,
          spaceId: row.space_id,
        })),
      });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const pageId = typeof input?.pageId === 'string' ? input.pageId : '';
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '';
      const description =
        typeof input?.description === 'string' ? input.description.trim().slice(0, 240) : '';
      if (!pageId || !name) return error('请提供页面和模板名称', 400);
      const access = await requirePageAction(env, pageId, actor.id, 'view');
      if (!access || access.organizationId !== organizationId) {
        return error('页面不存在或无权发布为模板', 404);
      }
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO workspace_templates(
           id, organization_id, space_id, page_id, name, description, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, organizationId, access.spaceId, pageId, name, description, actor.id, Date.now())
        .run();
      return json({ id }, { status: 201 });
    }
  }

  const instantiate = url.pathname.match(/^\/api\/templates\/([^/]+)\/instantiate$/);
  if (instantiate?.[1] && request.method === 'POST') {
    const template = await env.DB.prepare(
      `SELECT id, organization_id, space_id, page_id, name
         FROM workspace_templates WHERE id = ?`,
    )
      .bind(decodeURIComponent(instantiate[1]))
      .first<{
        id: string;
        name: string;
        organization_id: string;
        page_id: string;
        space_id: string;
      }>();
    if (!template) return error('模板不存在', 404);
    const membership = await findActiveMembership(env, template.organization_id, actor.id);
    if (!membership) return error('无权使用该模板', 403);
    return json({
      sourcePageId: template.page_id,
      spaceId: template.space_id,
      title: template.name,
    });
  }

  const skillList = url.pathname.match(/^\/api\/organizations\/([^/]+)\/skills$/);
  if (skillList?.[1]) {
    const organizationId = decodeURIComponent(skillList[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, name, prompt, created_by, created_at
             FROM workspace_skills WHERE organization_id = ?
            ORDER BY created_at DESC LIMIT 100`,
        )
          .bind(organizationId)
          .all<{
            created_at: number;
            created_by: string;
            id: string;
            name: string;
            prompt: string;
          }>()
      ).results;
      return json({
        skills: rows.map((row): WorkspaceSkillSummary => ({
          createdAt: Number(row.created_at),
          createdBy: row.created_by,
          id: row.id,
          name: row.name,
          prompt: row.prompt,
        })),
      });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '';
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim().slice(0, 8_000) : '';
      if (!name || !prompt) return error('请填写技能名称和提示词', 400);
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO workspace_skills(id, organization_id, name, prompt, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, organizationId, name, prompt, actor.id, Date.now())
          .run();
      } catch {
        return error('已有同名技能', 409);
      }
      return json({ id }, { status: 201 });
    }
  }

  const skillItem = url.pathname.match(/^\/api\/organizations\/([^/]+)\/skills\/([^/]+)$/);
  if (skillItem?.[1] && skillItem[2] && request.method === 'DELETE') {
    const organizationId = decodeURIComponent(skillItem[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    const result = await env.DB.prepare(
      'DELETE FROM workspace_skills WHERE id = ? AND organization_id = ?',
    )
      .bind(decodeURIComponent(skillItem[2]), organizationId)
      .run();
    if (!result.meta.changes) return error('技能不存在', 404);
    return json({ ok: true });
  }

  const prefsMatch = url.pathname.match(
    /^\/api\/organizations\/([^/]+)\/notification-preferences$/,
  );
  if (prefsMatch?.[1]) {
    const organizationId = decodeURIComponent(prefsMatch[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    if (request.method === 'GET') {
      return json({ preferences: await notificationPreferences(env, organizationId, actor.id) });
    }
    if (request.method === 'PATCH') {
      const input = await requestBody(request);
      const current = await notificationPreferences(env, organizationId, actor.id);
      const next: NotificationPreferences = {
        digestHour:
          typeof input?.digestHour === 'number'
            ? Math.min(23, Math.max(0, Math.floor(input.digestHour)))
            : current.digestHour,
        emailDigest:
          typeof input?.emailDigest === 'boolean' ? input.emailDigest : current.emailDigest,
        emailMentions:
          typeof input?.emailMentions === 'boolean' ? input.emailMentions : current.emailMentions,
        emailReminders:
          typeof input?.emailReminders === 'boolean'
            ? input.emailReminders
            : current.emailReminders,
      };
      await env.DB.prepare(
        `INSERT INTO user_notification_preferences(
           user_id, organization_id, email_mentions, email_reminders, email_digest, digest_hour, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, organization_id) DO UPDATE SET
           email_mentions = excluded.email_mentions,
           email_reminders = excluded.email_reminders,
           email_digest = excluded.email_digest,
           digest_hour = excluded.digest_hour,
           updated_at = excluded.updated_at`,
      )
        .bind(
          actor.id,
          organizationId,
          next.emailMentions ? 1 : 0,
          next.emailReminders ? 1 : 0,
          next.emailDigest ? 1 : 0,
          next.digestHour,
          Date.now(),
        )
        .run();
      return json({ preferences: next });
    }
  }

  const directoryMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/directory$/);
  if (directoryMatch?.[1] && request.method === 'GET') {
    const organizationId = decodeURIComponent(directoryMatch[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership) return error('组织不存在', 404);
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const rows = (
      await env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, u.avatar_url, m.role
           FROM organization_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ? AND m.status = 'active'
          ORDER BY u.display_name COLLATE NOCASE ASC LIMIT 200`,
      )
        .bind(organizationId)
        .all<{
          avatar_url: string | null;
          display_name: string;
          email: string;
          id: string;
          role: DirectoryPerson['role'];
        }>()
    ).results;
    const people: DirectoryPerson[] = rows
      .filter(
        (row) =>
          !query ||
          row.display_name.toLowerCase().includes(query) ||
          row.email.toLowerCase().includes(query),
      )
      .map((row) => ({
        avatarUrl: row.avatar_url,
        displayName: row.display_name,
        email: row.email,
        role: row.role,
        userId: row.id,
      }));
    return json({ people });
  }

  const oauthList = url.pathname.match(/^\/api\/organizations\/([^/]+)\/oauth-apps$/);
  if (oauthList?.[1]) {
    const organizationId = decodeURIComponent(oauthList[1]);
    const membership = await findActiveMembership(env, organizationId, actor.id);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return error('无权管理集成应用', 403);
    }
    if (request.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          `SELECT id, name, client_id, redirect_uris_json, scopes_json, created_at, revoked_at
             FROM oauth_apps WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
          .bind(organizationId)
          .all<{
            client_id: string;
            created_at: number;
            id: string;
            name: string;
            redirect_uris_json: string;
            revoked_at: number | null;
            scopes_json: string;
          }>()
      ).results;
      return json({
        apps: rows.map((row): OAuthAppSummary => ({
          clientId: row.client_id,
          createdAt: Number(row.created_at),
          id: row.id,
          name: row.name,
          redirectUris: JSON.parse(row.redirect_uris_json) as string[],
          revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
          scopes: JSON.parse(row.scopes_json) as string[],
        })),
      });
    }
    if (request.method === 'POST') {
      const input = await requestBody(request);
      const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 80) : '';
      const redirectUri = typeof input?.redirectUri === 'string' ? input.redirectUri.trim() : '';
      if (!name || !/^https:\/\//i.test(redirectUri)) return error('应用名称或回调地址无效', 400);
      const id = crypto.randomUUID();
      const clientId = `rdocs_${crypto.randomUUID().replace(/-/g, '')}`;
      const secret = `rdocs_secret_${crypto.randomUUID().replace(/-/g, '')}`;
      const digest = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))),
      ]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      await env.DB.prepare(
        `INSERT INTO oauth_apps(
           id, organization_id, name, client_id, client_secret_hash, redirect_uris_json,
           scopes_json, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          organizationId,
          name,
          clientId,
          digest,
          JSON.stringify([redirectUri]),
          JSON.stringify(['pages:read', 'search:read']),
          actor.id,
          Date.now(),
        )
        .run();
      return json({ clientId, clientSecret: secret, id }, { status: 201 });
    }
  }

  const linkMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/linked-database$/);
  if (linkMatch?.[1]) {
    const pageId = decodeURIComponent(linkMatch[1]);
    if (request.method === 'GET') {
      const access = await requirePageAction(env, pageId, actor.id, 'view');
      if (!access) return error('页面不存在', 404);
      const row = await env.DB.prepare(
        `SELECT source_database_id FROM database_links WHERE page_id = ?`,
      )
        .bind(pageId)
        .first<{ source_database_id: string }>();
      return json({ databaseId: row?.source_database_id ?? null });
    }
    if (request.method === 'PUT') {
      const access = await requirePageAction(env, pageId, actor.id, 'edit_content');
      if (!access) return error('页面不存在或无权链接数据库', 404);
      const input = await requestBody(request);
      const databaseId = typeof input?.databaseId === 'string' ? input.databaseId : '';
      const database = await env.DB.prepare(
        'SELECT id, organization_id, page_id FROM databases WHERE id = ?',
      )
        .bind(databaseId)
        .first<{ id: string; organization_id: string; page_id: string }>();
      if (!database || database.organization_id !== access.organizationId) {
        return error('数据库不存在', 404);
      }
      if (!(await requirePageAction(env, database.page_id, actor.id, 'view'))) {
        return error('无权读取源数据库', 403);
      }
      await env.DB.prepare(
        `INSERT INTO database_links(id, organization_id, page_id, source_database_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET source_database_id = excluded.source_database_id`,
      )
        .bind(crypto.randomUUID(), access.organizationId, pageId, databaseId, actor.id, Date.now())
        .run();
      return json({ databaseId });
    }
    if (request.method === 'DELETE') {
      const access = await requirePageAction(env, pageId, actor.id, 'edit_content');
      if (!access) return error('页面不存在或无权取消链接', 404);
      await env.DB.prepare('DELETE FROM database_links WHERE page_id = ?').bind(pageId).run();
      return json({ ok: true });
    }
  }

  return null;
}
