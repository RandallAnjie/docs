import type {
  AuthUserSummary,
  CommentSummary,
  CommentThreadSummary,
  NotificationGroupSummary,
  NotificationSummary,
  NotificationType,
  PageNotificationMode,
  PageNotificationSettings,
  PageReminderStatus,
  PageReminderSummary,
} from '@rdocs/shared';

import { findActiveMembership, requirePageAction, resolvePageAccess } from './access';
import type { Env } from './env';

const MAX_COMMENT_LENGTH = 5_000;
const MAX_QUOTE_LENGTH = 500;
const MAX_ANCHOR_LENGTH = 2_000;
const MAX_REMINDER_MESSAGE_LENGTH = 500;
const MAX_SCHEDULED_REMINDERS_PER_PAGE = 100;
const MAX_REMINDER_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

interface ThreadRow {
  id: string;
  organization_id: string;
  page_id: string;
  generation: number;
  anchor_start: string | null;
  anchor_end: string | null;
  quoted_text: string | null;
  status: 'open' | 'resolved';
  created_by: string;
  created_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

interface CommentRow extends ThreadRow {
  comment_id: string;
  author_id: string;
  author_email: string;
  author_display_name: string;
  author_avatar_url: string | null;
  comment_body: string;
  comment_created_at: number;
  comment_updated_at: number;
}

interface NotificationRow {
  id: string;
  organization_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  type: NotificationType;
  page_id: string | null;
  page_title: string | null;
  thread_id: string | null;
  comment_id: string | null;
  metadata_json: string;
  created_at: number;
  read_at: number | null;
  archived_at: number | null;
}

interface PageSubscriptionRow {
  user_id: string;
  mode: PageNotificationMode;
}

interface PageReminderRow {
  id: string;
  organization_id: string;
  page_id: string;
  created_by: string;
  recipient_id: string;
  recipient_email: string;
  recipient_display_name: string;
  recipient_avatar_url: string | null;
  message: string;
  due_at: number;
  remind_at: number;
  timezone: string;
  status: PageReminderStatus;
  delivered_at: number | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ReminderInput {
  recipientId: string;
  message: string;
  dueAt: number;
  remindAt: number;
  timezone: string;
}

const PAGE_NOTIFICATION_MODES = new Set<PageNotificationMode>([
  'all_updates',
  'all_comments',
  'replies_mentions',
]);

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number): Response {
  return json({ error: message }, { status });
}

async function requestBody<T>(request: Request): Promise<T | null> {
  return request.json<T>().catch(() => null);
}

async function mapInBatches<T, R>(
  values: ReadonlyArray<T>,
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    results.push(...(await Promise.all(values.slice(offset, offset + batchSize).map(mapper))));
  }
  return results;
}

function commentFromRow(row: CommentRow): CommentSummary {
  return {
    id: row.comment_id,
    threadId: row.id,
    author: {
      id: row.author_id,
      email: row.author_email,
      displayName: row.author_display_name,
      avatarUrl: row.author_avatar_url,
    },
    body: row.comment_body,
    createdAt: Number(row.comment_created_at),
    updatedAt: Number(row.comment_updated_at),
  };
}

function threadFromRow(row: ThreadRow, comments: CommentSummary[]): CommentThreadSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    generation: Number(row.generation),
    anchorStart: row.anchor_start,
    anchorEnd: row.anchor_end,
    quotedText: row.quoted_text,
    status: row.status,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    comments,
  };
}

