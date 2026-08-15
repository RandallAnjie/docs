import { Building2, LockKeyhole, Trash2, UserPlus, Users, UsersRound, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  GroupSummary,
  OrganizationMemberSummary,
  PageAccessMode,
  PageGrantRole,
  PageGrantSummary,
  PageSummary,
  SpaceGrantPrincipalType,
} from '@rdocs/shared';

import {
  deletePageGrant,
  getPageAccess,
  listGroups,
  listOrganizationMembers,
  putPageGrant,
  updatePageAccessMode,
} from './api';
import { ShareLinkSettings } from './ShareLinkSettings';
import { SitePublishingSettings } from './SitePublishingSettings';

function parsePrincipal(value: string): { type: SpaceGrantPrincipalType; id: string } | null {
  const separator = value.indexOf(':');
  if (separator < 1) return null;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return (type === 'organization' || type === 'group' || type === 'user') && id
    ? { type, id }
    : null;
}

function failure(reason: unknown): string {
  return reason instanceof Error ? reason.message : '无法更新页面权限';
}

export function PageAccessDialog({ page, onClose }: { page: PageSummary; onClose: () => void }) {
  const [mode, setMode] = useState<PageAccessMode>('inherit');
  const [grants, setGrants] = useState<PageGrantSummary[]>([]);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState<PageGrantRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      getPageAccess(page.id),
      listOrganizationMembers(page.organizationId),
      listGroups(page.organizationId),
    ])
      .then(([access, memberResult, groupResult]) => {
        if (!active) return;
        setMode(access.mode);
        setGrants(access.grants);
        setMembers(memberResult.members.filter((member) => member.status === 'active'));
        setGroups(groupResult.groups);
      })
      .catch((reason) => active && setError(failure(reason)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [page.id, page.organizationId]);

  const memberById = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const alreadyGranted = useMemo(
    () => new Set(grants.map((grant) => `${grant.principalType}:${grant.principalId}`)),
    [grants],
  );
  const selectedPrincipal = parsePrincipal(principal);
  const selectedGuest = Boolean(
    selectedPrincipal?.type === 'user' && memberById.get(selectedPrincipal.id)?.role === 'guest',
  );

  const changeMode = async (nextMode: PageAccessMode) => {
    if (busy || nextMode === mode) return;
    setBusy(true);
    setError(null);
    try {
      const result = await updatePageAccessMode(page.id, nextMode);
      setMode(result.mode);
      setGrants(result.grants);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    const selected = parsePrincipal(principal);
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await putPageGrant(page.id, selected.type, selected.id, role);
      setMode(result.mode);
      setGrants(result.grants);
      setPrincipal('');
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeGrant = async (grant: PageGrantSummary) => {
    setBusy(true);
    setError(null);
    try {
      const result = await deletePageGrant(page.id, grant.principalType, grant.principalId);
      setMode(result.mode);
      setGrants(result.grants);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeGrant = async (grant: PageGrantSummary, nextRole: PageGrantRole) => {
    const member = grant.principalType === 'user' ? memberById.get(grant.principalId) : undefined;
    const effectiveCurrentRole =
      member?.role === 'guest' && grant.role !== 'none' ? 'viewer' : grant.role;
    if (busy || nextRole === effectiveCurrentRole) return;
    setBusy(true);
    setError(null);
    try {
      const result = await putPageGrant(page.id, grant.principalType, grant.principalId, nextRole);
      setMode(result.mode);
      setGrants(result.grants);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="rdocs-dialog page-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-access-title"
      >
        <button className="dialog-close" type="button" onClick={onClose} aria-label="关闭">
          <X size={17} />
        </button>
        <div className="dialog-icon">
          <LockKeyhole size={19} />
        </div>
        <h2 id="page-access-title">页面访问权限</h2>
        <p>限制后，本页及子页面使用独立权限。用户权限优先于用户组和整个组织。</p>
        <p>匿名用户不能进入文档空间；分享链接始终只读。历史外部只读成员不能获得编辑或管理权限。</p>

        {loading ? (
          <div className="settings-loading">
            <div className="loading-mark" /> 正在读取权限…
          </div>
        ) : (
          <>
            <div className="access-mode-picker">
              <button
                className={mode === 'inherit' ? 'active' : ''}
                type="button"
                onClick={() => void changeMode('inherit')}
                disabled={busy}
              >
                <Users size={17} />
                <span>
                  <strong>继承空间</strong>
                  <small>使用空间成员权限</small>
                </span>
              </button>
              <button
                className={mode === 'restricted' ? 'active' : ''}
                type="button"
                onClick={() => void changeMode('restricted')}
                disabled={busy}
              >
                <LockKeyhole size={17} />
                <span>
                  <strong>限制访问</strong>
                  <small>只允许下方成员</small>
                </span>
              </button>
            </div>

            {mode === 'restricted' ? (
              <>
                <form className="page-grant-form" onSubmit={(event) => void addMember(event)}>
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
                    {!alreadyGranted.has(`organization:${page.organizationId}`) ? (
                      <option value={`organization:${page.organizationId}`}>整个组织</option>
                    ) : null}
                    {groups.length ? (
                      <optgroup label="用户组">
                        {groups
                          .filter((group) => !alreadyGranted.has(`group:${group.id}`))
                          .map((group) => (
                            <option key={group.id} value={`group:${group.id}`}>
                              {group.name} · {group.memberCount} 人
                            </option>
                          ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="成员">
                      {members
                        .filter((member) => !alreadyGranted.has(`user:${member.userId}`))
                        .map((member) => (
                          <option key={member.userId} value={`user:${member.userId}`}>
                            {member.displayName} · {member.email}
                          </option>
                        ))}
                    </optgroup>
                  </select>
                  <select
                    aria-label="页面权限"
                    value={role}
                    onChange={(event) => setRole(event.target.value as PageGrantRole)}
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
                      const member = memberById.get(grant.principalId);
                      const group = groupById.get(grant.principalId);
                      const label =
                        grant.principalType === 'organization'
                          ? '整个组织'
                          : grant.principalType === 'group'
                            ? (group?.name ?? grant.principalId)
                            : (member?.displayName ?? grant.principalId);
                      const guestReadOnly = member?.role === 'guest';
                      const effectiveRole =
                        guestReadOnly && grant.role !== 'none' ? 'viewer' : grant.role;
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
                                  ? `${group?.memberCount ?? 0} 位组成员`
                                  : (member?.email ?? '成员')}
                            </small>
                          </div>
                          <select
                            aria-label={`${label} 的页面权限`}
                            value={effectiveRole}
                            onChange={(event) =>
                              void changeGrant(grant, event.target.value as PageGrantRole)
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
                    <div className="no-page-grants">
                      还没有单独授权：所有人均为无权限，空间管理员始终可访问。
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </>
        )}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <ShareLinkSettings pageId={page.id} />
        <SitePublishingSettings pageId={page.id} pageTitle={page.title} />
      </section>
    </div>
  );
}
