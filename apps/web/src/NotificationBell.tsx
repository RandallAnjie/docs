import { Bell, CheckCheck, MessageSquare, Shield, UserRoundPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { NotificationSummary } from '@rdocs/shared';

import { listNotifications, markAllNotificationsRead, markNotificationRead } from './api';

function notificationText(notification: NotificationSummary): string {
  const actor = notification.actor?.displayName ?? '系统';
  switch (notification.type) {
    case 'mention':
      return `${actor} 在评论中提及了你`;
    case 'comment_reply':
      return `${actor} 回复了你参与的评论`;
    case 'permission_changed':
      return `${actor} 更新了页面权限`;
    case 'invitation_accepted':
      return `${actor} 接受了组织邀请`;
    default:
      return `${actor} 向你分享了页面`;
  }
}

export function NotificationBell({ organizationId }: { organizationId: string }) {
  const [notifications, setNotifications] = useState<NotificationSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listNotifications(organizationId);
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    } catch (reason) {
      if (open) setError(reason instanceof Error ? reason.message : '无法加载通知');
    }
  }, [open, organizationId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openNotification = async (notification: NotificationSummary) => {
    if (!notification.readAt) {
      await markNotificationRead(notification.id).catch(() => undefined);
      setUnreadCount((current) => Math.max(0, current - 1));
    }
    if (notification.pageId)
      window.location.assign(`/p/${encodeURIComponent(notification.pageId)}`);
  };

  const readAll = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((current) =>
        current.map((notification) => ({ ...notification, readAt: Date.now() })),
      );
      setUnreadCount(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法标记已读');
    }
  };

  return (
    <div className="notification-control">
      <button
        className="icon-button"
        type="button"
        aria-label="通知"
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
              <strong>通知</strong>
              <span>{unreadCount} 条未读</span>
            </div>
            {unreadCount ? (
              <button type="button" onClick={() => void readAll()}>
                <CheckCheck size={14} /> 全部已读
              </button>
            ) : null}
          </header>
          <div className="notification-list">
            {notifications.length ? (
              notifications.map((notification) => (
                <button
                  className={notification.readAt ? '' : 'unread'}
                  type="button"
                  key={notification.id}
                  onClick={() => void openNotification(notification)}
                >
                  <span>
                    {notification.type === 'permission_changed' ? (
                      <Shield size={15} />
                    ) : notification.type === 'invitation_accepted' ? (
                      <UserRoundPlus size={15} />
                    ) : (
                      <MessageSquare size={15} />
                    )}
                  </span>
                  <div>
                    <strong>{notificationText(notification)}</strong>
                    <p>{notification.pageTitle ?? '组织通知'}</p>
                    <time>{new Date(notification.createdAt).toLocaleString()}</time>
                  </div>
                </button>
              ))
            ) : (
              <div className="notification-empty">
                <Bell size={20} />
                还没有通知
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