async function listThreads(env: Env, pageId: string): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT t.id, t.organization_id, t.page_id, t.generation,
              t.anchor_start, t.anchor_end, t.quoted_text, t.status,
              t.created_by, t.created_at, t.resolved_by, t.resolved_at,
              c.id AS comment_id, c.author_id, c.body AS comment_body,
              c.created_at AS comment_created_at, c.updated_at AS comment_updated_at,
              u.email AS author_email, u.display_name AS author_display_name,
              u.avatar_url AS author_avatar_url
         FROM comment_threads t
         JOIN comments c ON c.thread_id = t.id AND c.deleted_at IS NULL
         JOIN (
           SELECT thread_id, MAX(created_at) AS latest_at
             FROM comments WHERE deleted_at IS NULL GROUP BY thread_id
         ) latest ON latest.thread_id = t.id
         JOIN users u ON u.id = c.author_id
        WHERE t.page_id = ?
        ORDER BY latest.latest_at DESC, t.id ASC, c.created_at ASC`,
    )
      .bind(pageId)
      .all<CommentRow>()
  ).results;
  const threads = new Map<string, CommentThreadSummary>();
  for (const row of rows) {
    const existing = threads.get(row.id);
    if (existing) existing.comments.push(commentFromRow(row));
    else threads.set(row.id, threadFromRow(row, [commentFromRow(row)]));
  }
  return json({ threads: [...threads.values()] });
}

function normalizedComment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value.trim();
  return body && body.length <= MAX_COMMENT_LENGTH ? body : null;
}

function optionalBounded(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && value.length <= maximum ? value : undefined;
}

function validTimezone(value: string): boolean {
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizedReminderInput(
  value: {
    recipientId?: unknown;
    message?: unknown;
    dueAt?: unknown;
    remindAt?: unknown;
    timezone?: unknown;
  } | null,
  now = Date.now(),
): ReminderInput | null {
  const recipientId = typeof value?.recipientId === 'string' ? value.recipientId.trim() : '';
  const message = typeof value?.message === 'string' ? value.message.trim() : '';
  const dueAt = Number(value?.dueAt);
  const remindAt = Number(value?.remindAt);
  const timezone = typeof value?.timezone === 'string' ? value.timezone.trim() : '';
  if (
    !recipientId ||
    !message ||
    message.length > MAX_REMINDER_MESSAGE_LENGTH ||
    !Number.isSafeInteger(dueAt) ||
    !Number.isSafeInteger(remindAt) ||
    dueAt <= now ||
    dueAt > now + MAX_REMINDER_FUTURE_MS ||
    remindAt > dueAt ||
    remindAt < now - 60_000 ||
    !validTimezone(timezone)
  ) {
    return null;
  }
  return { recipientId, message, dueAt, remindAt, timezone };
}

function reminderFromRow(row: PageReminderRow): PageReminderSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    pageId: row.page_id,
    createdBy: row.created_by,
    recipient: {
      id: row.recipient_id,
      email: row.recipient_email,
      displayName: row.recipient_display_name,
      avatarUrl: row.recipient_avatar_url,
    },
    message: row.message,
    dueAt: Number(row.due_at),
    remindAt: Number(row.remind_at),
    timezone: row.timezone,
    status: row.status,
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    cancelledAt: row.cancelled_at === null ? null : Number(row.cancelled_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function groupNotifications(
  notifications: readonly NotificationSummary[],
): NotificationGroupSummary[] {
  const groups = new Map<string, NotificationGroupSummary>();
  for (const notification of notifications) {
    const key = notification.pageId
      ? `page:${notification.pageId}:${notification.threadId ? `thread:${notification.threadId}` : 'updates'}`
      : `organization:${notification.organizationId}:notification:${notification.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.notifications.push(notification);
      existing.latestAt = Math.max(existing.latestAt, notification.createdAt);
      if (notification.readAt === null) existing.unreadCount += 1;
      continue;
    }
    groups.set(key, {
      key,
      organizationId: notification.organizationId,
      pageId: notification.pageId,
      pageTitle: notification.pageTitle,
      threadId: notification.threadId,
      latestAt: notification.createdAt,
      unreadCount: notification.readAt === null ? 1 : 0,
      notifications: [notification],
    });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      notifications: group.notifications.sort((left, right) => right.createdAt - left.createdAt),
    }))
    .sort((left, right) => right.latestAt - left.latestAt);
}

