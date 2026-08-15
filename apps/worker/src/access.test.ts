import { describe, expect, it } from 'vitest';

import { canManageOrganization, canSpace, effectivePageGrantRole, higherSpaceRole } from './access';

describe('organization and space permissions', () => {
  it('enforces the documented space role matrix', () => {
    expect(canSpace('viewer', 'view')).toBe(true);
    expect(canSpace('viewer', 'comment')).toBe(false);
    expect(canSpace('commenter', 'comment')).toBe(true);
    expect(canSpace('commenter', 'edit_content')).toBe(false);
    expect(canSpace('editor', 'create_revision')).toBe(true);
    expect(canSpace('editor', 'manage_access')).toBe(false);
    expect(canSpace('space_admin', 'manage_access')).toBe(true);
  });

  it('uses the strongest matching grant', () => {
    expect(higherSpaceRole('viewer', 'editor')).toBe('editor');
    expect(higherSpaceRole('space_admin', 'viewer')).toBe('space_admin');
    expect(higherSpaceRole(null, 'commenter')).toBe('commenter');
  });

  it('uses explicit page roles with user overrides and deny support', () => {
    expect(
      effectivePageGrantRole([
        { principalType: 'organization', role: 'viewer' },
        { principalType: 'group', role: 'editor' },
        { principalType: 'user', role: 'space_admin' },
      ]),
    ).toBe('space_admin');
    expect(
      effectivePageGrantRole([
        { principalType: 'organization', role: 'editor' },
        { principalType: 'user', role: 'none' },
      ]),
    ).toBeNull();
    expect(
      effectivePageGrantRole([
        { principalType: 'organization', role: 'viewer' },
        { principalType: 'group', role: 'none' },
      ]),
    ).toBeNull();
  });

  it('keeps organization administration separate from private-space access', () => {
    expect(canManageOrganization('owner', 'delete')).toBe(true);
    expect(canManageOrganization('admin', 'manage_members')).toBe(true);
    expect(canManageOrganization('admin', 'delete')).toBe(false);
    expect(canManageOrganization('member', 'create_space')).toBe(true);
    expect(canManageOrganization('guest', 'create_space')).toBe(false);
  });
});
