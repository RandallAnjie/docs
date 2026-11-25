import {
  Activity,
  Bell,
  Check,
  Clipboard,
  MailPlus,
  Plug,
  Shield,
  Trash2,
  UserRoundCog,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  InvitationSummary,
  OrganizationAssignableRole,
  OrganizationMemberSummary,
  OrganizationRole,
  OrganizationSummary,
} from '@rdocs/shared';

import {
  createInvitation,
  listInvitations,
  listOrganizationMembers,
  removeOrganizationMember,
  revokeInvitation,
  transferOrganizationOwnership,
  updateOrganizationMember,
} from './api';
import { confirmDialog } from './dialogs';
import { GroupSettings } from './GroupSettings';
import { OrganizationActivity } from './OrganizationActivity';
import { PlatformSettings } from './PlatformSettings';
import { WorkspaceExtras } from './WorkspaceExtras';

const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  guest: '外部只读（历史）',
};

type SettingsSection = 'members' | 'groups' | 'activity' | 'account' | 'platform';

const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}> = [
  { id: 'members', label: '成员与邀请', icon: Users },
  { id: 'groups', label: '用户组', icon: UsersRound },
  { id: 'activity', label: '活动日志', icon: Activity, adminOnly: true },
  { id: 'account', label: '通知与扩展', icon: Bell },
  { id: 'platform', label: '集成与平台', icon: Plug },
];

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function invitationState(invitation: InvitationSummary): string {
  if (invitation.acceptedAt) return '已接受';
  if (invitation.revokedAt) return '已撤销';
  if (invitation.expiresAt <= Date.now()) return '已过期';
  return '待接受';
}

