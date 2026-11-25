import { Activity, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { AuditEventSummary } from '@rdocs/shared';

import { listOrganizationActivity } from './api';

const EVENT_LABELS: Record<string, string> = {
  'organization.created': '创建了组织',
  'organization.updated': '更新了组织设置',
  'organization.ownership.transferred': '转让了组织所有权',
  'organization.owner.transferred': '转让了组织所有权',
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
  'page.content_updated': '编辑了页面内容',
  'page.appearance.updated': '更新了页面外观',
  'page.deleted': '将页面移入回收站',
  'page.restored': '恢复了页面',
  'page.reminder.created': '设置了页面提醒',
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
  'database.created': '创建了数据库',
  'database.updated': '更新了数据库',
  'database.row.created': '新增了数据库记录',
  'database.row.created_from_template': '从模板新增了数据库记录',
  'database.row.duplicated': '复制了数据库记录',
  'database.row.updated': '更新了数据库记录',
  'database.property.created': '新增了数据库字段',
  'database.property.updated': '更新了数据库字段',
  'database.property.deleted': '删除了数据库字段',
  'database.view.created': '新建了数据库视图',
  'database.view.updated': '更新了数据库视图',
  'database.view.deleted': '删除了数据库视图',
  'database.template.created': '新建了数据库模板',
  'database.template.updated': '更新了数据库模板',
  'database.template.deleted': '删除了数据库模板',
  'database.automation.created': '新建了数据库自动化',
  'database.automation.deleted': '删除了数据库自动化',
  'database.button.executed': '执行了数据库按钮',
  'database.form_link.created': '创建了公开表单链接',
  'database.form_link.revoked': '撤销了公开表单链接',
  'synced_block.created': '创建了同步块',
  'synced_block.orphan_deleted': '删除了同步块',
  'synced_block.restored_all': '恢复了同步块',
  'synced_block.unsynced_all': '取消了同步块关联',
  'site.created': '创建了站点',
  'site.page.updated': '更新了站点页面',
  'site.domain.created': '添加了站点域名',
  'api_token.created': '创建了 API 令牌',
  'api_token.revoked': '撤销了 API 令牌',
  'enterprise.updated': '更新了企业设置',
  'legal_hold.created': '启用了法务保全',
  'export.created': '导出了工作区',
  'project.workspace.created': '创建了项目工作区',
};

const TARGET_LABELS: Record<string, string> = {
  organization: '组织',
  invitation: '邀请',
  member: '成员',
  group: '用户组',
  space: '空间',
  page: '页面',
  share_link: '分享链接',
  revision: '版本',
  attachment: '附件',
  database: '数据库',
  synced_block: '同步块',
  site: '站点',
  api_token: 'API 令牌',
};

const ACTION_LABELS: Record<string, string> = {
  created: '创建了',
  updated: '更新了',
  deleted: '删除了',
  removed: '移除了',
  revoked: '撤销了',
  restored: '恢复了',
};

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  guest: '外部只读',
  space_admin: '空间管理员',
  editor: '可编辑',
  viewer: '只读',
  none: '无权限',
};

const VISIBILITY_LABELS: Record<string, string> = {
  organization: '所有工作区成员',
  restricted: '仅受邀成员',
};

/** Readable text for an audit event, also for event types added after this list. */
export function eventLabel(eventType: string): string {
  const known = EVENT_LABELS[eventType];
  if (known) return known;
  const parts = eventType.split('.');
  const action = ACTION_LABELS[parts[parts.length - 1] ?? ''];
  const target = TARGET_LABELS[parts[0] ?? ''];
  if (action && target) return `${action}${target}`;
  return target ? `操作了${target}` : '执行了操作';
}

function eventDetails(event: AuditEventSummary): string {
  const role = typeof event.metadata.role === 'string' ? event.metadata.role : null;
  const visibility =
    typeof event.metadata.visibility === 'string' ? event.metadata.visibility : null;
  return [
    TARGET_LABELS[event.targetType] ?? null,
    role ? (ROLE_LABELS[role] ?? role) : null,
    visibility ? (VISIBILITY_LABELS[visibility] ?? visibility) : null,
  ]
    .filter(Boolean)
    .join(' · ');
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
                  {event.actor?.displayName ?? '系统'} {eventLabel(event.eventType)}
                </strong>
                <small>
                  {[eventDetails(event), new Date(event.createdAt).toLocaleString()]
                    .filter(Boolean)
                    .join(' · ')}
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
