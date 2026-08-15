import type { AuthUserSummary } from '@rdocs/shared';

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

export async function queueOutboundEmail(
  env: Env,
  input: {
    organizationId: string;
    recipientEmail: string;
    recipientUserId?: string | null;
    subject: string;
    bodyText: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO outbound_emails(
       id, organization_id, recipient_user_id, recipient_email, subject, body_text,
       status, error_message, created_at, sent_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL)`,
  )
    .bind(
      id,
      input.organizationId,
      input.recipientUserId ?? null,
      input.recipientEmail,
      input.subject.slice(0, 200),
      input.bodyText.slice(0, 20_000),
      now,
    )
    .run();
  const webhook = env.MAIL_WEBHOOK_URL?.trim();
  if (!webhook) return;
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: input.recipientEmail,
        subject: input.subject,
        text: input.bodyText,
      }),
    });
    await env.DB.prepare(
      `UPDATE outbound_emails SET status = ?, error_message = ?, sent_at = ? WHERE id = ?`,
    )
      .bind(
        response.ok ? 'sent' : 'failed',
        response.ok ? null : `HTTP ${response.status}`,
        Date.now(),
        id,
      )
      .run();
  } catch (reason) {
    await env.DB.prepare(
      `UPDATE outbound_emails SET status = 'failed', error_message = ?, sent_at = ? WHERE id = ?`,
    )
      .bind(reason instanceof Error ? reason.message : '发送失败', Date.now(), id)
      .run();
  }
}

export async function processDueScheduledJobs(env: Env): Promise<number> {
  const now = Date.now();
  const due = (
    await env.DB.prepare(
      `SELECT id FROM scheduled_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 20`,
    )
      .bind(now)
      .all<{ id: string }>()
  ).results;
  for (const job of due) {
    await env.DB.prepare(
      `UPDATE scheduled_jobs SET status = 'succeeded', completed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`,
    )
      .bind(now, job.id)
      .run();
  }
  return due.length;
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

export async function handleAuthenticatedEnterprise(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/ai/research') && request.method === 'POST') {
    return null;
  }
  if (url.pathname.match(/^\/api\/organizations\/[^/]+\/emails$/) && request.method === 'GET') {
    const organizationId = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    if (organizationId !== actor.id && actor) {
      const rows = (
        await env.DB.prepare(
          `SELECT id, recipient_email, subject, status, created_at, sent_at
             FROM outbound_emails WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
          .bind(organizationId)
          .all()
      ).results;
      return json({ emails: rows });
    }
  }
  return null;
}
