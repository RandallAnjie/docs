import { Plus, Trash2, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { GroupSummary, OrganizationMemberSummary } from '@rdocs/shared';

import { createGroup, deleteGroup, listGroupMembers, listGroups, setGroupMember } from './api';
import { confirmDialog } from './dialogs';

export function GroupSettings({
  organizationId,
  organizationMembers,
  canManage,
}: {
  organizationId: string;
  organizationMembers: OrganizationMemberSummary[];
  canManage: boolean;
}) {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [name, setName] = useState('');
  const [memberId, setMemberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      const result = await listGroups(organizationId);
      setGroups(result.groups);
      setSelectedId((current) =>
        result.groups.some((group) => group.id === current)
          ? current
          : (result.groups[0]?.id ?? null),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载用户组');
    }
  }, [organizationId]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (!selectedId) {
      setMembers([]);
      return;
    }
    let active = true;
    listGroupMembers(organizationId, selectedId)
      .then((result) => active && setMembers(result.members))
      .catch(
        (reason) => active && setError(reason instanceof Error ? reason.message : '无法加载组成员'),
      );
    return () => {
      active = false;
    };
  }, [organizationId, selectedId]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createGroup(organizationId, { name });
      setGroups((current) => [...current, result.group]);
      setSelectedId(result.group.id);
      setName('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建用户组');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!selectedId || !memberId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setGroupMember(organizationId, selectedId, memberId, true);
      setMembers(result.members);
      setMemberId('');
      setGroups((current) =>
        current.map((group) =>
          group.id === selectedId ? { ...group, memberCount: result.members.length } : group,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法添加组成员');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      const result = await setGroupMember(organizationId, selectedId, userId, false);
      setMembers(result.members);
      setGroups((current) =>
        current.map((group) =>
          group.id === selectedId ? { ...group, memberCount: result.members.length } : group,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法移除组成员');
    } finally {
      setBusy(false);
    }
  };

  const removeGroup = async () => {
    if (!selectedId || busy) return;
    if (
      !(await confirmDialog({
        title: '删除用户组',
        message: '删除此用户组及它的所有授权？',
        confirmLabel: '删除用户组',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await deleteGroup(organizationId, selectedId);
      await loadGroups();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除用户组');
    } finally {
      setBusy(false);
    }
  };

  const selected = groups.find((group) => group.id === selectedId);
  const memberIds = new Set(members.map((member) => member.userId));
  return (
    <div className="group-settings">
      <div className="group-settings-heading">
        <div>
          <UsersRound size={17} />
          <span>
            <strong>用户组</strong>
            <small>用一个组统一管理空间和页面权限</small>
          </span>
        </div>
        <b>{groups.length}</b>
      </div>
      <div className="group-settings-grid">
        <aside>
          {groups.map((group) => (
            <button
              className={group.id === selectedId ? 'active' : ''}
              type="button"
              key={group.id}
              onClick={() => setSelectedId(group.id)}
            >
              <span>{group.name}</span>
              <b>{group.memberCount}</b>
            </button>
          ))}
          {canManage ? (
            <form onSubmit={(event) => void create(event)}>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="新组名称"
                maxLength={100}
                required
              />
              <button type="submit" disabled={busy}>
                <Plus size={14} />
              </button>
            </form>
          ) : null}
        </aside>
        <section>
          {selected ? (
            <>
              <header>
                <div>
                  <strong>{selected.name}</strong>
                  <span>{members.length} 位成员</span>
                </div>
                {canManage ? (
                  <button type="button" title="删除用户组" onClick={() => void removeGroup()}>
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </header>
              {canManage ? (
                <div className="group-add-member">
                  <select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
                    <option value="">选择组织成员…</option>
                    {organizationMembers
                      .filter(
                        (member) =>
                          member.status === 'active' &&
                          member.role !== 'guest' &&
                          !memberIds.has(member.userId),
                      )
                      .map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                  </select>
                  <button type="button" onClick={() => void add()} disabled={!memberId || busy}>
                    <UserPlus size={14} /> 添加
                  </button>
                </div>
              ) : null}
              <div className="group-member-list">
                {members.length ? (
                  members.map((member) => (
                    <div key={member.userId}>
                      <span>{member.displayName.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <strong>{member.displayName}</strong>
                        <small>{member.email}</small>
                      </div>
                      {canManage ? (
                        <button
                          type="button"
                          title="移出用户组"
                          onClick={() => void remove(member.userId)}
                          disabled={busy}
                        >
                          <UserMinus size={14} />
                        </button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p>还没有组成员</p>
                )}
              </div>
            </>
          ) : (
            <div className="tenant-empty">
              <UsersRound size={22} />
              <strong>创建第一个用户组</strong>
            </div>
          )}
        </section>
      </div>
      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
