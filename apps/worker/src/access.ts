import type {
  OrganizationRole,
  PageGrantRole,
  SpaceGrantPrincipalType,
  SpaceGrantRole,
  SpaceRole,
  SpaceVisibility,
} from '@rdocs/shared';

import type { Env } from './env';

export type SpaceAction =
  | 'view'
  | 'comment'
  | 'edit_content'
  | 'create_child'
  | 'move'
  | 'delete'
  | 'restore'
  | 'create_revision'
  | 'manage_access'
  | 'manage_space'
  | 'download_attachment'
  | 'export';

export interface MembershipContext {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

export interface SpaceAccessContext extends MembershipContext {
  spaceId: string;
  spaceRole: SpaceRole;
}

interface MembershipRow {
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
}

interface SpaceRow {
  id: string;
  organization_id: string;
  visibility: SpaceVisibility;
}

interface GrantRow {
  principal_type: SpaceGrantPrincipalType;
  role: SpaceGrantRole;
}

interface PageGrantAccessRow {
  principal_type: SpaceGrantPrincipalType;
  role: PageGrantRole;
}

interface PageAccessRow {
  page_id: string;
  organization_id: string;
  space_id: string;
}

const SPACE_ROLE_RANK: Record<SpaceRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  space_admin: 4,
};

const SPACE_ACTION_MINIMUM_ROLE: Record<SpaceAction, SpaceRole> = {
  view: 'viewer',
  comment: 'commenter',
  edit_content: 'editor',
  create_child: 'editor',
  move: 'editor',
  delete: 'editor',
  restore: 'editor',
  create_revision: 'editor',
  manage_access: 'space_admin',
  manage_space: 'space_admin',
  download_attachment: 'viewer',
  export: 'viewer',
};

export function higherSpaceRole(
  current: SpaceRole | null,
  candidate: SpaceRole | null,
): SpaceRole | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return SPACE_ROLE_RANK[candidate] > SPACE_ROLE_RANK[current] ? candidate : current;
}

export function canSpace(role: SpaceRole, action: SpaceAction): boolean {
  return SPACE_ROLE_RANK[role] >= SPACE_ROLE_RANK[SPACE_ACTION_MINIMUM_ROLE[action]];
}

export function effectivePageGrantRole(
  grants: ReadonlyArray<{ principalType: SpaceGrantPrincipalType; role: PageGrantRole }>,
): SpaceRole | null {
  const direct = grants.find((grant) => grant.principalType === 'user');
  if (direct) return direct.role === 'none' ? null : direct.role;

  const groups = grants.filter((grant) => grant.principalType === 'group');
  if (groups.some((grant) => grant.role === 'none')) return null;
  let groupRole: SpaceRole | null = null;
  for (const grant of groups) {
    if (grant.role !== 'none') groupRole = higherSpaceRole(groupRole, grant.role);
  }
  if (groupRole) return groupRole;

  const organization = grants.find((grant) => grant.principalType === 'organization');
  return !organization || organization.role === 'none' ? null : organization.role;
}

export function effectiveSpaceGrantRole(
  grants: ReadonlyArray<{ principalType: SpaceGrantPrincipalType; role: SpaceGrantRole }>,
  fallback: SpaceRole | null,
): SpaceRole | null {
  const direct = grants.find((grant) => grant.principalType === 'user');
  if (direct) return direct.role === 'none' ? null : direct.role;

  const groups = grants.filter((grant) => grant.principalType === 'group');
  if (groups.some((grant) => grant.role === 'none')) return null;
  let groupRole: SpaceRole | null = null;
  for (const grant of groups) {
    if (grant.role !== 'none') groupRole = higherSpaceRole(groupRole, grant.role);
  }
  if (groupRole) return groupRole;

  const organization = grants.find((grant) => grant.principalType === 'organization');
  if (organization) return organization.role === 'none' ? null : organization.role;
  return fallback;
}

export function capRoleForMembership(
  organizationRole: OrganizationRole,
  role: SpaceRole | null,
): SpaceRole | null {
  if (!role) return null;
  return organizationRole === 'guest' ? 'viewer' : role;
}

export function canManageOrganization(
  role: OrganizationRole,
  action: 'update' | 'manage_members' | 'create_space' | 'delete',
): boolean {
  if (role === 'owner') return true;
  if (role !== 'admin') return action === 'create_space' && role === 'member';
  return action !== 'delete';
}

