import { isPageId } from '@rdocs/shared';

import { resolvePageAccess } from './access';
import type { Env } from './env';

export interface EdgeEmailMessage {
  attachments(): Promise<Array<{ contentType: string; filename: string; sizeBytes: number }>>;
  authResults?: string;
  dkimPass?: boolean;
  forward(to: string): Promise<void>;
  from: string;
  html(): Promise<string | null>;
  raw: ReadableStream;
  rawSize: number;
  setReject(reason: string): void;
  spfPass?: boolean;
  subject?: string;
  text(): Promise<string>;
  to: string;
}

export function appOrigin(env: Env, request?: Request): string {
  if (env.APP_ORIGIN?.trim()) return env.APP_ORIGIN.replace(/\/+$/, '');
  if (request) return new URL(request.url).origin;
  return 'https://docs.bigrandall.io';
}

export function mailFromAddress(env: Env): string | undefined {
  const from = env.MAIL_FROM?.trim();
  return from && from.includes('@') ? from : undefined;
}

export async function emailUsers(
  env: Env,
  userIds: readonly string[],
): Promise<Map<string, { displayName: string; email: string }>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const found = new Map<string, { displayName: string; email: string }>();
  if (!unique.length) return found;
  const placeholders = unique.map(() => '?').join(', ');
  const rows = (
    await env.DB.prepare(
      `SELECT id, email, display_name FROM users
        WHERE id IN (${placeholders}) AND status = 'active'`,
    )
      .bind(...unique)
      .all<{ display_name: string; email: string; id: string }>()
  ).results;
  for (const row of rows) {
    found.set(row.id, { email: row.email, displayName: row.display_name });
  }
  return found;
}

