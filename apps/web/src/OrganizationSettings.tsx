import { Check, Clipboard, MailPlus, Shield, Trash2, UserRoundCog, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  InvitationSummary,
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
import { GroupSettings } from './GroupSettings';
import { OrganizationActivity } from './OrganizationActivity';

const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  guest: '访客',
};

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
  const [role, setRole] = useState<'admin' | 'member' | 'guest'>('member');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
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
    input: { role?: 'admin' | 'member' | 'guest'; status?: 'active' | 'suspended' },
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
    if (!window.confirm(`确定将 ${member.displayName} 移出组织吗？`)) return;
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
    if (!window.confirm(`确定将组织所有权转让给 ${member.displayName} 吗？`)) return;
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

  return (
    <section className="tenant-panel organization-settings">
      <div className="tenant-panel-heading">
        <div>
          <span>成员与设备密钥邀请</span>
          <small>成员从邀请链接登记自己的设备密钥，无需 GitHub OAuth</small>
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
              <option value="guest">访客</option>
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
                const protectedMember = member.role === 'owner' || member.userId === currentUserId;
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
                              role: event.target.value as 'admin' | 'member' | 'guest',
                            })
                          }
                        >
                          {organization.role === 'owner' ? (
                            <option value="admin">管理员</option>
                          ) : null}
                          <option value="member">成员</option>
                          <option value="guest">访客</option>
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

      <GroupSettings
        organizationId={organization.id}
        organizationMembers={members}
        canManage={canManage}
      />
      {canManage ? <OrganizationActivity organizationId={organization.id} /> : null}

      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