export async function findActiveMembership(
  env: Env,
  organizationId: string,
  userId: string,
): Promise<MembershipContext | null> {
  const row = await env.DB.prepare(
    `SELECT organization_id, user_id, role
       FROM organization_members
      WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
  )
    .bind(organizationId, userId)
    .first<MembershipRow>();
  return row
    ? {
        organizationId: row.organization_id,
        userId: row.user_id,
        role: row.role,
      }
    : null;
}

async function resolveSpaceAccessInternal(
  env: Env,
  spaceId: string,
  userId: string,
  includeArchived: boolean,
): Promise<SpaceAccessContext | null> {
  const space = await env.DB.prepare(
    `SELECT id, organization_id, visibility
       FROM spaces
      WHERE id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} AND deleted_at IS NULL`,
  )
    .bind(spaceId)
    .first<SpaceRow>();
  if (!space) return null;

  const membership = await findActiveMembership(env, space.organization_id, userId);
  if (!membership) return null;
  if (membership.role === 'owner') {
    return { ...membership, spaceId: space.id, spaceRole: 'space_admin' };
  }

  const fallback: SpaceRole | null =
    space.visibility === 'organization' && membership.role !== 'guest' ? 'viewer' : null;
  const grants = (
    await env.DB.prepare(
      `SELECT sg.principal_type, sg.role
         FROM space_grants sg
        WHERE sg.organization_id = ? AND sg.space_id = ?
          AND (
            (sg.principal_type = 'user' AND sg.principal_id = ?)
            OR (
              sg.principal_type = 'organization' AND sg.principal_id = ? AND ? <> 'guest'
            )
            OR (
              sg.principal_type = 'group' AND EXISTS (
                SELECT 1 FROM group_members gm
                 WHERE gm.group_id = sg.principal_id AND gm.user_id = ?
              )
            )
          )`,
    )
      .bind(space.organization_id, space.id, userId, space.organization_id, membership.role, userId)
      .all<GrantRow>()
  ).results;
  const role = capRoleForMembership(
    membership.role,
    effectiveSpaceGrantRole(
      grants.map((grant) => ({ principalType: grant.principal_type, role: grant.role })),
      fallback,
    ),
  );
  return role ? { ...membership, spaceId: space.id, spaceRole: role } : null;
}

export function resolveSpaceAccess(
  env: Env,
  spaceId: string,
  userId: string,
): Promise<SpaceAccessContext | null> {
  return resolveSpaceAccessInternal(env, spaceId, userId, false);
}

export function resolveArchivedSpaceAccess(
  env: Env,
  spaceId: string,
  userId: string,
): Promise<SpaceAccessContext | null> {
  return resolveSpaceAccessInternal(env, spaceId, userId, true);
}

export async function requireSpaceAction(
  env: Env,
  spaceId: string,
  userId: string,
  action: SpaceAction,
): Promise<SpaceAccessContext | null> {
  const access = await resolveSpaceAccess(env, spaceId, userId);
  return access && canSpace(access.spaceRole, action) ? access : null;
}

async function resolvePageAccessInternal(
  env: Env,
  pageId: string,
  userId: string,
  includeDeleted: boolean,
): Promise<SpaceAccessContext | null> {
  const page = await env.DB.prepare(
    `SELECT p.id AS page_id, p.organization_id, p.space_id
       FROM pages p JOIN spaces s ON s.id = p.space_id
      WHERE p.id = ? ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        AND s.archived_at IS NULL AND s.deleted_at IS NULL`,
  )
    .bind(pageId)
    .first<PageAccessRow>();
  if (!page) return null;
  const spaceAccess = await resolveSpaceAccess(env, page.space_id, userId);
  if (!spaceAccess || spaceAccess.organizationId !== page.organization_id) return null;
  if (spaceAccess.spaceRole === 'space_admin') return spaceAccess;

  const boundary = await env.DB.prepare(
    `WITH RECURSIVE ancestors(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM pages WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
       UNION ALL
       SELECT p.id, p.parent_id, ancestors.depth + 1
         FROM pages p JOIN ancestors ON p.id = ancestors.parent_id
        ${includeDeleted ? '' : 'WHERE p.deleted_at IS NULL'}
     )
     SELECT ancestors.id
       FROM ancestors JOIN page_access_state state ON state.page_id = ancestors.id
      WHERE state.access_mode = 'restricted'
      ORDER BY ancestors.depth ASC LIMIT 1`,
  )
    .bind(pageId)
    .first<{ id: string }>();
  if (!boundary) return spaceAccess;

  const grants = (
    await env.DB.prepare(
      `SELECT pg.principal_type, pg.role
         FROM page_grants pg
        WHERE pg.organization_id = ? AND pg.page_id = ?
          AND (
            (pg.principal_type = 'user' AND pg.principal_id = ?)
            OR (
              pg.principal_type = 'organization' AND pg.principal_id = ? AND ? <> 'guest'
            )
            OR (
              pg.principal_type = 'group' AND EXISTS (
                SELECT 1 FROM group_members gm
                 WHERE gm.group_id = pg.principal_id AND gm.user_id = ?
              )
            )
          )`,
    )
      .bind(
        page.organization_id,
        boundary.id,
        userId,
        page.organization_id,
        spaceAccess.role,
        userId,
      )
      .all<PageGrantAccessRow>()
  ).results;
  const grantedRole = capRoleForMembership(
    spaceAccess.role,
    effectivePageGrantRole(
      grants.map((grant) => ({ principalType: grant.principal_type, role: grant.role })),
    ),
  );
  if (!grantedRole) return null;
  return {
    ...spaceAccess,
    spaceRole: grantedRole,
  };
}

export function resolvePageAccess(
  env: Env,
  pageId: string,
  userId: string,
): Promise<SpaceAccessContext | null> {
  return resolvePageAccessInternal(env, pageId, userId, false);
}

export function resolveDeletedPageAccess(
  env: Env,
  pageId: string,
  userId: string,
): Promise<SpaceAccessContext | null> {
  return resolvePageAccessInternal(env, pageId, userId, true);
}

export async function requirePageAction(
  env: Env,
  pageId: string,
  userId: string,
  action: SpaceAction,
): Promise<SpaceAccessContext | null> {
  const access = await resolvePageAccess(env, pageId, userId);
  if (!access || !canSpace(access.spaceRole, action)) return null;
  if (action === 'edit_content') {
    const page = await env.DB.prepare(
      'SELECT is_locked FROM pages WHERE id = ? AND deleted_at IS NULL',
    )
      .bind(pageId)
      .first<{ is_locked: number }>();
    if (!page || page.is_locked) return null;
  }
  return access;
}

export async function requireDeletedPageAction(
  env: Env,
  pageId: string,
  userId: string,
  action: SpaceAction,
): Promise<SpaceAccessContext | null> {
  const access = await resolveDeletedPageAccess(env, pageId, userId);
  return access && canSpace(access.spaceRole, action) ? access : null;
}
