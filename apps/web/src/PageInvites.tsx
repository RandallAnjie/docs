import { UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  OrganizationMemberSummary,
  PageAccessMode,
  PageGrantRole,
  PageGrantSummary,
  PageSummary,
} from '@rdocs/shared';

import { deletePageGrant, getPageAccess, listOrganizationMembers, putPageGrant } from './api';

type InviteRole = Exclude<PageGrantRole, 'none'>;

const INVITE_ROLES: { value: InviteRole; label: string }[] = [
  { value: 'viewer', label: '可查看' },
  { value: 'commenter', label: '可评论' },
  { value: 'editor', label: '可编辑' },
  { value: 'space_admin', label: '完全访问' },
];

export function inviteRoleLabel(role: PageGrantRole): string {
  return INVITE_ROLES.find((option) => option.value === role)?.label ?? '无权限';
}

/** Roles a member may be invited with (guests only read). */
export function inviteRolesFor(member: Pick<OrganizationMemberSummary, 'role'> | undefined) {
  return member?.role === 'guest' ? INVITE_ROLES.slice(0, 1) : INVITE_ROLES;
}

function initial(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}

/**
 * Notion's Share → Invite: give a workspace member access to this page and
 * the pages under it, on top of what they already have.
 */
export function PageInvites({ page, canManage }: { page: PageSummary; canManage: boolean }) {
  const [mode, setMode] = useState<PageAccessMode>('inherit');
  const [grants, setGrants] = useState<PageGrantSummary[]>([]);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    let active = true;
    Promise.all([getPageAccess(page.id), listOrganizationMembers(page.organizationId)])
      .then(([access, list]) => {
        if (!active) return;
        setMode(access.mode);
        setGrants(access.grants);
        setMembers(list.members.filter((member) => member.status === 'active'));
      })
      .catch(
        (reason: unknown) =>
          active && setError(reason instanceof Error ? reason.message : '无法读取协作者'),
      );
    return () => {
      active = false;
    };
  }, [canManage, page.id, page.organizationId]);

  const memberById = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const invites = grants.filter((grant) => grant.invite && grant.principalType === 'user');
  const invited = new Set(invites.map((grant) => grant.principalId));
  const candidates = members.filter((member) => !invited.has(member.userId));
  const selected = memberById.get(memberId);

  if (!canManage) return null;

  const apply = async (
    work: () => Promise<{ grants: PageGrantSummary[]; mode: PageAccessMode }>,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      setGrants(next.grants);
      setMode(next.mode);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新协作者');
    } finally {
      setBusy(false);
    }
  };

  const invite = (event: FormEvent) => {
    event.preventDefault();
    if (!memberId) return;
    const allowed = inviteRolesFor(selected).some((option) => option.value === role);
    void apply(() =>
      putPageGrant(page.id, 'user', memberId, allowed ? role : 'viewer', { invite: true }),
    ).then(() => setMemberId(''));
  };

  return (
    <section className="page-invites" aria-label="邀请协作者">
      <form className="page-invite-form" onSubmit={invite}>
        <select
          aria-label="选择成员"
          value={memberId}
          onChange={(event) => setMemberId(event.target.value)}
        >
          <option value="">添加成员，一起查看或编辑…</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.displayName} · {member.email}
            </option>
          ))}
        </select>
        <select
          aria-label="邀请权限"
          value={role}
          onChange={(event) => setRole(event.target.value as InviteRole)}
        >
          {inviteRolesFor(selected).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="submit" className="primary-button" disabled={busy || !memberId}>
          <UserPlus size={15} /> 邀请
        </button>
      </form>
      <ul className="page-invite-list">
        <li className="page-invite-general">
          <span className="page-invite-avatar is-general">空</span>
          <span>
            <strong>{mode === 'restricted' ? '仅限受邀成员' : '空间成员'}</strong>
            <small>
              {mode === 'restricted'
                ? '此页面已限制访问，只有授权和受邀的成员能打开'
                : '按空间权限访问，受邀成员额外获得下方权限'}
            </small>
          </span>
        </li>
        {invites.map((grant) => {
          const member = memberById.get(grant.principalId);
          const name = member?.displayName ?? '成员';
          return (
            <li key={grant.id}>
              <span className="page-invite-avatar">{initial(name)}</span>
              <span>
                <strong>{name}</strong>
                <small>{member?.email ?? ''}</small>
              </span>
              <select
                aria-label={`${name}的权限`}
                value={grant.role}
                disabled={busy}
                onChange={(event) =>
                  void apply(() =>
                    putPageGrant(
                      page.id,
                      'user',
                      grant.principalId,
                      event.target.value as InviteRole,
                      { invite: true },
                    ),
                  )
                }
              >
                {inviteRolesFor(member).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`移除${name}`}
                title="移除"
                disabled={busy}
                onClick={() =>
                  void apply(() => deletePageGrant(page.id, 'user', grant.principalId))
                }
              >
                <X size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
