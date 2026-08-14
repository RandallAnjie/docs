import { Activity, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { AuditEventSummary } from '@rdocs/shared';

import { listOrganizationActivity } from './api';

const EVENT_LABELS: Record<string, string> = {
  'organization.created': '创建了组织',
  'organization.updated': '更新了组织设置',
  'organization.ownership.transferred': '转让了组织所有权',
  'invitation.created': '创建了成员邀请',
  'invitation.revoked': '撤销了成员邀请',
  'invitation.accepted': '接受了组织邀请',
  'member.updated': '更新了成员身份',
  'member.removed': '移除了组织成员',
  'group.created': '创建了用户组',
  'group.updated': '更新了用户组',
  'group.member.added': '添加了用户组成员',
  'group.member.removed': '移除了用户组成员',
  'group.deleted': '删除了用户组',
  'space.created': '创建了空间',
  'space.updated': '更新了空间设置',
  'space.grant.updated': '更新了空间权限',
  'space.grant.removed': '移除了空间权限',
  'page.moved': '移动了页面',
  'page.created': '创建了页面',
  'page.copied': '创建了页面副本',
  'page.title.updated': '更新了页面标题',
  'page.deleted': '将页面移入回收站',
  'page.restored': '恢复了页面',
  'page.markdown.imported': '导入了 Markdown 页面',
  'page.markdown.exported': '导出了 Markdown 页面',
  'page.access.mode.updated': '更新了页面权限模式',
  'page.grant.updated': '更新了页面权限',
  'page.grant.removed': '移除了页面权限',
  'share_link.created': '创建了公开分享链接',
  'share_link.revoked': '撤销了公开分享链接',
  'revision.created': '保存了页面版本',
  'revision.restored': '恢复了页面版本',
  'attachment.created': '上传了附件',
  'attachment.deleted': '移除了附件',
};

function eventDetails(event: AuditEventSummary): string {
  const role = typeof event.metadata.role === 'string' ? event.metadata.role : null;
  const visibility =
    typeof event.metadata.visibility === 'string' ? event.metadata.visibility : null;
  return [event.targetType, role, visibility].filter(Boolean).join(' · ');
}

export function OrganizationActivity({ organizationId }: { organizationId: string }) {
  const [events, setEvents] = useState<AuditEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents((await listOrganizationActivity(organizationId)).events);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载组织活动');
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="organization-activity">
      <header>
        <div>
          <Activity size={17} />
          <span>
            <strong>组织活动</strong>
            <small>最近 100 条权限与管理操作</small>
          </span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} title="刷新">
          <RefreshCw size={14} />
        </button>
      </header>
      {loading ? (
        <div className="settings-loading">
          <div className="loading-mark" /> 加载活动…
        </div>
      ) : events.length ? (
        <div className="organization-activity-list">
          {events.map((event) => (
            <div key={event.id}>
              <span>{event.actor?.displayName.slice(0, 1).toUpperCase() ?? '系'}</span>
              <div>
                <strong>
                  {event.actor?.displayName ?? '系统'}{' '}
                  {EVENT_LABELS[event.eventType] ?? event.eventType}
                </strong>
                <small>
                  {eventDetails(event)} · {new Date(event.createdAt).toLocaleString()}
                </small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="activity-empty">还没有活动记录</p>
      )}
      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
