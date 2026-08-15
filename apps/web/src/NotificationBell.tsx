import {
  Archive,
  Bell,
  BellRing,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  MessageSquare,
  Pencil,
  Send,
  Shield,
  Trash2,
  UserRoundPlus,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type {
  AuthUserSummary,
  NotificationGroupSummary,
  NotificationSummary,
  PageNotificationMode,
  PageNotificationSettings,
  PageReminderSummary,
} from '@rdocs/shared';

import {
  archiveAllNotifications,
  archiveReadNotifications,
  cancelPageReminder,
  createPageReminder,
  getPageNotificationSettings,
  listNotificationsView,
  listPageReminders,
  markAllNotificationsRead,
  replyToCommentThread,
  setPageNotificationSettings,
  updateNotification,
  updateNotifications,
  updatePageReminder,
  type NotificationView,
} from './api';

const PAGE_NOTIFICATION_OPTIONS: ReadonlyArray<{
  mode: PageNotificationMode;
  label: string;
  description: string;
}> = [
  { mode: 'all_updates', label: '所有更新', description: '页面内容、属性和所有评论' },
  { mode: 'all_comments', label: '所有评论', description: '新评论、回复和提及' },
  { mode: 'replies_mentions', label: '回复与提及', description: '只在需要你时提醒' },
];

function notificationText(notification: NotificationSummary): string {
  const actor = notification.actor?.displayName ?? '系统';
  switch (notification.type) {
    case 'mention':
      return `${actor} 在评论中提及了你`;
    case 'comment_reply':
      return `${actor} 回复了你参与的评论`;
    case 'page_comment':
      return `${actor} 发表了新评论`;
    case 'page_updated':
      return `${actor} 更新了页面`;
    case 'permission_changed':
      return `${actor} 更新了页面权限`;
    case 'invitation_accepted':
      return `${actor} 接受了组织邀请`;
    case 'reminder':
      return `提醒：${String(notification.metadata.message ?? notification.pageTitle ?? '查看页面')}`;
    default:
      return `${actor} 向你分享了页面`;
  }
}

function NotificationIcon({ notification }: { notification: NotificationSummary }) {
  if (notification.type === 'permission_changed') return <Shield size={15} />;
  if (notification.type === 'invitation_accepted') return <UserRoundPlus size={15} />;
  if (notification.type === 'page_updated') return <BellRing size={15} />;
  if (notification.type === 'reminder') return <Clock3 size={15} />;
  return <MessageSquare size={15} />;
}

export function NotificationBell({ organizationId }: { organizationId: string }) {
  const [groups, setGroups] = useState<NotificationGroupSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [view, setView] = useState<NotificationView>('inbox');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [replyingGroupKey, setReplyingGroupKey] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await listNotificationsView(organizationId, view);
      setGroups(result.groups);
      setUnreadCount(result.unreadCount);
      setError(null);
    } catch (reason) {
      if (open) setError(reason instanceof Error ? reason.message : '无法加载通知');
    }
  }, [open, organizationId, view]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openNotification = async (notification: NotificationSummary) => {
    if (!notification.readAt) {
      await updateNotification(notification.id, { read: true }).catch(() => undefined);
    }
    if (notification.pageId) {
      const threadHash = notification.threadId
        ? `#comment=${encodeURIComponent(notification.threadId)}`
        : '';
      window.location.assign(`/p/${encodeURIComponent(notification.pageId)}${threadHash}`);
      return;
    }
    await load();
  };

  const mutateGroup = async (
    group: NotificationGroupSummary,
    input: { read?: boolean; archived?: boolean },
  ) => {
    try {
      await updateNotifications(
        group.notifications.map((notification) => notification.id),
        input,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新通知组');
    }
  };

  const notificationCount = groups.reduce((total, group) => total + group.notifications.length, 0);

  const replyFromInbox = async (event: FormEvent, group: NotificationGroupSummary) => {
    event.preventDefault();
    if (!group.threadId || !replyBody.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await replyToCommentThread(group.threadId, replyBody.trim());
      await updateNotifications(
        group.notifications.map((notification) => notification.id),
        { read: true },
      );
      setReplyBody('');
      setReplyingGroupKey(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法从收件箱回复评论');
    } finally {
      setBusy(false);
    }
  };

  const mutateNotification = async (
    notification: NotificationSummary,
    input: { read?: boolean; archived?: boolean },
  ) => {
    try {
      await updateNotification(notification.id, input);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新通知');
    }
  };

  const bulkAction = async (action: 'read' | 'archive-read' | 'archive-all') => {
    setBusy(true);
    setError(null);
    try {
      if (action === 'read') await markAllNotificationsRead(organizationId);
      else if (action === 'archive-read') await archiveReadNotifications(organizationId);
      else await archiveAllNotifications(organizationId);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法批量更新通知');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notification-control">
      <button
        className="icon-button"
        type="button"
        aria-label="收件箱"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setError(null);
        }}
      >
        <Bell size={17} />
        {unreadCount ? <b>{unreadCount > 99 ? '99+' : unreadCount}</b> : null}
      </button>
      {open ? (
        <section className="notification-popover">
          <header>
            <div>
              <strong>收件箱</strong>
              <span>{unreadCount} 条未读</span>
            </div>
            {view !== 'archived' ? (
              <div className="notification-bulk-actions">
                <button
                  disabled={busy || !unreadCount}
                  type="button"
                  onClick={() => void bulkAction('read')}
                >
                  <CheckCheck size={14} /> 全部已读
                </button>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void bulkAction('archive-read')}
                >
                  <Archive size={14} /> 归档已读
                </button>
                <button
                  disabled={busy || !notificationCount}
                  type="button"
                  onClick={() => void bulkAction('archive-all')}
                >
                  归档全部
                </button>
              </div>
            ) : null}
          </header>
          <div className="notification-filter">
            <button
              className={view === 'inbox' ? 'active' : ''}
              type="button"
              onClick={() => setView('inbox')}
            >
              未读和已读
            </button>
            <button
              className={view === 'unread' ? 'active' : ''}
              type="button"
              onClick={() => setView('unread')}
            >
              仅未读
            </button>
            <button
              className={view === 'archived' ? 'active' : ''}
              type="button"
              onClick={() => setView('archived')}
            >
              已归档
            </button>
          </div>
          <div className="notification-list">
            {groups.length ? (
              groups.map((group) => {
                const collapsed = collapsedGroups.has(group.key);
                return (
                  <section
                    className={`notification-group ${group.unreadCount ? 'unread' : ''}`}
                    key={group.key}
                  >
                    <header>
                      <button
                        className="notification-group-toggle"
                        type="button"
                        aria-expanded={!collapsed}
                        onClick={() =>
                          setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                      >
                        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        <span>
                          <strong>{group.pageTitle ?? '组织通知'}</strong>
                          <small>
                            {group.threadId ? '评论线程' : '页面更新'} ·{' '}
                            {group.notifications.length} 条
                          </small>
                        </span>
                        <time>{new Date(group.latestAt).toLocaleString()}</time>
                        {group.unreadCount ? <b>{group.unreadCount}</b> : null}
                      </button>
                      <div className="notification-group-actions">
                        <button
                          type="button"
                          title={group.unreadCount ? '整组标为已读' : '整组标为未读'}
                          aria-label={group.unreadCount ? '整组标为已读' : '整组标为未读'}
                          onClick={() =>
                            void mutateGroup(group, { read: Boolean(group.unreadCount) })
                          }
                        >
                          {group.unreadCount ? <Check size={13} /> : <Circle size={13} />}
                        </button>
                        <button
                          type="button"
                          title={view === 'archived' ? '整组移回收件箱' : '整组归档'}
                          aria-label={view === 'archived' ? '整组移回收件箱' : '整组归档'}
                          onClick={() => void mutateGroup(group, { archived: view !== 'archived' })}
                        >
                          <Archive size={13} />
                        </button>
                      </div>
                    </header>
                    {!collapsed ? (
                      <div className="notification-group-items">
                        {group.notifications.map((notification) => (
                          <article
                            className={notification.readAt ? '' : 'unread'}
                            key={notification.id}
                          >
                            <button
                              className="notification-open"
                              type="button"
                              onClick={() => void openNotification(notification)}
                            >
                              <span>
                                <NotificationIcon notification={notification} />
                              </span>
                              <div>
                                <strong>{notificationText(notification)}</strong>
                                <p>
                                  {group.threadId
                                    ? '打开评论线程'
                                    : (notification.pageTitle ?? '组织通知')}
                                </p>
                                <time>{new Date(notification.createdAt).toLocaleString()}</time>
                              </div>
                            </button>
                            <div className="notification-row-actions">
                              <button
                                type="button"
                                title={notification.readAt ? '标为未读' : '标为已读'}
                                aria-label={notification.readAt ? '标为未读' : '标为已读'}
                                onClick={() =>
                                  void mutateNotification(notification, {
                                    read: !notification.readAt,
                                  })
                                }
                              >
                                {notification.readAt ? <Circle size={13} /> : <Check size={13} />}
                              </button>
                              <button
                                type="button"
                                title={notification.archivedAt ? '移回收件箱' : '归档'}
                                aria-label={notification.archivedAt ? '移回收件箱' : '归档'}
                                onClick={() =>
                                  void mutateNotification(notification, {
                                    archived: !notification.archivedAt,
                                  })
                                }
                              >
                                <Archive size={13} />
                              </button>
                            </div>
                          </article>
                        ))}
                        {group.threadId && view !== 'archived' ? (
                          replyingGroupKey === group.key ? (
                            <form
                              className="notification-inline-reply"
                              onSubmit={(event) => void replyFromInbox(event, group)}
                            >
                              <textarea
                                autoFocus
                                value={replyBody}
                                maxLength={5_000}
                                placeholder="直接回复这个评论线程…"
                                onChange={(event) => setReplyBody(event.target.value)}
                                disabled={busy}
                              />
                              <div>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setReplyingGroupKey(null);
                                    setReplyBody('');
                                  }}
                                >
                                  取消
                                </button>
                                <button type="submit" disabled={busy || !replyBody.trim()}>
                                  <Send size={13} /> {busy ? '发送中…' : '回复'}
                                </button>
                              </div>
                            </form>
                          ) : (
                            <button
                              className="notification-reply-trigger"
                              type="button"
                              onClick={() => {
                                setReplyingGroupKey(group.key);
                                setReplyBody('');
                              }}
                            >
                              <MessageSquare size={13} /> 直接回复
                            </button>
                          )
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <div className="notification-empty">
                <Bell size={20} />
                {view === 'archived'
                  ? '没有已归档通知'
                  : view === 'unread'
                    ? '没有未读通知'
                    : '收件箱是空的'}
              </div>
            )}
          </div>
          {error ? (
            <p className="notification-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function PageNotificationControl({ pageId }: { pageId: string }) {
  const [settings, setSettings] = useState<PageNotificationSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || settings) return;
    getPageNotificationSettings(pageId)
      .then(({ settings: value }) => setSettings(value))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : '无法加载页面通知设置'),
      );
  }, [open, pageId, settings]);

  const choose = async (mode: PageNotificationMode) => {
    setBusy(true);
    setError(null);
    try {
      const result = await setPageNotificationSettings(pageId, mode);
      setSettings(result.settings);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存页面通知设置');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-notification-control">
      <button
        className="icon-button subtle"
        type="button"
        aria-label="页面通知设置"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setError(null);
        }}
      >
        {settings?.mode === 'all_updates' ? <BellRing size={17} /> : <Bell size={17} />}
      </button>
      {open ? (
        <section className="page-notification-popover">
          <header>
            <strong>通知我</strong>
            <span>选择这个页面的提醒级别</span>
          </header>
          {PAGE_NOTIFICATION_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.mode}
              disabled={busy}
              className={settings?.mode === option.mode ? 'active' : ''}
              onClick={() => void choose(option.mode)}
            >
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {settings?.mode === option.mode ? <Check size={15} /> : null}
            </button>
          ))}
          {error ? (
            <p className="notification-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

const REMINDER_LEAD_OPTIONS = [
  { minutes: 0, label: '到点提醒' },
  { minutes: 5, label: '提前 5 分钟' },
  { minutes: 15, label: '提前 15 分钟' },
  { minutes: 30, label: '提前 30 分钟' },
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 1_440, label: '提前 1 天' },
] as const;

function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function PageReminderControl({
  pageId,
  actorId,
  canCreate,
}: {
  pageId: string;
  actorId: string;
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reminders, setReminders] = useState<PageReminderSummary[]>([]);
  const [recipients, setRecipients] = useState<AuthUserSummary[]>([]);
  const [recipientId, setRecipientId] = useState(actorId);
  const [message, setMessage] = useState('查看这个页面');
  const [dueLocal, setDueLocal] = useState(() => localDateTimeValue(Date.now() + 60 * 60_000));
  const [leadMinutes, setLeadMinutes] = useState(0);
  const [editingReminderId, setEditingReminderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const reminderResult = await listPageReminders(pageId);
      setReminders(reminderResult.reminders);
      const eligible = canCreate ? reminderResult.recipients : [];
      setRecipients(eligible);
      setRecipientId((current) =>
        eligible.some((member) => member.id === current)
          ? current
          : (eligible.find((member) => member.id === actorId)?.id ?? eligible[0]?.id ?? ''),
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载页面提醒');
    } finally {
      setLoading(false);
    }
  }, [actorId, canCreate, pageId]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const dueAt = new Date(dueLocal).getTime();
    if (!Number.isFinite(dueAt) || !recipientId || !message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const reminderInput = {
        recipientId,
        message: message.trim(),
        dueAt,
        remindAt: dueAt - leadMinutes * 60_000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };
      const result = editingReminderId
        ? await updatePageReminder(editingReminderId, reminderInput)
        : await createPageReminder(pageId, reminderInput);
      setReminders(result.reminders);
      setEditingReminderId(null);
      setMessage('查看这个页面');
      setDueLocal(localDateTimeValue(Date.now() + 60 * 60_000));
      setLeadMinutes(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建提醒');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (reminderId: string) => {
    setBusy(true);
    setError(null);
    try {
      await cancelPageReminder(reminderId);
      setReminders((current) => current.filter((reminder) => reminder.id !== reminderId));
      if (editingReminderId === reminderId) setEditingReminderId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法取消提醒');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-reminder-control">
      <button
        className="icon-button subtle"
        type="button"
        aria-label="页面提醒"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setError(null);
        }}
      >
        <CalendarClock size={17} />
        {reminders.length ? <b>{reminders.length > 9 ? '9+' : reminders.length}</b> : null}
      </button>
      {open ? (
        <section className="page-reminder-popover">
          <header>
            <span>
              <strong>页面提醒</strong>
              <small>到点进入收件箱；可提醒有权查看此页的正式成员</small>
            </span>
          </header>
          {canCreate ? (
            <form className="page-reminder-form" onSubmit={(event) => void submit(event)}>
              <label>
                提醒谁
                <select
                  value={recipientId}
                  onChange={(event) => setRecipientId(event.target.value)}
                  disabled={busy || loading}
                >
                  {recipients.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName} {member.id === actorId ? '（我）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                内容
                <input
                  value={message}
                  maxLength={500}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={busy}
                />
              </label>
              <div>
                <label>
                  日期和时间
                  <input
                    type="datetime-local"
                    value={dueLocal}
                    min={localDateTimeValue(Date.now() + 60_000)}
                    onChange={(event) => setDueLocal(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  提前量
                  <select
                    value={leadMinutes}
                    onChange={(event) => setLeadMinutes(Number(event.target.value))}
                    disabled={busy}
                  >
                    {REMINDER_LEAD_OPTIONS.map((option) => (
                      <option key={option.minutes} value={option.minutes}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="page-reminder-submit">
                {editingReminderId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingReminderId(null);
                      setMessage('查看这个页面');
                      setRecipientId(actorId);
                      setDueLocal(localDateTimeValue(Date.now() + 60 * 60_000));
                      setLeadMinutes(0);
                    }}
                  >
                    取消修改
                  </button>
                ) : null}
                <button type="submit" disabled={busy || loading || !recipientId || !message.trim()}>
                  <CalendarClock size={14} />{' '}
                  {busy ? '保存中…' : editingReminderId ? '保存修改' : '创建提醒'}
                </button>
              </div>
            </form>
          ) : null}
          <div className="page-reminder-list">
            {loading ? <p>正在加载…</p> : null}
            {!loading && !reminders.length ? <p>没有待触发提醒</p> : null}
            {reminders.map((reminder) => (
              <article key={reminder.id}>
                <span className="page-reminder-avatar">
                  {reminder.recipient.displayName.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{reminder.message}</strong>
                  <small>
                    {reminder.recipient.displayName} ·{' '}
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: reminder.timezone,
                    }).format(reminder.dueAt)}
                  </small>
                </div>
                <span className="page-reminder-row-actions">
                  {reminder.createdBy === actorId && canCreate ? (
                    <button
                      type="button"
                      aria-label="修改提醒"
                      title="修改提醒"
                      disabled={busy}
                      onClick={() => {
                        setEditingReminderId(reminder.id);
                        setRecipientId(reminder.recipient.id);
                        setMessage(reminder.message);
                        setDueLocal(localDateTimeValue(reminder.dueAt));
                        setLeadMinutes(
                          Math.max(0, Math.round((reminder.dueAt - reminder.remindAt) / 60_000)),
                        );
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="取消提醒"
                    title="取消提醒"
                    disabled={busy}
                    onClick={() => void cancel(reminder.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </article>
            ))}
          </div>
          {error ? (
            <p className="notification-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
