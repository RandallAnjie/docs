import { Check, ChevronDown, Link2, LogOut, Plus, Settings, Users, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { OrganizationSummary, SpaceSummary } from '@rdocs/shared';

import { acceptInvitation, createOrganization } from './api';
import type { LocalIdentity } from './identity';

export function firstCharacter(value: string, fallback = '用'): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? fallback;
}

function invitationToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed, window.location.origin);
    const match = url.pathname.match(/^\/invite\/([^/]+)\/?$/);
    return match?.[1] ? decodeURIComponent(match[1]) : trimmed;
  } catch {
    return trimmed;
  }
}

export function WorkspaceSwitcher({
  organizations,
  activeOrganizationId,
  identity,
  collapsed = false,
  onSelect,
  onCreated,
  onJoined,
  onOpenSettings,
  onLogout,
}: {
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  identity: LocalIdentity;
  collapsed?: boolean;
  onSelect: (organizationId: string) => void;
  onCreated: (result: { organization: OrganizationSummary; space: SpaceSummary }) => void;
  onJoined: (organization: OrganizationSummary) => void;
  onOpenSettings?: () => void;
  onLogout?: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [organizationName, setOrganizationName] = useState('');
  const [invitation, setInvitation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const activeOrganization = organizations.find(
    (organization) => organization.id === activeOrganizationId,
  );

  useEffect(() => {
    if (!menuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const openDialog = (nextDialog: 'create' | 'join') => {
    setMenuOpen(false);
    setError(null);
    setDialog(nextDialog);
  };

  const submitOrganization = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createOrganization({ name: organizationName.trim() });
      window.localStorage.setItem('rdocs:selected-organization', result.organization.id);
      onCreated(result);
      setOrganizationName('');
      setDialog(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建工作区');
    } finally {
      setBusy(false);
    }
  };

  const submitInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const token = invitationToken(invitation);
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInvitation(token);
      window.localStorage.setItem('rdocs:selected-organization', result.organization.id);
      onJoined(result.organization);
      setInvitation('');
      setDialog(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加入工作区');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="workspace-switcher-root" ref={root}>
        <button
          className={`workspace-switcher ${collapsed ? 'collapsed' : ''}`}
          type="button"
          aria-label="切换工作区"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="workspace-avatar">
            {firstCharacter(activeOrganization?.name ?? 'Rdocs', 'R')}
          </span>
          {!collapsed ? (
            <>
              <span className="workspace-switcher-copy">
                <strong>{activeOrganization?.name ?? 'Rdocs'}</strong>
                <small>{activeOrganization ? '工作区' : '选择工作区'}</small>
              </span>
              <ChevronDown size={14} />
            </>
          ) : null}
        </button>

        {menuOpen ? (
          <div className={`workspace-menu ${collapsed ? 'from-collapsed' : ''}`} role="menu">
            <div className="workspace-account">
              <span style={{ background: identity.color }}>{firstCharacter(identity.name)}</span>
              <div>
                <strong>{identity.name}</strong>
                <small>设备密钥账户</small>
              </div>
            </div>
            <p>工作区</p>
            <div className="workspace-menu-list">
              {organizations.map((organization) => (
                <button
                  key={organization.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={organization.id === activeOrganizationId}
                  onClick={() => {
                    window.localStorage.setItem('rdocs:selected-organization', organization.id);
                    setMenuOpen(false);
                    onSelect(organization.id);
                  }}
                >
                  <span>{firstCharacter(organization.name)}</span>
                  <div>
                    <strong>{organization.name}</strong>
                    <small>{organization.role === 'owner' ? '所有者' : '成员'}</small>
                  </div>
                  {organization.id === activeOrganizationId ? <Check size={15} /> : null}
                </button>
              ))}
            </div>
            <div className="workspace-menu-actions">
              <button type="button" role="menuitem" onClick={() => openDialog('create')}>
                <Plus size={16} />
                创建工作区
              </button>
              <button type="button" role="menuitem" onClick={() => openDialog('join')}>
                <Link2 size={16} />
                加入工作区
              </button>
              {onOpenSettings && activeOrganization ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings();
                  }}
                >
                  <Settings size={16} />
                  设置与成员
                </button>
              ) : null}
              {onLogout ? (
                <button type="button" role="menuitem" onClick={() => void onLogout()}>
                  <LogOut size={16} />
                  退出登录
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {dialog ? (
        <div className="dialog-backdrop workspace-dialog-backdrop" role="presentation">
          <form
            className="rdocs-dialog workspace-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={dialog === 'create' ? '创建工作区' : '加入工作区'}
            onSubmit={(event) =>
              void (dialog === 'create' ? submitOrganization(event) : submitInvitation(event))
            }
          >
            <button
              className="dialog-close-button"
              type="button"
              aria-label="关闭"
              onClick={() => setDialog(null)}
            >
              <X size={17} />
            </button>
            <div className="dialog-icon">{dialog === 'create' ? <Plus /> : <Users />}</div>
            <h2>{dialog === 'create' ? '创建一个工作区' : '加入其他工作区'}</h2>
            <p>
              {dialog === 'create'
                ? '工作区用来集中管理团队、页面和权限。'
                : '粘贴管理员发给你的邀请链接或邀请码。'}
            </p>
            <label>
              {dialog === 'create' ? '工作区名称' : '邀请链接或邀请码'}
              <input
                autoFocus
                required
                maxLength={dialog === 'create' ? 100 : 500}
                value={dialog === 'create' ? organizationName : invitation}
                placeholder={dialog === 'create' ? '例如：Randall 团队' : 'https://docs…/invite/…'}
                onChange={(event) =>
                  dialog === 'create'
                    ? setOrganizationName(event.target.value)
                    : setInvitation(event.target.value)
                }
              />
            </label>
            {error ? (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" onClick={() => setDialog(null)} disabled={busy}>
                取消
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? '正在处理…' : dialog === 'create' ? '创建工作区' : '加入工作区'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