export function OrganizationSettings({
  organization,
  currentUserId,
  onOrganizationChanged,
}: {
  organization: OrganizationSummary;
  currentUserId: string;
  onOrganizationChanged: (organization: OrganizationSummary) => void;
}) {
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationAssignableRole>('member');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>('members');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = organization.role === 'owner' || organization.role === 'admin';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [memberResult, invitationResult] = await Promise.all([
        listOrganizationMembers(organization.id),
        canManage ? listInvitations(organization.id) : Promise.resolve({ invitations: [] }),
      ]);
      setMembers(memberResult.members);
      setInvitations(invitationResult.invitations);
    } catch (reason) {
      setError(errorMessage(reason, '无法加载组织成员'));
    } finally {
      setLoading(false);
    }
  }, [canManage, organization.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingInvitations = useMemo(
    () => invitations.filter((invitation) => invitationState(invitation) === '待接受'),
    [invitations],
  );

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (busyId) return;
    setBusyId('invite');
    setError(null);
    try {
      const result = await createInvitation(organization.id, { email, role });
      setInvitations((current) => [
        result.invitation,
        ...current.filter((candidate) => candidate.id !== result.invitation.id),
      ]);
      setInviteUrl(`${window.location.origin}/invite/${encodeURIComponent(result.token)}`);
      setEmail('');
    } catch (reason) {
      setError(errorMessage(reason, '无法创建邀请'));
    } finally {
      setBusyId(null);
    }
  };

  const changeMember = async (
    member: OrganizationMemberSummary,
    input: { role?: OrganizationAssignableRole; status?: 'active' | 'suspended' },
  ) => {
    setBusyId(member.userId);
    setError(null);
    try {
      const result = await updateOrganizationMember(organization.id, member.userId, input);
      setMembers(result.members);
    } catch (reason) {
      setError(errorMessage(reason, '无法更新成员'));
    } finally {
      setBusyId(null);
    }
  };

  const removeMember = async (member: OrganizationMemberSummary) => {
    if (
      !(await confirmDialog({
        title: '移出成员',
        message: `确定将 ${member.displayName} 移出组织吗？`,
        confirmLabel: '移出',
        danger: true,
      }))
    )
      return;
    setBusyId(member.userId);
    setError(null);
    try {
      await removeOrganizationMember(organization.id, member.userId);
      setMembers((current) => current.filter((candidate) => candidate.userId !== member.userId));
    } catch (reason) {
      setError(errorMessage(reason, '无法移出成员'));
    } finally {
      setBusyId(null);
    }
  };

  const transferOwnership = async (member: OrganizationMemberSummary) => {
    if (
      !(await confirmDialog({
        title: '转让所有权',
        message: `确定将组织所有权转让给 ${member.displayName} 吗？此操作不可撤销。`,
        confirmLabel: '转让所有权',
        danger: true,
      }))
    )
      return;
    setBusyId(member.userId);
    setError(null);
    try {
      const result = await transferOrganizationOwnership(organization.id, member.userId);
      onOrganizationChanged(result.organization);
      await load();
    } catch (reason) {
      setError(errorMessage(reason, '无法转让所有权'));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (invitation: InvitationSummary) => {
    setBusyId(invitation.id);
    setError(null);
    try {
      const result = await revokeInvitation(organization.id, invitation.id);
      setInvitations((current) =>
        current.map((candidate) =>
          candidate.id === invitation.id
            ? { ...candidate, revokedAt: result.revokedAt }
            : candidate,
        ),
      );
    } catch (reason) {
      setError(errorMessage(reason, '无法撤销邀请'));
    } finally {
      setBusyId(null);
    }
  };

  const sections = SETTINGS_SECTIONS.filter((candidate) => !candidate.adminOnly || canManage);

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分区">
        <div className="settings-nav-title">
          <strong>{organization.name}</strong>
          <small>工作区设置</small>
        </div>
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? 'page' : undefined}
            className={section === id ? 'active' : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
            {id === 'members' ? <small>{members.length}</small> : null}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === 'members' ? renderMembers() : null}
        {section === 'groups' ? (
          <GroupSettings
            organizationId={organization.id}
            organizationMembers={members}
            canManage={canManage}
          />
        ) : null}
        {section === 'activity' && canManage ? (
          <OrganizationActivity organizationId={organization.id} />
        ) : null}
        {section === 'account' ? (
          <WorkspaceExtras organizationId={organization.id} canManage={canManage} />
        ) : null}
        {section === 'platform' ? (
          <PlatformSettings organizationId={organization.id} canManage={canManage} />
        ) : null}
        {error ? (
          <p className="tenant-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );

  function renderMembers() {
    return (
      <section className="tenant-panel organization-settings">
        <div className="tenant-panel-heading">
          <div>
            <span>成员与邀请</span>
            <small>
              被邀请人用 RandallFlare 账户打开邀请链接即可加入；账户还需在 Rdocs 成员名单内
            </small>
          </div>
          <b>
            <Users size={14} /> {members.length} 人
          </b>
        </div>

        {canManage ? (
          <form className="member-invite-form" onSubmit={(event) => void invite(event)}>
            <label>
              <span>邀请邮箱</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                required
                maxLength={254}
              />
            </label>
            <label>
              <span>组织角色</span>
              <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
                {organization.role === 'owner' ? <option value="admin">管理员</option> : null}
                <option value="member">成员</option>
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={Boolean(busyId)}>
              <MailPlus size={16} /> 创建邀请
            </button>
          </form>
        ) : null}

        {inviteUrl ? (
          <div className="invite-link-result">
            <div>
              <Check size={16} />
              <span>邀请链接已生成，7 天内有效</span>
            </div>
            <code>{inviteUrl}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(inviteUrl);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              }}
            >
              {copied ? <Check size={15} /> : <Clipboard size={15} />}
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="settings-loading">
            <div className="loading-mark" /> 加载成员…
          </div>
        ) : (
          <div className="member-table-wrap">
            <table className="member-table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const protectedMember =
                    member.role === 'owner' || member.userId === currentUserId;
                  return (
                    <tr key={member.userId}>
                      <td>
                        <div className="member-identity">
                          <span>{member.displayName.slice(0, 1).toUpperCase()}</span>
                          <div>
                            <strong>{member.displayName}</strong>
                            <small>{member.email}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {canManage && !protectedMember ? (
                          <select
                            value={member.role}
                            disabled={busyId === member.userId}
                            onChange={(event) =>
                              void changeMember(member, {
                                role: event.target.value as OrganizationAssignableRole,
                              })
                            }
                          >
                            {organization.role === 'owner' ? (
                              <option value="admin">管理员</option>
                            ) : null}
                            <option value="member">成员</option>
                            {member.role === 'guest' ? (
                              <option value="guest" disabled>
                                外部只读（历史）
                              </option>
                            ) : null}
                          </select>
                        ) : (
                          <span className="role-badge">
                            <Shield size={13} /> {ROLE_LABELS[member.role]}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`member-status ${member.status}`}>
                          {member.status === 'active'
                            ? '正常'
                            : member.status === 'suspended'
                              ? '已停用'
                              : '待接受'}
                        </span>
                      </td>
                      <td>
                        {canManage && !protectedMember ? (
                          <div className="member-actions">
                            <button
                              type="button"
                              title={member.status === 'active' ? '停用' : '恢复'}
                              onClick={() =>
                                void changeMember(member, {
                                  status: member.status === 'active' ? 'suspended' : 'active',
                                })
                              }
                              disabled={busyId === member.userId}
                            >
                              <UserRoundCog size={15} />
                            </button>
                            {organization.role === 'owner' ? (
                              <button
                                type="button"
                                title="转让所有权"
                                onClick={() => void transferOwnership(member)}
                                disabled={busyId === member.userId}
                              >
                                <Shield size={15} />
                              </button>
                            ) : null}
                            <button
                              className="danger"
                              type="button"
                              title="移出组织"
                              onClick={() => void removeMember(member)}
                              disabled={busyId === member.userId}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canManage && pendingInvitations.length ? (
          <div className="pending-invitations">
            <h3>
              待接受邀请 <span>{pendingInvitations.length}</span>
            </h3>
            {pendingInvitations.map((invitation) => (
              <div key={invitation.id}>
                <div>
                  <strong>{invitation.email}</strong>
                  <small>
                    {ROLE_LABELS[invitation.organizationRole]} ·{' '}
                    {new Date(invitation.expiresAt).toLocaleString()}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(invitation)}
                  disabled={busyId === invitation.id}
                >
                  撤销
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    );
  }
}
