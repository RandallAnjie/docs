import { deliverDueReminders } from './comments';
import { runScheduledAutomation } from './databases';
import { appOrigin, invitationEmailBodies, queueOutboundEmail } from './email';
import type { Env } from './env';
import { parseSimpleCron } from './cron';
import { signInvitationToken } from './tenancy';

export { queueOutboundEmail } from './email';

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, { status });
}

export function samlMetadataXml(origin: string): string {
  const entity = `${origin}/api/saml/metadata`;
  const acs = `${origin}/api/saml/acs`;
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
}

export function emailFromSamlResponse(encoded: string): string | null {
  try {
    const xml = atob(encoded.replace(/\s/g, ''));
    const match =
      xml.match(/<NameID[^>]*>([^<]+)<\/NameID>/i) ||
      xml.match(/EmailAddress[^>]*>([^<]+)</i) ||
      xml.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    const email = match?.[1]?.trim().toLowerCase() ?? '';
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

export function scimListResponse<T>(resources: T[]) {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function scimUserResource(user: {
  id: string;
  email: string;
  displayName: string;
  active: boolean;
}) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    userName: user.email,
    displayName: user.displayName,
    active: user.active,
    emails: [{ value: user.email, primary: true }],
    meta: { resourceType: 'User' },
  };
}

export async function findOrganizationByScimToken(
  env: Env,
  request: Request,
): Promise<{ organizationId: string } | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const digest = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT organization_id FROM enterprise_settings
      WHERE scim_enabled = 1 AND scim_token_hash = ?`,
  )
    .bind(digest)
    .first<{ organization_id: string }>();
  return row ? { organizationId: row.organization_id } : null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export async function enqueueScheduledJob(
  env: Env,
  input: {
    kind: 'automation' | 'email_digest' | 'export' | 'reminder';
    organizationId: string;
    payload: Record<string, unknown>;
    runAt: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO scheduled_jobs(
       id, organization_id, kind, payload_json, run_at, status, attempts, created_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  )
    .bind(
      id,
      input.organizationId,
      input.kind,
      JSON.stringify(input.payload),
      input.runAt,
      Date.now(),
    )
    .run();
  return id;
}

export async function processDueScheduledJobs(env: Env): Promise<number> {
  const now = Date.now();
  const due = (
    await env.DB.prepare(
      `SELECT id, organization_id, kind, payload_json, attempts
         FROM scheduled_jobs
        WHERE status = 'pending' AND run_at <= ?
        ORDER BY run_at ASC LIMIT 20`,
    )
      .bind(now)
      .all<{
        attempts: number;
        id: string;
        kind: 'automation' | 'email_digest' | 'export' | 'reminder';
        organization_id: string;
        payload_json: string;
      }>()
  ).results;
  let completed = 0;
  for (const job of due) {
    const claimed = await env.DB.prepare(
      `UPDATE scheduled_jobs
          SET status = 'running', attempts = attempts + 1
        WHERE id = ? AND status = 'pending'`,
    )
      .bind(job.id)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      const payload = parseJobPayload(job.payload_json);
      if (job.kind === 'reminder') {
        await deliverDueReminders(env, null, 200);
      } else if (job.kind === 'automation') {
        await runScheduledAutomation(env, {
          automationId: stringPayload(payload.automationId),
          databaseId: stringPayload(payload.databaseId),
          rowId: typeof payload.rowId === 'string' ? payload.rowId : null,
        });
      } else if (job.kind === 'email_digest') {
        await sendUnreadDigest(env, job.organization_id, stringPayload(payload.userId));
      }
      await env.DB.prepare(
        `UPDATE scheduled_jobs SET status = 'succeeded', last_error = NULL, completed_at = ? WHERE id = ?`,
      )
        .bind(Date.now(), job.id)
        .run();
      completed += 1;
      const cron = typeof payload.cron === 'string' ? payload.cron : '';
      const next = cron ? parseSimpleCron(cron, now) : null;
      if (next) {
        await enqueueScheduledJob(env, {
          kind: job.kind,
          organizationId: job.organization_id,
          payload,
          runAt: next,
        });
      }
    } catch (reason) {
      await env.DB.prepare(
        `UPDATE scheduled_jobs SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?`,
      )
        .bind(
          reason instanceof Error ? reason.message.slice(0, 500) : '任务失败',
          Date.now(),
          job.id,
        )
        .run();
    }
  }
  return completed;
}

function parseJobPayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringPayload(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function sendUnreadDigest(env: Env, organizationId: string, userId: string): Promise<void> {
  if (!userId) return;
  const user = await env.DB.prepare(
    `SELECT id, email, display_name FROM users WHERE id = ? AND status = 'active'`,
  )
    .bind(userId)
    .first<{ display_name: string; email: string; id: string }>();
  if (!user) return;
  const rows = (
    await env.DB.prepare(
      `SELECT n.type, p.title, n.created_at
         FROM notifications n
         LEFT JOIN pages p ON p.id = n.page_id
        WHERE n.organization_id = ? AND n.user_id = ? AND n.read_at IS NULL AND n.archived_at IS NULL
        ORDER BY n.created_at DESC LIMIT 20`,
    )
      .bind(organizationId, userId)
      .all<{ created_at: number; title: string | null; type: string }>()
  ).results;
  if (!rows.length) return;
  const lines = rows.map(
    (row) =>
      `- ${row.type} · ${row.title || '未命名页面'} · ${new Date(Number(row.created_at)).toISOString()}`,
  );
  await queueOutboundEmail(env, {
    bodyText: `你有 ${rows.length} 条未读通知：\n\n${lines.join('\n')}\n\n打开收件箱：${appOrigin(env)}/`,
    organizationId,
    recipientEmail: user.email,
    recipientUserId: user.id,
    subject: `Rdocs：${rows.length} 条未读通知`,
  });
}

function scimEmail(body: Record<string, unknown> | null): string {
  const emails = Array.isArray(body?.emails) ? body.emails : [];
  for (const item of emails) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { value?: unknown }).value === 'string'
    ) {
      return String((item as { value: string }).value)
        .trim()
        .toLowerCase();
    }
  }
  return typeof body?.userName === 'string' ? body.userName.trim().toLowerCase() : '';
}

async function requestJson(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json<unknown>().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function provisionScimUser(
  env: Env,
  organizationId: string,
  input: { active: boolean; displayName: string; email: string },
): Promise<{ created: boolean; resource: ReturnType<typeof scimUserResource> }> {
  const email = input.email;
  if (!email.includes('@')) throw new Error('invalid_email');
  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.status, m.status AS member_status
       FROM users u
       LEFT JOIN organization_members m
         ON m.user_id = u.id AND m.organization_id = ?
      WHERE LOWER(u.email) = ?`,
  )
    .bind(organizationId, email)
    .first<{
      display_name: string;
      email: string;
      id: string;
      member_status: string | null;
      status: string;
    }>();
  const owner = await env.DB.prepare(
    `SELECT user_id FROM organization_members
      WHERE organization_id = ? AND role = 'owner' AND status = 'active'
      LIMIT 1`,
  )
    .bind(organizationId)
    .first<{ user_id: string }>();
  if (!owner) throw new Error('missing_owner');
  let userId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
    )
      .bind(userId, email, input.displayName || email.split('@')[0] || email, now, now)
      .run();
  } else if (input.displayName && input.displayName !== existing.display_name) {
    await env.DB.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
      .bind(input.displayName, now, userId)
      .run();
  }
  const memberStatus = input.active ? 'active' : 'suspended';
  await env.DB.prepare(
    `INSERT INTO organization_members(
       organization_id, user_id, role, status, joined_at, updated_at
     ) VALUES (?, ?, 'member', ?, ?, ?)
     ON CONFLICT(organization_id, user_id) DO UPDATE SET
       status = excluded.status,
       updated_at = excluded.updated_at`,
  )
    .bind(organizationId, userId, memberStatus, input.active ? now : null, now)
    .run();

  const token = await signInvitationToken(env, crypto.randomUUID());
  if (token) {
    const invitationId = crypto.randomUUID();
    const signed = await signInvitationToken(env, invitationId);
    if (signed) {
      const digest = await sha256Hex(signed);
      await env.DB.prepare(
        `INSERT INTO invitations(
           id, organization_id, email, organization_role, token_hash, expires_at,
           accepted_at, revoked_at, created_by, created_at
         ) VALUES (?, ?, ?, 'member', ?, ?, NULL, NULL, ?, ?)`,
      )
        .bind(
          invitationId,
          organizationId,
          email,
          digest,
          now + 7 * 24 * 60 * 60 * 1_000,
          owner.user_id,
          now,
        )
        .run();
      const organization = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?')
        .bind(organizationId)
        .first<{ name: string }>();
      const acceptUrl = `${appOrigin(env)}/invite/${encodeURIComponent(signed)}`;
      const bodies = invitationEmailBodies({
        acceptUrl,
        organizationName: organization?.name ?? 'Rdocs',
      });
      await queueOutboundEmail(env, {
        bodyHtml: bodies.html,
        bodyText: bodies.text,
        organizationId,
        recipientEmail: email,
        recipientUserId: userId,
        subject: `邀请你加入 ${organization?.name ?? 'Rdocs'}`,
      });
    }
  }

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, m.status
       FROM users u JOIN organization_members m ON m.user_id = u.id
      WHERE m.organization_id = ? AND u.id = ?`,
  )
    .bind(organizationId, userId)
    .first<{ display_name: string; email: string; id: string; status: string }>();
  if (!row) throw new Error('provision_failed');
  return {
    created: !existing,
    resource: scimUserResource({
      active: row.status === 'active',
      displayName: row.display_name,
      email: row.email,
      id: row.id,
    }),
  };
}

export async function handleScimUsers(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/scim/v2/Users')) return null;
  const org = await findOrganizationByScimToken(env, request);
  if (!org) return scimError('Unauthorized', 401);
  if (url.pathname === '/scim/v2/Users' && request.method === 'GET') {
    const filter = url.searchParams.get('filter') ?? '';
    const emailMatch = filter.match(/userName\s+eq\s+"([^"]+)"/i);
    const email = emailMatch?.[1]?.toLowerCase() ?? '';
    const rows = (
      await env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, m.status
           FROM users u
           JOIN organization_members m ON m.user_id = u.id
          WHERE m.organization_id = ? AND (? = '' OR LOWER(u.email) = ?)
          ORDER BY u.created_at DESC LIMIT 100`,
      )
        .bind(org.organizationId, email, email)
        .all<{ display_name: string; email: string; id: string; status: string }>()
    ).results;
    return json(
      scimListResponse(
        rows.map((row) =>
          scimUserResource({
            active: row.status === 'active',
            displayName: row.display_name,
            email: row.email,
            id: row.id,
          }),
        ),
      ),
    );
  }
  if (url.pathname === '/scim/v2/Users' && request.method === 'POST') {
    const body = await requestJson(request);
    const email = scimEmail(body);
    const displayName =
      typeof body?.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim().slice(0, 80)
        : email.split('@')[0] || email;
    const active = body?.active === false ? false : true;
    if (!email.includes('@')) return scimError('userName must be an email', 400);
    try {
      const result = await provisionScimUser(env, org.organizationId, {
        active,
        displayName,
        email,
      });
      return json(result.resource, { status: result.created ? 201 : 200 });
    } catch (reason) {
      return scimError(reason instanceof Error ? reason.message : 'Unable to provision user', 400);
    }
  }
  const userMatch = url.pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/);
  if (!userMatch?.[1]) return scimError('Not found', 404);
  const userId = decodeURIComponent(userMatch[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, m.status
       FROM users u
       JOIN organization_members m ON m.user_id = u.id
      WHERE m.organization_id = ? AND u.id = ?`,
  )
    .bind(org.organizationId, userId)
    .first<{ display_name: string; email: string; id: string; status: string }>();
  if (!row) return scimError('User not found', 404);
  if (request.method === 'GET') {
    return json(
      scimUserResource({
        active: row.status === 'active',
        displayName: row.display_name,
        email: row.email,
        id: row.id,
      }),
    );
  }
  if (request.method === 'DELETE') {
    await env.DB.prepare(
      `UPDATE organization_members SET status = 'suspended', updated_at = ?
        WHERE organization_id = ? AND user_id = ?`,
    )
      .bind(Date.now(), org.organizationId, userId)
      .run();
    return new Response(null, { status: 204 });
  }
  if (request.method === 'PATCH' || request.method === 'PUT') {
    const body = await requestJson(request);
    let displayName = row.display_name;
    let active = row.status === 'active';
    const operations = Array.isArray(body?.Operations) ? body.Operations : [];
    if (operations.length) {
      for (const operation of operations) {
        if (!operation || typeof operation !== 'object') continue;
        const item = operation as { op?: string; path?: string; value?: unknown };
        const op = (item.op ?? '').toLowerCase();
        if (op !== 'replace' && op !== 'add') continue;
        if ((item.path ?? '').toLowerCase() === 'active' || item.path === 'active') {
          active = item.value !== false && item.value !== 'False';
        } else if ((item.path ?? '').toLowerCase() === 'displayname') {
          if (typeof item.value === 'string' && item.value.trim()) displayName = item.value.trim();
        } else if (item.value && typeof item.value === 'object') {
          const value = item.value as { active?: unknown; displayName?: unknown };
          if (typeof value.active === 'boolean') active = value.active;
          if (typeof value.displayName === 'string' && value.displayName.trim()) {
            displayName = value.displayName.trim();
          }
        }
      }
    } else {
      if (typeof body?.displayName === 'string' && body.displayName.trim()) {
        displayName = body.displayName.trim();
      }
      if (typeof body?.active === 'boolean') active = body.active;
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').bind(
        displayName.slice(0, 80),
        Date.now(),
        userId,
      ),
      env.DB.prepare(
        `UPDATE organization_members SET status = ?, updated_at = ?
          WHERE organization_id = ? AND user_id = ?`,
      ).bind(active ? 'active' : 'suspended', Date.now(), org.organizationId, userId),
    ]);
    return json(
      scimUserResource({
        active,
        displayName: displayName.slice(0, 80),
        email: row.email,
        id: row.id,
      }),
    );
  }
  return scimError('Method not allowed', 405);
}

export function scimError(detail: string, status: number): Response {
  return json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail,
      status: String(status),
    },
    { status },
  );
}

export async function handleEnterpriseProtocol(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/saml/metadata' && request.method === 'GET') {
    return new Response(samlMetadataXml(url.origin), {
      headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8' },
    });
  }
  if (url.pathname === '/scim/v2/ServiceProviderConfig' && request.method === 'GET') {
    return json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      filter: { supported: true, maxResults: 100 },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer' }],
    });
  }
  return null;
}