export async function queueOutboundEmail(
  env: Env,
  input: {
    bodyHtml?: string;
    bodyText: string;
    organizationId: string;
    recipientEmail: string;
    recipientUserId?: string | null;
    subject: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const recipient = input.recipientEmail.trim().toLowerCase();
  if (!recipient.includes('@')) return;
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
      recipient,
      input.subject.slice(0, 200),
      input.bodyText.slice(0, 20_000),
      now,
    )
    .run();
  if (!env.EMAIL?.send) {
    await env.DB.prepare(
      `UPDATE outbound_emails
          SET status = 'failed', error_message = ?, sent_at = ?
        WHERE id = ?`,
    )
      .bind('未绑定 RandallFlare 邮件路由（EMAIL）', Date.now(), id)
      .run();
    return;
  }
  try {
    const from = mailFromAddress(env);
    await env.EMAIL.send({
      ...(from ? { from, fromName: 'Rdocs' } : { fromName: 'Rdocs' }),
      html: input.bodyHtml,
      subject: input.subject,
      text: input.bodyText,
      to: recipient,
    });
    await env.DB.prepare(
      `UPDATE outbound_emails SET status = 'sent', error_message = NULL, sent_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), id)
      .run();
  } catch (reason) {
    await env.DB.prepare(
      `UPDATE outbound_emails SET status = 'failed', error_message = ?, sent_at = ? WHERE id = ?`,
    )
      .bind(reason instanceof Error ? reason.message.slice(0, 500) : '发送失败', Date.now(), id)
      .run();
  }
}

export function invitationEmailBodies(input: { acceptUrl: string; organizationName: string }): {
  html: string;
  text: string;
} {
  const text = `你被邀请加入 ${input.organizationName}。\n\n打开这个链接，用设备密钥登记后即可加入：\n${input.acceptUrl}\n\n如果不是你本人，请忽略这封邮件。`;
  const html = `<!doctype html><html lang="zh-CN"><body style="font:16px/1.55 system-ui,sans-serif;color:#222;max-width:560px">
<p>你被邀请加入 <strong>${escapeHtml(input.organizationName)}</strong>。</p>
<p><a href="${escapeHtml(input.acceptUrl)}">打开邀请并登记设备密钥</a></p>
<p style="color:#666;font-size:13px">如果不是你本人，请忽略这封邮件。</p>
</body></html>`;
  return { html, text };
}

export function notificationEmailBodies(input: {
  actorName: string;
  pageTitle: string;
  pageUrl: string;
  preview: string;
  kind: 'mention' | 'reminder' | 'digest';
}): { html: string; text: string } {
  const headline =
    input.kind === 'mention'
      ? `${input.actorName} 在「${input.pageTitle}」中提到了你`
      : input.kind === 'reminder'
        ? `提醒：${input.pageTitle}`
        : `Rdocs 未读摘要`;
  const preview = input.preview.trim().slice(0, 400);
  const text = `${headline}\n\n${preview}\n\n打开页面：${input.pageUrl}`;
  const html = `<!doctype html><html lang="zh-CN"><body style="font:16px/1.55 system-ui,sans-serif;color:#222;max-width:560px">
<p>${escapeHtml(headline)}</p>
${preview ? `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #c85436;color:#444">${escapeHtml(preview)}</blockquote>` : ''}
<p><a href="${escapeHtml(input.pageUrl)}">打开页面</a></p>
</body></html>`;
  return { html, text };
}

export function pageIdFromMailbox(address: string): string | null {
  const local = address.split('@')[0] ?? '';
  const match = local.match(
    /(?:^|[+.])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  const id = match?.[1]?.toLowerCase() ?? '';
  return isPageId(id) ? id : null;
}

export async function dispatchRandallFlareEmail(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const specifier = '/_edge/email.js';
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    handleEmailRequest: (
      incoming: Request,
      bindings: unknown,
      handler: (message: EdgeEmailMessage, bindings: unknown) => Promise<void> | void,
    ) => Promise<Response | null>;
  };
  return mod.handleEmailRequest(request, env, (message, bindings) =>
    handleInboundEmail(message, bindings as Env),
  );
}

export async function handleInboundEmail(message: EdgeEmailMessage, env: Env): Promise<void> {
  if (!message.spfPass && !message.dkimPass) {
    message.setReject('SPF and DKIM both failed');
    return;
  }
  const from = extractEmailAddress(message.from);
  const to = extractEmailAddress(message.to);
  const subject = (message.subject ?? '').slice(0, 200);
  let body = '';
  try {
    body = (await message.text()).slice(0, 20_000);
  } catch {
    body = '';
  }
  const pageId = pageIdFromMailbox(to);
  const now = Date.now();
  const inboundId = crypto.randomUUID();
  const sender = from
    ? await env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, m.organization_id
           FROM users u
           JOIN organization_members m ON m.user_id = u.id
          WHERE LOWER(u.email) = ? AND u.status = 'active' AND m.status = 'active'
          ORDER BY m.joined_at ASC LIMIT 1`,
      )
        .bind(from)
        .first<{
          display_name: string;
          email: string;
          id: string;
          organization_id: string;
        }>()
    : null;

  let organizationId = sender?.organization_id ?? null;
  let acceptedPageId: string | null = null;
  let status: 'accepted' | 'ignored' | 'failed' = 'ignored';
  let errorMessage: string | null = null;

  if (pageId && sender) {
    const page = await env.DB.prepare(
      `SELECT id, organization_id, title FROM pages WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(pageId)
      .first<{ id: string; organization_id: string; title: string }>();
    if (page && (await resolvePageAccess(env, pageId, sender.id))) {
      organizationId = page.organization_id;
      acceptedPageId = page.id;
      try {
        await appendInboundComment(env, {
          actorId: sender.id,
          body: body || subject || '(空邮件)',
          organizationId: page.organization_id,
          pageId,
        });
        status = 'accepted';
      } catch (reason) {
        status = 'failed';
        errorMessage = reason instanceof Error ? reason.message : '写入评论失败';
      }
    }
  }

  await env.DB.prepare(
    `INSERT INTO inbound_emails(
       id, organization_id, from_email, to_email, subject, body_text, page_id,
       status, error_message, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      inboundId,
      organizationId,
      from || message.from,
      to || message.to,
      subject || null,
      body || null,
      acceptedPageId,
      status,
      errorMessage,
      now,
    )
    .run();
}

async function appendInboundComment(
  env: Env,
  input: { actorId: string; body: string; organizationId: string; pageId: string },
): Promise<void> {
  const page = await env.DB.prepare(
    'SELECT current_generation FROM pages WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(input.pageId)
    .first<{ current_generation: number }>();
  if (!page) throw new Error('页面不存在');
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const now = Date.now();
  const body = `来自邮件：\n${input.body.slice(0, 4_800)}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comment_threads(
         id, organization_id, page_id, generation, anchor_start, anchor_end,
         quoted_text, status, created_by, created_at, resolved_by, resolved_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'open', ?, ?, NULL, NULL)`,
    ).bind(
      threadId,
      input.organizationId,
      input.pageId,
      page.current_generation,
      input.actorId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO comments(
         id, thread_id, organization_id, author_id, body, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(commentId, threadId, input.organizationId, input.actorId, body, now, now),
  ]);
}

export function extractEmailAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