function notificationStatement(
  env: Env,
  organizationId: string,
  userId: string,
  actorId: string,
  type: NotificationType,
  pageId: string,
  threadId: string | null,
  commentId: string | null,
  metadata: Record<string, unknown> = {},
  eventKey: string | null = null,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notifications(
       id, organization_id, user_id, actor_id, type, page_id, thread_id,
       comment_id, metadata_json, event_key, created_at, read_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(user_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    organizationId,
    userId,
    actorId,
    type,
    pageId,
    threadId,
    commentId,
    JSON.stringify(metadata),
    eventKey,
    Date.now(),
  );
}

async function reminderRecipient(
  env: Env,
  organizationId: string,
  pageId: string,
  userId: string,
): Promise<boolean> {
  const membership = await env.DB.prepare(
    `SELECT 1 AS found
       FROM organization_members
      WHERE organization_id = ? AND user_id = ? AND status = 'active' AND role <> 'guest'`,
  )
    .bind(organizationId, userId)
    .first<{ found: number }>();
  return Boolean(membership && (await resolvePageAccess(env, pageId, userId)));
}

export async function deliverDueReminders(
  env: Env,
  recipientId: string | null = null,
  limit = 100,
): Promise<number> {
  const now = Date.now();
  const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
  const due = (
    await env.DB.prepare(
      `SELECT r.id, r.organization_id, r.page_id, r.created_by, r.recipient_id,
              u.email AS recipient_email, u.display_name AS recipient_display_name,
              u.avatar_url AS recipient_avatar_url, r.message, r.due_at, r.remind_at,
              r.timezone, r.status, r.delivered_at, r.cancelled_at,
              r.created_at, r.updated_at
         FROM page_reminders r
         JOIN users u ON u.id = r.recipient_id
        WHERE r.status = 'scheduled' AND r.remind_at <= ?
          AND (? IS NULL OR r.recipient_id = ?)
        ORDER BY r.remind_at ASC, r.id ASC
        LIMIT ?`,
    )
      .bind(now, recipientId, recipientId, boundedLimit)
      .all<PageReminderRow>()
  ).results;
  const access = await mapInBatches(due, 8, (reminder) =>
    reminderRecipient(env, reminder.organization_id, reminder.page_id, reminder.recipient_id),
  );
  let delivered = 0;
  for (let index = 0; index < due.length; index += 1) {
    const reminder = due[index];
    if (!reminder) continue;
    if (!access[index]) {
      await env.DB.prepare(
        `UPDATE page_reminders
            SET status = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE id = ? AND status = 'scheduled'`,
      )
        .bind(now, now, reminder.id)
        .run();
      continue;
    }
    const result = await env.DB.batch([
      notificationStatement(
        env,
        reminder.organization_id,
        reminder.recipient_id,
        reminder.created_by,
        'reminder',
        reminder.page_id,
        null,
        null,
        {
          reminderId: reminder.id,
          message: reminder.message,
          dueAt: Number(reminder.due_at),
          remindAt: Number(reminder.remind_at),
          timezone: reminder.timezone,
        },
        `reminder:${reminder.id}`,
      ),
      env.DB.prepare(
        `UPDATE page_reminders
            SET status = 'delivered', delivered_at = ?, updated_at = ?
          WHERE id = ? AND status = 'scheduled'`,
      ).bind(now, now, reminder.id),
    ]);
    if (result[1]?.meta.changes) delivered += 1;
  }
  return delivered;
}

async function listPageReminders(
  env: Env,
  actor: AuthUserSummary,
  pageId: string,
): Promise<Response> {
  const pageAccess = await resolvePageAccess(env, pageId, actor.id);
  if (!pageAccess) {
    return error('页面不存在或无权查看提醒', 404);
  }
  await deliverDueReminders(env, actor.id, 100);
  const rows = (
    await env.DB.prepare(
      `SELECT r.id, r.organization_id, r.page_id, r.created_by, r.recipient_id,
              u.email AS recipient_email, u.display_name AS recipient_display_name,
              u.avatar_url AS recipient_avatar_url, r.message, r.due_at, r.remind_at,
              r.timezone, r.status, r.delivered_at, r.cancelled_at,
              r.created_at, r.updated_at
         FROM page_reminders r
         JOIN users u ON u.id = r.recipient_id
        WHERE r.page_id = ? AND r.status = 'scheduled'
          AND (r.created_by = ? OR r.recipient_id = ?)
        ORDER BY r.remind_at ASC, r.id ASC
        LIMIT 100`,
    )
      .bind(pageId, actor.id, actor.id)
      .all<PageReminderRow>()
  ).results;
  const candidates = (
    await env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.avatar_url
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ? AND m.status = 'active' AND m.role <> 'guest'
        ORDER BY u.display_name COLLATE NOCASE ASC, u.id ASC
        LIMIT 500`,
    )
      .bind(pageAccess.organizationId)
      .all<{ id: string; email: string; display_name: string; avatar_url: string | null }>()
  ).results;
  const recipientAccess = await mapInBatches(candidates, 8, (candidate) =>
    resolvePageAccess(env, pageId, candidate.id),
  );
  const recipients: AuthUserSummary[] = candidates.flatMap((candidate, index) =>
    recipientAccess[index]
      ? [
          {
            id: candidate.id,
            email: candidate.email,
            displayName: candidate.display_name,
            avatarUrl: candidate.avatar_url,
          },
        ]
      : [],
  );
  return json({ reminders: rows.map(reminderFromRow), recipients });
}

async function createPageReminder(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  pageId: string,
): Promise<Response> {
  const access = await requirePageAction(env, pageId, actor.id, 'edit_content');
  if (!access) return error('页面不存在或无权创建提醒', 404);
  const input = normalizedReminderInput(
    await requestBody<{
      recipientId?: unknown;
      message?: unknown;
      dueAt?: unknown;
      remindAt?: unknown;
      timezone?: unknown;
    }>(request),
  );
  if (!input) return error('提醒的对象、内容、日期、提前量或时区无效', 400);
  if (!(await reminderRecipient(env, access.organizationId, pageId, input.recipientId))) {
    return error('提醒对象不是有权查看此页面的正式成员', 400);
  }
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM page_reminders
      WHERE page_id = ? AND created_by = ? AND status = 'scheduled'`,
  )
    .bind(pageId, actor.id)
    .first<{ count: number }>();
  if (Number(existing?.count ?? 0) >= MAX_SCHEDULED_REMINDERS_PER_PAGE) {
    return error('此页面的待触发提醒已达到上限', 409);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO page_reminders(
       id, organization_id, page_id, created_by, recipient_id, message,
       due_at, remind_at, timezone, status, delivered_at, cancelled_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, ?, ?)`,
  )
    .bind(
      id,
      access.organizationId,
      pageId,
      actor.id,
      input.recipientId,
      input.message,
      input.dueAt,
      input.remindAt,
      input.timezone,
      now,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO audit_events(
       id, organization_id, actor_id, event_type, target_type, target_id,
       request_id, metadata_json, created_at
     ) VALUES (?, ?, ?, 'page.reminder.created', 'page', ?, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      access.organizationId,
      actor.id,
      pageId,
      JSON.stringify({
        reminderId: id,
        recipientId: input.recipientId,
        dueAt: input.dueAt,
        remindAt: input.remindAt,
      }),
      now,
    )
    .run()
    .catch(() => undefined);
  return listPageReminders(env, actor, pageId);
}

async function findPageReminder(env: Env, reminderId: string): Promise<PageReminderRow | null> {
  return env.DB.prepare(
    `SELECT r.id, r.organization_id, r.page_id, r.created_by, r.recipient_id,
            u.email AS recipient_email, u.display_name AS recipient_display_name,
            u.avatar_url AS recipient_avatar_url, r.message, r.due_at, r.remind_at,
            r.timezone, r.status, r.delivered_at, r.cancelled_at,
            r.created_at, r.updated_at
       FROM page_reminders r
       JOIN users u ON u.id = r.recipient_id
      WHERE r.id = ?`,
  )
    .bind(reminderId)
    .first<PageReminderRow>();
}

async function cancelPageReminder(
  env: Env,
  actor: AuthUserSummary,
  reminderId: string,
): Promise<Response> {
  const reminder = await findPageReminder(env, reminderId);
  if (
    !reminder ||
    (reminder.created_by !== actor.id && reminder.recipient_id !== actor.id) ||
    !(await resolvePageAccess(env, reminder.page_id, actor.id))
  ) {
    return error('提醒不存在或无权取消', 404);
  }
  if (reminder.status !== 'scheduled') return error('提醒已经触发或取消', 409);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE page_reminders
        SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(now, now, reminderId)
    .run();
  return json({ ok: true });
}

async function updatePageReminder(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  reminderId: string,
): Promise<Response> {
  const reminder = await findPageReminder(env, reminderId);
  if (!reminder || reminder.created_by !== actor.id) {
    return error('提醒不存在或无权修改', 404);
  }
  if (reminder.status !== 'scheduled') return error('已经触发或取消的提醒不能修改', 409);
  const pageAccess = await requirePageAction(env, reminder.page_id, actor.id, 'edit_content');
  if (!pageAccess) return error('页面不存在或无权修改提醒', 404);
  const input = normalizedReminderInput(
    await requestBody<{
      recipientId?: unknown;
      message?: unknown;
      dueAt?: unknown;
      remindAt?: unknown;
      timezone?: unknown;
    }>(request),
  );
  if (!input) return error('提醒的对象、内容、日期、提前量或时区无效', 400);
  if (
    !(await reminderRecipient(env, reminder.organization_id, reminder.page_id, input.recipientId))
  ) {
    return error('提醒对象不是有权查看此页面的正式成员', 400);
  }
  const now = Date.now();
  const updated = await env.DB.prepare(
    `UPDATE page_reminders
        SET recipient_id = ?, message = ?, due_at = ?, remind_at = ?,
            timezone = ?, updated_at = ?
      WHERE id = ? AND created_by = ? AND status = 'scheduled'`,
  )
    .bind(
      input.recipientId,
      input.message,
      input.dueAt,
      input.remindAt,
      input.timezone,
      now,
      reminderId,
      actor.id,
    )
    .run();
  if (!updated.meta.changes) return error('提醒状态已变化，请重试', 409);
  return listPageReminders(env, actor, reminder.page_id);
}

async function ensurePageSubscription(
  env: Env,
  organizationId: string,
  pageId: string,
  userId: string,
  mode: PageNotificationMode,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO page_notification_subscriptions(
       page_id, organization_id, user_id, mode, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id, user_id) DO NOTHING`,
  )
    .bind(pageId, organizationId, userId, mode, now, now)
    .run();
}

async function notificationRecipients(
  env: Env,
  organizationId: string,
  pageId: string,
  threadId: string,
  body: string,
  actorId: string,
): Promise<Map<string, NotificationType>> {
  const recipients = new Map<string, NotificationType>();
  const subscribers = (
    await env.DB.prepare(
      `SELECT s.user_id, s.mode
         FROM page_notification_subscriptions s
         JOIN organization_members m
           ON m.organization_id = s.organization_id AND m.user_id = s.user_id
        WHERE s.page_id = ? AND s.organization_id = ?
          AND s.mode IN ('all_updates', 'all_comments')
          AND m.status = 'active' AND s.user_id <> ?`,
    )
      .bind(pageId, organizationId, actorId)
      .all<PageSubscriptionRow>()
  ).results;
  for (const subscriber of subscribers) recipients.set(subscriber.user_id, 'page_comment');
  const participants = (
    await env.DB.prepare(
      `SELECT DISTINCT c.author_id AS user_id
         FROM comments c WHERE c.thread_id = ? AND c.deleted_at IS NULL
       UNION SELECT created_by AS user_id FROM pages WHERE id = ?`,
    )
      .bind(threadId, pageId)
      .all<{ user_id: string }>()
  ).results;
  for (const participant of participants) {
    if (participant.user_id !== actorId) recipients.set(participant.user_id, 'comment_reply');
  }
  const emails = [...body.matchAll(/@([\w.+-]+@[\w.-]+\.[a-z]{2,})/gi)].map((match) =>
    (match[1] ?? '').toLowerCase(),
  );
  if (emails.length) {
    const members = (
      await env.DB.prepare(
        `SELECT u.id, u.email
           FROM users u JOIN organization_members m ON m.user_id = u.id
          WHERE m.organization_id = ? AND m.status = 'active'`,
      )
        .bind(organizationId)
        .all<{ id: string; email: string }>()
    ).results;
    const wanted = new Set(emails);
    for (const member of members) {
      if (member.id !== actorId && wanted.has(member.email.toLowerCase())) {
        recipients.set(member.id, 'mention');
      }
    }
  }
  const recipientIds = [...recipients.keys()];
  const access = await mapInBatches(recipientIds, 8, async (userId) =>
    Boolean(await resolvePageAccess(env, pageId, userId)),
  );
  for (let index = 0; index < recipientIds.length; index += 1) {
    const recipientId = recipientIds[index];
    if (!access[index] && recipientId) recipients.delete(recipientId);
  }
  return recipients;
}

async function createThread(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  pageId: string,
): Promise<Response> {
  const input = await requestBody<{
    body?: unknown;
    quotedText?: unknown;
    anchorStart?: unknown;
    anchorEnd?: unknown;
  }>(request);
  const body = normalizedComment(input?.body);
  const quotedText = optionalBounded(input?.quotedText, MAX_QUOTE_LENGTH);
  const anchorStart = optionalBounded(input?.anchorStart, MAX_ANCHOR_LENGTH);
  const anchorEnd = optionalBounded(input?.anchorEnd, MAX_ANCHOR_LENGTH);
  if (!body) return error('评论必须为 1–5000 个字符', 400);
  if (quotedText === undefined || anchorStart === undefined || anchorEnd === undefined) {
    return error('评论引用或锚点过长', 400);
  }
  const page = await env.DB.prepare(
    'SELECT organization_id, current_generation FROM pages WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(pageId)
    .first<{ organization_id: string; current_generation: number }>();
  if (!page) return error('页面不存在', 404);
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comment_threads(
         id, organization_id, page_id, generation, anchor_start, anchor_end,
         quoted_text, status, created_by, created_at, resolved_by, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL)`,
    ).bind(
      threadId,
      page.organization_id,
      pageId,
      page.current_generation,
      anchorStart,
      anchorEnd,
      quotedText,
      actor.id,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO comments(
         id, thread_id, organization_id, author_id, body, created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(commentId, threadId, page.organization_id, actor.id, body, now, now),
  ]);
  await ensurePageSubscription(
    env,
    page.organization_id,
    pageId,
    actor.id,
    'replies_mentions',
    now,
  );
  const recipients = await notificationRecipients(
    env,
    page.organization_id,
    pageId,
    threadId,
    body,
    actor.id,
  );
  if (recipients.size) {
    await env.DB.batch(
      [...recipients].map(([userId, type]) =>
        notificationStatement(
          env,
          page.organization_id,
          userId,
          actor.id,
          type,
          pageId,
          threadId,
          commentId,
        ),
      ),
    );
  }
  return listThreads(env, pageId);
}

async function findThread(env: Env, threadId: string): Promise<ThreadRow | null> {
  return env.DB.prepare(
    `SELECT id, organization_id, page_id, generation, anchor_start, anchor_end,
            quoted_text, status, created_by, created_at, resolved_by, resolved_at
       FROM comment_threads WHERE id = ?`,
  )
    .bind(threadId)
    .first<ThreadRow>();
}

async function replyToThread(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  thread: ThreadRow,
): Promise<Response> {
  const input = await requestBody<{ body?: unknown }>(request);
  const body = normalizedComment(input?.body);
  if (!body) return error('回复必须为 1–5000 个字符', 400);
  const commentId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO comments(
       id, thread_id, organization_id, author_id, body, created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(commentId, thread.id, thread.organization_id, actor.id, body, now, now)
    .run();
  await ensurePageSubscription(
    env,
    thread.organization_id,
    thread.page_id,
    actor.id,
    'replies_mentions',
    now,
  );
  const recipients = await notificationRecipients(
    env,
    thread.organization_id,
    thread.page_id,
    thread.id,
    body,
    actor.id,
  );
  if (recipients.size) {
    await env.DB.batch(
      [...recipients].map(([userId, type]) =>
        notificationStatement(
          env,
          thread.organization_id,
          userId,
          actor.id,
          type,
          thread.page_id,
          thread.id,
          commentId,
        ),
      ),
    );
  }
  return listThreads(env, thread.page_id);
}

async function resolveThread(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  thread: ThreadRow,
): Promise<Response> {
  const input = await requestBody<{ resolved?: unknown }>(request);
  if (typeof input?.resolved !== 'boolean') return error('resolved 必须是布尔值', 400);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE comment_threads
        SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
  )
    .bind(
      input.resolved ? 'resolved' : 'open',
      input.resolved ? actor.id : null,
      input.resolved ? now : null,
      thread.id,
    )
    .run();
  return listThreads(env, thread.page_id);
}

export async function deliverPageUpdateNotifications(
  env: Env,
  input: {
    organizationId: string;
    pageId: string;
    actorId: string;
    eventKey: string;
    metadata?: Record<string, unknown>;
  },
): Promise<number> {
  const subscriptions = (
    await env.DB.prepare(
      `SELECT s.user_id, s.mode
         FROM page_notification_subscriptions s
         JOIN organization_members m
           ON m.organization_id = s.organization_id AND m.user_id = s.user_id
        WHERE s.page_id = ? AND s.organization_id = ? AND s.mode = 'all_updates'
          AND m.status = 'active' AND s.user_id <> ?`,
    )
      .bind(input.pageId, input.organizationId, input.actorId)
      .all<PageSubscriptionRow>()
  ).results;
  const access = await mapInBatches(subscriptions, 8, async (subscription) =>
    Boolean(await resolvePageAccess(env, input.pageId, subscription.user_id)),
  );
  const statements = subscriptions.flatMap((subscription, index) => {
    if (!access[index]) return [];
    return [
      notificationStatement(
        env,
        input.organizationId,
        subscription.user_id,
        input.actorId,
        'page_updated',
        input.pageId,
        null,
        null,
        input.metadata,
        input.eventKey,
      ),
    ];
  });
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.batch(statements.slice(offset, offset + 50));
  }
  return statements.length;
}

async function pageNotificationSettings(
  env: Env,
  actor: AuthUserSummary,
  pageId: string,
): Promise<Response> {
  const access = await resolvePageAccess(env, pageId, actor.id);
  if (!access) return error('页面不存在或无权访问', 404);
  const row = await env.DB.prepare(
    'SELECT mode FROM page_notification_subscriptions WHERE page_id = ? AND user_id = ?',
  )
    .bind(pageId, actor.id)
    .first<{ mode: PageNotificationMode }>();
  const settings: PageNotificationSettings = {
    pageId,
    mode: row?.mode ?? 'replies_mentions',
    explicitlySet: Boolean(row),
  };
  return json({ settings });
}

async function updatePageNotificationSettings(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  pageId: string,
): Promise<Response> {
  const access = await resolvePageAccess(env, pageId, actor.id);
  if (!access) return error('页面不存在或无权访问', 404);
  const input = await requestBody<{ mode?: unknown }>(request);
  if (
    typeof input?.mode !== 'string' ||
    !PAGE_NOTIFICATION_MODES.has(input.mode as PageNotificationMode)
  ) {
    return error('页面通知级别无效', 400);
  }
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO page_notification_subscriptions(
       page_id, organization_id, user_id, mode, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(page_id, user_id) DO UPDATE SET
       mode = excluded.mode, organization_id = excluded.organization_id, updated_at = excluded.updated_at`,
  )
    .bind(pageId, access.organizationId, actor.id, input.mode, now, now)
    .run();
  const settings: PageNotificationSettings = {
    pageId,
    mode: input.mode as PageNotificationMode,
    explicitlySet: true,
  };
  return json({ settings });
}

function notificationFromRow(row: NotificationRow): NotificationSummary {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    // Corrupt metadata must not break the notification center.
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    actor: row.actor_id
      ? {
          id: row.actor_id,
          email: row.actor_email ?? '',
          displayName: row.actor_display_name ?? '已删除用户',
          avatarUrl: row.actor_avatar_url,
        }
      : null,
    type: row.type,
    pageId: row.page_id,
    pageTitle: row.page_title,
    threadId: row.thread_id,
    commentId: row.comment_id,
    metadata,
    createdAt: Number(row.created_at),
    readAt: row.read_at === null ? null : Number(row.read_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

async function listNotifications(env: Env, actor: AuthUserSummary, url: URL): Promise<Response> {
  const organizationId = url.searchParams.get('organizationId');
  const view = url.searchParams.get('view') ?? 'inbox';
  if (!['inbox', 'unread', 'archived'].includes(view)) return error('通知筛选无效', 400);
  if (organizationId && !(await findActiveMembership(env, organizationId, actor.id))) {
    return error('组织不存在或无权访问', 404);
  }
  await deliverDueReminders(env, actor.id, 100);
  const rows = (
    await env.DB.prepare(
      `SELECT n.id, n.organization_id, n.actor_id, n.type, n.page_id,
              p.title AS page_title, n.thread_id, n.comment_id, n.metadata_json,
              n.created_at, n.read_at, n.archived_at, u.email AS actor_email,
              u.display_name AS actor_display_name, u.avatar_url AS actor_avatar_url
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         LEFT JOIN pages p ON p.id = n.page_id
        WHERE n.user_id = ? AND (? IS NULL OR n.organization_id = ?)
        ORDER BY n.created_at DESC LIMIT 200`,
    )
      .bind(actor.id, organizationId, organizationId)
      .all<NotificationRow>()
  ).results;
  const pageIds = [...new Set(rows.flatMap((row) => (row.page_id === null ? [] : [row.page_id])))];
  const organizationIds = [
    ...new Set(rows.flatMap((row) => (row.page_id === null ? [row.organization_id] : []))),
  ];
  const [pageAccessEntries, membershipEntries] = await Promise.all([
    mapInBatches(
      pageIds,
      8,
      async (pageId) => [pageId, Boolean(await resolvePageAccess(env, pageId, actor.id))] as const,
    ),
    mapInBatches(
      organizationIds,
      8,
      async (candidateOrganizationId) =>
        [
          candidateOrganizationId,
          Boolean(await findActiveMembership(env, candidateOrganizationId, actor.id)),
        ] as const,
    ),
  ]);
  const visiblePages = new Map(pageAccessEntries);
  const visibleOrganizations = new Map(membershipEntries);
  const visible: NotificationSummary[] = [];
  for (const row of rows) {
    if (row.page_id && !visiblePages.get(row.page_id)) continue;
    if (!row.page_id && !visibleOrganizations.get(row.organization_id)) continue;
    visible.push(notificationFromRow(row));
  }
  const unreadCount = visible.filter(
    (notification) => notification.archivedAt === null && notification.readAt === null,
  ).length;
  const notifications = visible
    .filter((notification) => {
      if (view === 'archived') return notification.archivedAt !== null;
      if (notification.archivedAt !== null) return false;
      return view !== 'unread' || notification.readAt === null;
    })
    .slice(0, 100);
  return json({
    notifications,
    groups: groupNotifications(notifications),
    unreadCount,
    resultCapReached: rows.length === 200,
  });
}

async function updateNotificationSelection(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response> {
  const input = await requestBody<{
    ids?: unknown;
    read?: unknown;
    archived?: unknown;
  }>(request);
  if (
    !Array.isArray(input?.ids) ||
    input.ids.length < 1 ||
    input.ids.length > 100 ||
    input.ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 100) ||
    (input.read !== undefined && typeof input.read !== 'boolean') ||
    (input.archived !== undefined && typeof input.archived !== 'boolean') ||
    (input.read === undefined && input.archived === undefined)
  ) {
    return error('通知批量状态无效', 400);
  }
  const ids = [...new Set(input.ids as string[])];
  const placeholders = ids.map(() => '?').join(', ');
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (typeof input.read === 'boolean') {
    statements.push(
      env.DB.prepare(
        `UPDATE notifications SET read_at = ?
          WHERE user_id = ? AND id IN (${placeholders})`,
      ).bind(input.read ? now : null, actor.id, ...ids),
    );
  }
  if (typeof input.archived === 'boolean') {
    statements.push(
      env.DB.prepare(
        `UPDATE notifications SET archived_at = ?
          WHERE user_id = ? AND id IN (${placeholders})`,
      ).bind(input.archived ? now : null, actor.id, ...ids),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function bulkNotificationAction(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  action: 'read-all' | 'archive-read' | 'archive-all',
): Promise<Response> {
  const input = await requestBody<{ organizationId?: unknown }>(request);
  const organizationId = input?.organizationId;
  if (
    typeof organizationId !== 'string' ||
    !(await findActiveMembership(env, organizationId, actor.id))
  ) {
    return error('组织不存在或无权访问', 404);
  }
  const now = Date.now();
  if (action === 'read-all') {
    await env.DB.prepare(
      `UPDATE notifications SET read_at = ?
        WHERE user_id = ? AND organization_id = ? AND archived_at IS NULL AND read_at IS NULL`,
    )
      .bind(now, actor.id, organizationId)
      .run();
  } else if (action === 'archive-read') {
    await env.DB.prepare(
      `UPDATE notifications SET archived_at = ?
        WHERE user_id = ? AND organization_id = ? AND archived_at IS NULL AND read_at IS NOT NULL`,
    )
      .bind(now, actor.id, organizationId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE notifications SET archived_at = ?
        WHERE user_id = ? AND organization_id = ? AND archived_at IS NULL`,
    )
      .bind(now, actor.id, organizationId)
      .run();
  }
  return json({ ok: true });
}

export async function handleCommentsAndNotificationsApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/notifications' && request.method === 'GET') {
    return listNotifications(env, actor, url);
  }
  if (url.pathname === '/api/notifications' && request.method === 'PATCH') {
    return updateNotificationSelection(request, env, actor);
  }
  if (url.pathname === '/api/notifications/read-all' && request.method === 'POST') {
    return bulkNotificationAction(request, env, actor, 'read-all');
  }
  if (url.pathname === '/api/notifications/archive-read' && request.method === 'POST') {
    return bulkNotificationAction(request, env, actor, 'archive-read');
  }
  if (url.pathname === '/api/notifications/archive-all' && request.method === 'POST') {
    return bulkNotificationAction(request, env, actor, 'archive-all');
  }
  const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notificationReadMatch?.[1] && request.method === 'PATCH') {
    await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .bind(Date.now(), decodeURIComponent(notificationReadMatch[1]), actor.id)
      .run();
    return json({ ok: true });
  }

  const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (notificationMatch?.[1] && request.method === 'PATCH') {
    const input = await requestBody<{ read?: unknown; archived?: unknown }>(request);
    if (
      (input?.read !== undefined && typeof input.read !== 'boolean') ||
      (input?.archived !== undefined && typeof input.archived !== 'boolean') ||
      (input?.read === undefined && input?.archived === undefined)
    ) {
      return error('通知状态无效', 400);
    }
    const id = decodeURIComponent(notificationMatch[1]);
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    if (typeof input.read === 'boolean') {
      statements.push(
        env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').bind(
          input.read ? now : null,
          id,
          actor.id,
        ),
      );
    }
    if (typeof input.archived === 'boolean') {
      statements.push(
        env.DB.prepare(
          'UPDATE notifications SET archived_at = ? WHERE id = ? AND user_id = ?',
        ).bind(input.archived ? now : null, id, actor.id),
      );
    }
    await env.DB.batch(statements);
    return json({ ok: true });
  }

  const pageNotificationMatch = url.pathname.match(
    /^\/api\/pages\/([^/]+)\/notification-settings$/,
  );
  if (pageNotificationMatch?.[1]) {
    const pageId = decodeURIComponent(pageNotificationMatch[1]);
    if (request.method === 'GET') return pageNotificationSettings(env, actor, pageId);
    if (request.method === 'PUT') {
      return updatePageNotificationSettings(request, env, actor, pageId);
    }
  }

  const pageRemindersMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/reminders$/);
  if (pageRemindersMatch?.[1]) {
    const pageId = decodeURIComponent(pageRemindersMatch[1]);
    if (request.method === 'GET') return listPageReminders(env, actor, pageId);
    if (request.method === 'POST') return createPageReminder(request, env, actor, pageId);
  }

  const reminderMatch = url.pathname.match(/^\/api\/reminders\/([^/]+)$/);
  if (reminderMatch?.[1]) {
    const reminderId = decodeURIComponent(reminderMatch[1]);
    if (!ID_PATTERN.test(reminderId)) return error('提醒 ID 无效', 400);
    if (request.method === 'PATCH') return updatePageReminder(request, env, actor, reminderId);
    if (request.method === 'DELETE') return cancelPageReminder(env, actor, reminderId);
  }

  const pageCommentsMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/comments$/);
  if (pageCommentsMatch?.[1]) {
    const pageId = decodeURIComponent(pageCommentsMatch[1]);
    const action = request.method === 'POST' ? 'comment' : 'view';
    if (!(await requirePageAction(env, pageId, actor.id, action))) {
      return error('页面不存在或无权访问评论', 404);
    }
    if (request.method === 'GET') return listThreads(env, pageId);
    if (request.method === 'POST') return createThread(request, env, actor, pageId);
  }

  const replyMatch = url.pathname.match(/^\/api\/comment-threads\/([^/]+)\/comments$/);
  if (replyMatch?.[1] && request.method === 'POST') {
    const thread = await findThread(env, decodeURIComponent(replyMatch[1]));
    if (!thread || !(await requirePageAction(env, thread.page_id, actor.id, 'comment'))) {
      return error('评论线程不存在或无权回复', 404);
    }
    return replyToThread(request, env, actor, thread);
  }

  const threadMatch = url.pathname.match(/^\/api\/comment-threads\/([^/]+)$/);
  if (threadMatch?.[1] && request.method === 'PATCH') {
    const thread = await findThread(env, decodeURIComponent(threadMatch[1]));
    if (!thread || !(await requirePageAction(env, thread.page_id, actor.id, 'comment'))) {
      return error('评论线程不存在或无权处理', 404);
    }
    return resolveThread(request, env, actor, thread);
  }
  return null;
}
