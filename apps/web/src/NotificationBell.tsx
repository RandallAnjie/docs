import {
  Archive,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  Circle,
  MessageSquare,
  Shield,
  UserRoundPlus,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type {
  NotificationSummary,
  PageNotificationMode,
  PageNotificationSettings,
} from '@rdocs/shared';

import {
  archiveAllNotifications,
  archiveReadNotifications,
  getPageNotificationSettings,
  listNotificationsView,
  markAllNotificationsRead,
  setPageNotificationSettings,
  updateNotification,
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
    default:
      return `${actor} 向你分享了页面`;
  }
}

function NotificationIcon({ notification }: { notification: NotificationSummary }) {
  if (notification.type === 'permission_changed') return <Shield size={15} />;
  if (notification.type === 'invitation_accepted') return <UserRoundPlus size={15} />;
  if (notification.type === 'page_updated') return <BellRing size={15} />;
  return <MessageSquare size={15} />;
}

export function NotificationBell({ organizationId }: { organizationId: string }) {
  const [notifications, setNotifications] = useState<NotificationSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [view, setView] = useState<NotificationView>('inbox');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listNotificationsView(organizationId, view);
      setNotifications(result.notifications);
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
      window.location.assign(`/p/${encodeURIComponent(notification.pageId)}`);
      return;
    }
    await load();
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
                  disabled={busy || !notifications.length}
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
            {notifications.length ? (
              notifications.map((notification) => (
                <article className={notification.readAt ? '' : 'unread'} key={notification.id}>
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
                      <p>{notification.pageTitle ?? '组织通知'}</p>
                      <time>{new Date(notification.createdAt).toLocaleString()}</time>
                    </div>
                  </button>
                  <div className="notification-row-actions">
                    <button
                      type="button"
                      title={notification.readAt ? '标为未读' : '标为已读'}
                      aria-label={notification.readAt ? '标为未读' : '标为已读'}
                      onClick={() =>
                        void mutateNotification(notification, { read: !notification.readAt })
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
              ))
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
