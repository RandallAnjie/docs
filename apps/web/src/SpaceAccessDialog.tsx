import { Archive, Building2, LockKeyhole, Trash2, UserPlus, UsersRound, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  GroupSummary,
  OrganizationMemberSummary,
  SpaceGrantPrincipalType,
  SpaceGrantRole,
  SpaceGrantSummary,
  SpaceSummary,
} from '@rdocs/shared';

import {
  deleteSpaceGrant,
  listGroups,
  listOrganizationMembers,
  listSpaceGrants,
  putSpaceGrant,
  updateSpace,
} from './api';
import { confirmDialog } from './dialogs';
import { SpaceIcon } from './space-icon';

type Principal = { type: SpaceGrantPrincipalType; id: string };

function parsePrincipal(value: string): Principal | null {
  const separator = value.indexOf(':');
  if (separator < 1) return null;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return (type === 'organization' || type === 'group' || type === 'user') && id
    ? { type, id }
    : null;
}

export function SpaceAccessDialog({
  space,
  onClose,
  onUpdated,
}: {
  space: SpaceSummary;
  onClose: () => void;
  onUpdated: (space: SpaceSummary) => void;
}) {
  const [grants, setGrants] = useState<SpaceGrantSummary[]>([]);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState<SpaceGrantRole>('viewer');
  const [name, setName] = useState(space.name);
  const [icon, setIcon] = useState(space.icon ?? '');
  const [visibility, setVisibility] = useState(space.visibility);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      listSpaceGrants(space.id),
      listOrganizationMembers(space.organizationId),
      listGroups(space.organizationId),
    ])
      .then(([grantResult, memberResult, groupResult]) => {
        if (!active) return;
        setGrants(grantResult.grants);
        setMembers(memberResult.members.filter((member) => member.status === 'active'));
        setGroups(groupResult.groups);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '无法加载空间权限');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [space.id, space.organizationId]);

  const granted = useMemo(
    () => new Set(grants.map((grant) => `${grant.principalType}:${grant.principalId}`)),
    [grants],
  );
  const memberById = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const selectedPrincipal = parsePrincipal(principal);
  const selectedGuest = Boolean(
    selectedPrincipal?.type === 'user' && memberById.get(selectedPrincipal.id)?.role === 'guest',
  );

  const addGrant = async (event: FormEvent) => {
    event.preventDefault();
    const selected = parsePrincipal(principal);
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await putSpaceGrant(space.id, selected.type, selected.id, role);
      setGrants(result.grants);
      setPrincipal('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法添加空间权限');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await updateSpace(space.id, { name, icon, visibility });
      setGrants((await listSpaceGrants(space.id)).grants);
      onUpdated(result.space);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存空间设置');
    } finally {
      setBusy(false);
    }
  };

  const archiveSpace = async () => {
    if (busy) return;
    if (
      !(await confirmDialog({
        title: '归档空间',
        message: `归档“${space.name}”？页面会停止对普通成员开放，可随时恢复。`,
        confirmLabel: '归档',
        danger: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await updateSpace(space.id, { archived: true });
      onUpdated(result.space);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法归档空间');
    } finally {
      setBusy(false);
    }
  };

  const removeGrant = async (grant: SpaceGrantSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSpaceGrant(space.id, grant.principalType, grant.principalId);
      setGrants((current) => current.filter((candidate) => candidate.id !== grant.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法移除空间权限');
    } finally {
      setBusy(false);
    }
  };

  const changeGrant = async (grant: SpaceGrantSummary, nextRole: SpaceGrantRole) => {
    const member = grant.principalType === 'user' ? memberById.get(grant.principalId) : undefined;
    const effectiveCurrentRole =
      member?.role === 'guest' && grant.role !== 'none' ? 'viewer' : grant.role;
    if (busy || nextRole === effectiveCurrentRole) return;
    setBusy(true);
    setError(null);
    try {
      const result = await putSpaceGrant(
        space.id,
        grant.principalType,
        grant.principalId,
        nextRole,
      );
      setGrants(result.grants);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新空间权限');
    } finally {
      setBusy(false);
    }
  };

  const principalLabel = (grant: SpaceGrantSummary) => {
    if (grant.principalType === 'organization')
      return space.visibility === 'organization' ? '整个组织（显式授权）' : '整个组织';
    if (grant.principalType === 'group')
      return groupById.get(grant.principalId)?.name ?? grant.principalId;
    return memberById.get(grant.principalId)?.displayName ?? grant.principalId;
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="rdocs-dialog page-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-access-title"
      >
        <button className="dialog-close" type="button" onClick={onClose} aria-label="关闭">
          <X size={17} />
        </button>
        <div className="dialog-icon">
          <LockKeyhole size={19} />
        </div>
        <h2 id="space-access-title">{space.name} · 空间权限</h2>
        <p>
          {space.visibility === 'organization'
            ? '正式组织成员默认只读；用户、用户组或整个组织的显式权限可以覆盖默认值。'
            : '仅下方明确授权的成员、用户组或整个组织可以进入此空间。组织所有者始终可管理。'}
        </p>
        <p>
          “无权限”是显式拒绝；移除授权则恢复继承。历史外部只读成员只能被单独授予只读，不能编辑。
        </p>

        <form className="space-settings-form" onSubmit={(event) => void saveSettings(event)}>
          <label>
            <span>空间名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </label>
          <label>
            <span>图标</span>
            <span className="space-icon-field">
              <span className="space-icon-preview">
                <SpaceIcon icon={icon} size={16} />
              </span>
              <input
                value={icon}
                onChange={(event) => setIcon(event.target.value)}
                maxLength={40}
                placeholder="📚 或 book-open"
              />
            </span>
          </label>
          <label>
            <span>可见性</span>
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as SpaceSummary['visibility'])}
            >
              <option value="organization">组织成员可查看</option>
              <option value="restricted">仅显式授权</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>
            保存设置
          </button>
        </form>

        {loading ? (
          <div className="settings-loading">
            <div className="loading-mark" /> 正在读取权限…
          </div>
        ) : (
          <>
            <form className="page-grant-form" onSubmit={(event) => void addGrant(event)}>
              <select
                aria-label="授权成员或用户组"
                value={principal}
                onChange={(event) => {
                  const nextPrincipal = event.target.value;
                  const parsed = parsePrincipal(nextPrincipal);
                  setPrincipal(nextPrincipal);
                  if (parsed?.type === 'user' && memberById.get(parsed.id)?.role === 'guest') {
                    setRole('viewer');
                  }
                }}
                required
              >
                <option value="">选择成员或用户组…</option>
                {!granted.has(`organization:${space.organizationId}`) ? (
                  <option value={`organization:${space.organizationId}`}>整个组织</option>
                ) : null}
                {groups.length ? (
                  <optgroup label="用户组">
                    {groups
                      .filter((group) => !granted.has(`group:${group.id}`))
                      .map((group) => (
                        <option key={group.id} value={`group:${group.id}`}>
                          {group.name} · {group.memberCount} 人
                        </option>
                      ))}
                  </optgroup>
                ) : null}
                <optgroup label="成员">
                  {members
                    .filter((member) => !granted.has(`user:${member.userId}`))
                    .map((member) => (
                      <option key={member.userId} value={`user:${member.userId}`}>
                        {member.displayName} · {member.email}
                      </option>
                    ))}
                </optgroup>
              </select>
              <select
                aria-label="空间权限"
                value={role}
                onChange={(event) => setRole(event.target.value as SpaceGrantRole)}
              >
                <option value="none">无权限</option>
                <option value="viewer">只读</option>
                {!selectedGuest ? <option value="editor">读写</option> : null}
                {!selectedGuest ? <option value="space_admin">管理员</option> : null}
              </select>
              <button type="submit" disabled={busy}>
                <UserPlus size={15} /> 添加
              </button>
            </form>
            <div className="page-grant-list">
              {grants.length ? (
                grants.map((grant) => {
                  const member =
                    grant.principalType === 'user' ? memberById.get(grant.principalId) : undefined;
                  const guestReadOnly = member?.role === 'guest';
                  const effectiveRole =
                    guestReadOnly && grant.role !== 'none' ? 'viewer' : grant.role;
                  const label = principalLabel(grant);
                  return (
                    <div key={grant.id}>
                      <span>
                        {grant.principalType === 'organization' ? (
                          <Building2 size={14} />
                        ) : grant.principalType === 'group' ? (
                          <UsersRound size={14} />
                        ) : (
                          label.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <div>
                        <strong>{label}</strong>
                        <small>
                          {grant.principalType === 'organization'
                            ? '组织'
                            : grant.principalType === 'group'
                              ? '用户组'
                              : (memberById.get(grant.principalId)?.email ?? '成员')}
                        </small>
                      </div>
                      <select
                        aria-label={`${label} 的空间权限`}
                        value={effectiveRole}
                        onChange={(event) =>
                          void changeGrant(grant, event.target.value as SpaceGrantRole)
                        }
                        disabled={busy}
                      >
                        <option value="none">无权限</option>
                        <option value="viewer">只读</option>
                        {!guestReadOnly ? <option value="editor">读写</option> : null}
                        {!guestReadOnly ? <option value="space_admin">管理员</option> : null}
                        {!guestReadOnly && grant.role === 'commenter' ? (
                          <option value="commenter">只读（可评论）</option>
                        ) : null}
                      </select>
                      <button
                        type="button"
                        aria-label="移除权限"
                        onClick={() => void removeGrant(grant)}
                        disabled={busy}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })
              ) : (
                <div className="no-page-grants">还没有显式授权。</div>
              )}
            </div>
          </>
        )}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="space-archive-action">
          <button type="button" onClick={() => void archiveSpace()} disabled={busy}>
            <Archive size={14} /> 归档空间
          </button>
          <small>归档不会删除页面；空间管理员可以从首页恢复。</small>
        </div>
      </section>
    </div>
  );
}
