import type {
  AuditEventSummary,
  AuthUserSummary,
  GroupSummary,
  InvitationSummary,
  OrganizationMemberSummary,
  OrganizationAssignableRole,
  OrganizationRole,
  OrganizationSummary,
  SpaceGrantPrincipalType,
  SpaceGrantSummary,
  SpaceGrantRole,
  SpaceRole,
  SpaceSummary,
  SpaceVisibility,
} from '@rdocs/shared';

import {
  canManageOrganization,
  canSpace,
  findActiveMembership,
  resolveArchivedSpaceAccess,
  resolveSpaceAccess,
} from './access';
import { invalidateCollaborationPage } from './collaboration-access-cache';
import type { Env } from './env';
import { bumpSyncedBlocksForSpace } from './synced-block-acl';

const MAX_NAME_LENGTH = 100;
const MAX_SLUG_LENGTH = 50;
const MAX_MEMBERS = 500;
const MAX_SPACES = 200;
const MAX_GROUPS = 100;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: OrganizationRole;
  status: 'invited' | 'active' | 'suspended';
  joined_at: number | null;
  updated_at: number;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  organization_role: Exclude<OrganizationRole, 'owner'>;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface InvitationAcceptRow extends InvitationRow {
  token_hash: string;
}

export interface RegistrationInvitation {
  id: string;
  organizationId: string;
  email: string;
}

interface SpaceRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  icon: string | null;
  visibility: SpaceVisibility;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface GroupRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  member_count: number;
  created_at: number;
}

interface GrantRow {
  id: string;
  organization_id: string;
  space_id: string;
  principal_type: SpaceGrantPrincipalType;
  principal_id: string;
  role: SpaceGrantRole;
  created_at: number;
}

interface PageAclRow {
  id: string;
  current_generation: number;
  acl_version: number;
  collaboration_enabled: number;
}

interface AuditEventRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  event_type: string;
  target_type: string;
  target_id: string;
  metadata_json: string;
  created_at: number;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, { status });
}

async function body<T>(request: Request): Promise<T | null> {
  return request.json<T>().catch(() => null);
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizedSlug(value: unknown, fallbackPrefix: string): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const slug = raw
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  if (slug.length >= 2) return slug;
  return `${fallbackPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function isEntityId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{2,100}$/i.test(value);
}

function isOrganizationAssignableRole(value: unknown): value is OrganizationAssignableRole {
  return value === 'admin' || value === 'member';
}

function organizationFromRow(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function memberFromRow(row: MemberRow): OrganizationMemberSummary {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at === null ? null : Number(row.joined_at),
    updatedAt: Number(row.updated_at),
  };
}

function invitationFromRow(row: InvitationRow): InvitationSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    organizationRole: row.organization_role,
    expiresAt: Number(row.expires_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at),
  };
}

function spaceFromRow(row: SpaceRow, role: SpaceRole): SpaceSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    visibility: row.visibility,
    role,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

function grantFromRow(row: GrantRow): SpaceGrantSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    role: row.role,
    createdAt: Number(row.created_at),
  };
}

function groupFromRow(row: GroupRow): GroupSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    memberCount: Number(row.member_count),
    createdAt: Number(row.created_at),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function findRegistrationInvitation(
  env: Env,
  token: string,
  email: string,
): Promise<RegistrationInvitation | null> {
  if (!token || token.length > 512) return null;
  const row = await env.DB.prepare(
    `SELECT id, organization_id, email
       FROM invitations
      WHERE token_hash = ? AND organization_role <> 'guest'
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<{ id: string; organization_id: string; email: string }>();
  return row && row.email === email
    ? { id: row.id, organizationId: row.organization_id, email: row.email }
    : null;
}

export async function registrationInvitationStillValid(
  env: Env,
  invitationId: string,
  email: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found FROM invitations
      WHERE id = ? AND email = ? AND organization_role <> 'guest'
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(invitationId, email, Date.now())
    .first<{ found: number }>();
  return Boolean(row);
}

async function invitationToken(env: Env, invitationId: string): Promise<string | null> {
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.COLLAB_TICKET_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`rdocs:invitation:${invitationId}`),
      ),
    ),
  );
}

function auditStatement(
  env: Env,
  organizationId: string,
  actorId: string,
  eventType: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_events(
      id, organization_id, actor_id, event_type, target_type, target_id,
      request_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    organizationId,
    actorId,
    eventType,
    targetType,
    targetId,
    JSON.stringify(metadata),
    Date.now(),
  );
}

async function findOrganization(
  env: Env,
  organizationId: string,
  userId: string,
): Promise<OrganizationSummary | null> {
  const row = await env.DB.prepare(
    `SELECT o.id, o.name, o.slug, m.role, o.created_at, o.updated_at
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = ? AND m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL`,
  )
    .bind(organizationId, userId)
    .first<OrganizationRow>();
  return row ? organizationFromRow(row) : null;
}

async function listOrganizations(env: Env, actor: AuthUserSummary): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT o.id, o.name, o.slug, m.role, o.created_at, o.updated_at
         FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
        WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL
        ORDER BY o.updated_at DESC, o.id ASC
        LIMIT 100`,
    )
      .bind(actor.id)
      .all<OrganizationRow>()
  ).results;
  return json({ organizations: rows.map(organizationFromRow) });
}

async function createOrganization(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response> {
  const input = await body<{ name?: unknown; slug?: unknown }>(request);
  const name = normalizedName(input?.name);
  if (!name) return error('组织名称必须为 1–100 个字符', 400);
  const slug = normalizedSlug(input?.slug ?? name, 'org');
  if (!slug) return error('组织标识无效', 400);
  const organizationId = crypto.randomUUID();
  const spaceId = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organizations(id, name, slug, created_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).bind(organizationId, name, slug, actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO organization_members(
          organization_id, user_id, role, status, joined_at, updated_at
        ) VALUES (?, ?, 'owner', 'active', ?, ?)`,
      ).bind(organizationId, actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO spaces(
          id, organization_id, name, slug, icon, visibility, created_by,
          created_at, updated_at, archived_at, deleted_at
        ) VALUES (?, ?, '通用空间', 'general', 'book-open', 'organization', ?, ?, ?, NULL, NULL)`,
      ).bind(spaceId, organizationId, actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO space_grants(
          id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
        ) VALUES (?, ?, ?, 'user', ?, 'space_admin', ?, ?)`,
      ).bind(crypto.randomUUID(), organizationId, spaceId, actor.id, actor.id, now),
      env.DB.prepare(
        `INSERT INTO space_grants(
          id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
        ) VALUES (?, ?, ?, 'organization', ?, 'viewer', ?, ?)`,
      ).bind(crypto.randomUUID(), organizationId, spaceId, organizationId, actor.id, now),
      auditStatement(
        env,
        organizationId,
        actor.id,
        'organization.created',
        'organization',
        organizationId,
      ),
    ]);
  } catch {
    return error('组织标识已存在，请换一个名称或标识', 409, 'organization_slug_conflict');
  }
  return json(
    {
      organization: {
        id: organizationId,
        name,
        slug,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      } satisfies OrganizationSummary,
      space: {
        id: spaceId,
        organizationId,
        name: '通用空间',
        slug: 'general',
        icon: 'book-open',
        visibility: 'organization',
        role: 'space_admin',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      } satisfies SpaceSummary,
    },
    { status: 201 },
  );
}

export async function provisionPersonalWorkspace(env: Env, actor: AuthUserSummary): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT 1 AS found FROM organization_members
      WHERE user_id = ? AND status = 'active' LIMIT 1`,
  )
    .bind(actor.id)
    .first<{ found: number }>();
  if (existing) return;
  const name = `${actor.displayName} 的工作区`.slice(0, MAX_NAME_LENGTH);
  const slug = normalizedSlug(name, 'ws');
  if (!slug) return;
  const organizationId = crypto.randomUUID();
  const spaceId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations(id, name, slug, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(organizationId, name, slug, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO organization_members(
        organization_id, user_id, role, status, joined_at, updated_at
      ) VALUES (?, ?, 'owner', 'active', ?, ?)`,
    ).bind(organizationId, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO spaces(
        id, organization_id, name, slug, icon, visibility, created_by,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (?, ?, '通用空间', 'general', 'book-open', 'organization', ?, ?, ?, NULL, NULL)`,
    ).bind(spaceId, organizationId, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO space_grants(
        id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
      ) VALUES (?, ?, ?, 'user', ?, 'space_admin', ?, ?)`,
    ).bind(crypto.randomUUID(), organizationId, spaceId, actor.id, actor.id, now),
    env.DB.prepare(
      `INSERT INTO space_grants(
        id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
      ) VALUES (?, ?, ?, 'organization', ?, 'viewer', ?, ?)`,
    ).bind(crypto.randomUUID(), organizationId, spaceId, organizationId, actor.id, now),
    auditStatement(
      env,
      organizationId,
      actor.id,
      'organization.created',
      'organization',
      organizationId,
      {
        source: 'passkey_registration',
      },
    ),
  ]);
}

async function updateOrganization(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'update')) {
    return error('无权修改此组织', 403);
  }
  const input = await body<{ name?: unknown; slug?: unknown }>(request);
  const existing = await findOrganization(env, organizationId, actor.id);
  if (!existing) return error('组织不存在', 404);
  const name = input?.name === undefined ? existing.name : normalizedName(input.name);
  const slug =
    input?.slug === undefined ? existing.slug : normalizedSlug(input.slug, existing.slug);
  if (!name || !slug) return error('组织名称或标识无效', 400);
  try {
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE organizations SET name = ?, slug = ?, updated_at = ? WHERE id = ?',
      ).bind(name, slug, Date.now(), organizationId),
      auditStatement(
        env,
        organizationId,
        actor.id,
        'organization.updated',
        'organization',
        organizationId,
      ),
    ]);
  } catch {
    return error('组织标识已存在', 409, 'organization_slug_conflict');
  }
  return json({ organization: await findOrganization(env, organizationId, actor.id) });
}

async function listMembers(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || membership.role === 'guest') return error('无权查看组织成员', 403);
  const rows = (
    await env.DB.prepare(
      `SELECT m.user_id, u.email, u.display_name, u.avatar_url,
              m.role, m.status, m.joined_at, m.updated_at
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 ELSE 4 END,
                 u.display_name ASC
        LIMIT ?`,
    )
      .bind(organizationId, MAX_MEMBERS)
      .all<MemberRow>()
  ).results;
  return json({ members: rows.map(memberFromRow) });
}

async function listAuditEvents(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return error('无权查看组织活动记录', 403);
  }
  const rows = (
    await env.DB.prepare(
      `SELECT a.id, a.actor_id, u.email AS actor_email,
              u.display_name AS actor_display_name, u.avatar_url AS actor_avatar_url,
              a.event_type, a.target_type, a.target_id, a.metadata_json, a.created_at
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.organization_id = ?
        ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    )
      .bind(organizationId)
      .all<AuditEventRow>()
  ).results;
  const events: AuditEventSummary[] = rows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      actor:
        row.actor_id && row.actor_email && row.actor_display_name
          ? {
              id: row.actor_id,
              email: row.actor_email,
              displayName: row.actor_display_name,
              avatarUrl: row.actor_avatar_url,
            }
          : null,
      eventType: row.event_type,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata,
      createdAt: Number(row.created_at),
    };
  });
  return json({ events });
}

async function listInvitations(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'manage_members')) {
    return error('无权查看邀请', 403);
  }
  const rows = (
    await env.DB.prepare(
      `SELECT id, organization_id, email, organization_role, expires_at,
              accepted_at, revoked_at, created_at
         FROM invitations
        WHERE organization_id = ?
        ORDER BY created_at DESC
        LIMIT 200`,
    )
      .bind(organizationId)
      .all<InvitationRow>()
  ).results;
  return json({ invitations: rows.map(invitationFromRow) });
}

async function createInvitation(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'manage_members')) {
    return error('无权邀请组织成员', 403);
  }
  const input = await body<{ email?: unknown; role?: unknown }>(request);
  const email = normalizedEmail(input?.email);
  const role = input?.role;
  if (!email) return error('请输入有效邮箱', 400);
  if (role === 'guest') {
    return error(
      '不再支持访客邀请；请邀请正式成员，或为页面创建只读分享链接',
      400,
      'guest_role_disabled',
    );
  }
  if (!isOrganizationAssignableRole(role)) {
    return error('邀请角色无效', 400);
  }
  if (membership.role !== 'owner' && role === 'admin') {
    return error('只有组织所有者可以邀请管理员', 403);
  }
  const activeMember = await env.DB.prepare(
    `SELECT 1 AS found
       FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND u.email = ? AND m.status = 'active'`,
  )
    .bind(organizationId, email)
    .first<{ found: number }>();
  if (activeMember) return error('该用户已经是组织成员', 409, 'member_exists');

  const existing = await env.DB.prepare(
    `SELECT id, organization_id, email, organization_role, expires_at,
            accepted_at, revoked_at, created_at
       FROM invitations
      WHERE organization_id = ? AND email = ? AND organization_role = ?
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(organizationId, email, role, Date.now())
    .first<InvitationRow>();
  if (existing) {
    const token = await invitationToken(env, existing.id);
    if (!token) return error('邀请服务尚未配置', 503);
    return json({ invitation: invitationFromRow(existing), token, reused: true });
  }

  const id = crypto.randomUUID();
  const token = await invitationToken(env, id);
  if (!token) return error('邀请服务尚未配置', 503);
  const now = Date.now();
  const expiresAt = now + INVITATION_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invitations(
        id, organization_id, email, organization_role, token_hash, expires_at,
        accepted_at, revoked_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).bind(id, organizationId, email, role, await sha256(token), expiresAt, actor.id, now),
    auditStatement(env, organizationId, actor.id, 'invitation.created', 'invitation', id, { role }),
  ]);
  return json(
    {
      invitation: invitationFromRow({
        id,
        organization_id: organizationId,
        email,
        organization_role: role,
        expires_at: expiresAt,
        accepted_at: null,
        revoked_at: null,
        created_at: now,
      }),
      token,
      reused: false,
    },
    { status: 201 },
  );
}

async function revokeInvitation(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  invitationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'manage_members')) {
    return error('无权撤销组织邀请', 403);
  }
  const now = Date.now();
  const revoked = await env.DB.prepare(
    `UPDATE invitations SET revoked_at = ?
      WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
  )
    .bind(now, invitationId, organizationId)
    .run();
  if (!revoked.meta.changes) return error('待处理邀请不存在', 404);
  await auditStatement(
    env,
    organizationId,
    actor.id,
    'invitation.revoked',
    'invitation',
    invitationId,
  ).run();
  return json({ ok: true, revokedAt: now });
}

async function acceptInvitation(
  env: Env,
  actor: AuthUserSummary,
  token: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, organization_id, email, organization_role, token_hash, expires_at,
            accepted_at, revoked_at, created_at
       FROM invitations WHERE token_hash = ?`,
  )
    .bind(await sha256(token))
    .first<InvitationAcceptRow>();
  if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now()) {
    return error('邀请不存在、已撤销或已过期', 404, 'invitation_invalid');
  }
  if (row.organization_role === 'guest') {
    return error('访客邀请已停用，请联系组织管理员创建正式成员邀请', 400, 'guest_role_disabled');
  }
  if (row.email !== actor.email.toLowerCase()) {
    return error('此邀请属于另一个邮箱账号', 403, 'invitation_email_mismatch');
  }
  const now = Date.now();
  if (row.accepted_at === null) {
    const accepted = await env.DB.prepare(
      `UPDATE invitations SET accepted_at = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
      .bind(now, row.id, now)
      .run();
    if (!accepted.meta.changes) return error('邀请状态已变化，请重试', 409);
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organization_members(
        organization_id, user_id, role, status, joined_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(organization_id, user_id) DO UPDATE SET
        role = excluded.role,
        status = 'active',
        joined_at = COALESCE(organization_members.joined_at, excluded.joined_at),
        updated_at = excluded.updated_at`,
    ).bind(row.organization_id, actor.id, row.organization_role, now, now),
    auditStatement(env, row.organization_id, actor.id, 'invitation.accepted', 'invitation', row.id),
  ]);
  return json({ organization: await findOrganization(env, row.organization_id, actor.id) });
}

async function updateMember(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  userId: string,
  context: ExecutionContext,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'manage_members')) {
    return error('无权管理组织成员', 403);
  }
  const target = await env.DB.prepare(
    `SELECT role, status FROM organization_members WHERE organization_id = ? AND user_id = ?`,
  )
    .bind(organizationId, userId)
    .first<{ role: OrganizationRole; status: string }>();
  if (!target) return error('组织成员不存在', 404);
  if (target.role === 'owner') return error('请先转让组织所有权', 409, 'owner_protected');

  const input = await body<{ role?: unknown; status?: unknown }>(request);
  const requestedRole = input?.role;
  if (requestedRole === 'guest') {
    return error('访客角色已停用；可将历史外部只读成员升级为正式成员', 400, 'guest_role_disabled');
  }
  if (requestedRole !== undefined && !isOrganizationAssignableRole(requestedRole)) {
    return error('成员角色无效', 400);
  }
  const role = (requestedRole ?? target.role) as OrganizationRole;
  const status = input?.status ?? target.status;
  if (status !== 'active' && status !== 'suspended') return error('成员状态无效', 400);
  if (membership.role !== 'owner' && (target.role === 'admin' || role === 'admin')) {
    return error('只有组织所有者可以管理管理员', 403);
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE organization_members SET role = ?, status = ?, updated_at = ?
        WHERE organization_id = ? AND user_id = ?`,
    ).bind(role, status, Date.now(), organizationId, userId),
    auditStatement(env, organizationId, actor.id, 'member.updated', 'user', userId, {
      role,
      status,
    }),
  ]);
  const spaces = (
    await env.DB.prepare('SELECT id FROM spaces WHERE organization_id = ? AND deleted_at IS NULL')
      .bind(organizationId)
      .all<{ id: string }>()
  ).results;
  for (const space of spaces) await bumpSpaceAcl(env, space.id, context);
  return listMembers(env, actor, organizationId);
}

async function removeMember(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  userId: string,
  context: ExecutionContext,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'manage_members')) {
    return error('无权移出组织成员', 403);
  }
  const target = await env.DB.prepare(
    'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?',
  )
    .bind(organizationId, userId)
    .first<{ role: OrganizationRole }>();
  if (!target) return error('组织成员不存在', 404);
  if (target.role === 'owner') return error('请先转让组织所有权', 409, 'owner_protected');
  if (membership.role !== 'owner' && target.role === 'admin') {
    return error('只有组织所有者可以移出管理员', 403);
  }
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?',
    ).bind(organizationId, userId),
    env.DB.prepare(
      `DELETE FROM space_grants
        WHERE organization_id = ? AND principal_type = 'user' AND principal_id = ?`,
    ).bind(organizationId, userId),
    env.DB.prepare(
      `DELETE FROM page_grants
        WHERE organization_id = ? AND principal_type = 'user' AND principal_id = ?`,
    ).bind(organizationId, userId),
    env.DB.prepare(
      `DELETE FROM group_members
        WHERE user_id = ? AND group_id IN (
          SELECT id FROM groups WHERE organization_id = ?
        )`,
    ).bind(userId, organizationId),
    auditStatement(env, organizationId, actor.id, 'member.removed', 'user', userId),
  ]);
  const spaces = (
    await env.DB.prepare('SELECT id FROM spaces WHERE organization_id = ? AND deleted_at IS NULL')
      .bind(organizationId)
      .all<{ id: string }>()
  ).results;
  for (const space of spaces) await bumpSpaceAcl(env, space.id, context);
  return json({ ok: true });
}

async function transferOwnership(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || membership.role !== 'owner') return error('只有组织所有者可以转让所有权', 403);
  const input = await body<{ userId?: unknown }>(request);
  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (!isEntityId(userId) || userId === actor.id) return error('请选择其他有效成员', 400);
  const target = await findActiveMembership(env, organizationId, userId);
  if (!target) return error('接收人不是此组织的有效成员', 404);
  if (target.role === 'guest') {
    return error('历史外部只读成员不能接收组织所有权，请先升级为正式成员', 400);
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE organization_members SET role = 'admin', updated_at = ?
        WHERE organization_id = ? AND user_id = ? AND role = 'owner'`,
    ).bind(now, organizationId, actor.id),
    env.DB.prepare(
      `UPDATE organization_members SET role = 'owner', status = 'active', updated_at = ?
        WHERE organization_id = ? AND user_id = ?`,
    ).bind(now, organizationId, userId),
    auditStatement(
      env,
      organizationId,
      actor.id,
      'organization.owner.transferred',
      'user',
      userId,
      {
        previousOwnerId: actor.id,
      },
    ),
  ]);
  return json({ organization: await findOrganization(env, organizationId, actor.id) });
}

async function requireGroupManager(
  env: Env,
  organizationId: string,
  actorId: string,
): Promise<boolean> {
  const membership = await findActiveMembership(env, organizationId, actorId);
  return Boolean(membership && canManageOrganization(membership.role, 'manage_members'));
}

async function listGroups(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || membership.role === 'guest') return error('无权查看用户组', 403);
  const rows = (
    await env.DB.prepare(
      `SELECT g.id, g.organization_id, g.name, g.description, g.created_at,
              COUNT(gm.user_id) AS member_count
         FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
        WHERE g.organization_id = ?
        GROUP BY g.id
        ORDER BY g.name ASC LIMIT ?`,
    )
      .bind(organizationId, MAX_GROUPS)
      .all<GroupRow>()
  ).results;
  return json({ groups: rows.map(groupFromRow) });
}

async function createGroup(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  if (!(await requireGroupManager(env, organizationId, actor.id))) {
    return error('无权创建用户组', 403);
  }
  const input = await body<{ name?: unknown; description?: unknown }>(request);
  const name = normalizedName(input?.name);
  const description =
    typeof input?.description === 'string' ? input.description.trim().slice(0, 500) || null : null;
  if (!name) return error('用户组名称无效', 400);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM groups WHERE organization_id = ?',
  )
    .bind(organizationId)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_GROUPS) return error('用户组数量已达上限', 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO groups(id, organization_id, name, description, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, organizationId, name, description, actor.id, now),
      auditStatement(env, organizationId, actor.id, 'group.created', 'group', id),
    ]);
  } catch {
    return error('用户组名称已存在', 409);
  }
  return json(
    {
      group: {
        id,
        organizationId,
        name,
        description,
        memberCount: 0,
        createdAt: now,
      } satisfies GroupSummary,
    },
    { status: 201 },
  );
}

async function findGroup(
  env: Env,
  organizationId: string,
  groupId: string,
): Promise<GroupRow | null> {
  return env.DB.prepare(
    `SELECT g.id, g.organization_id, g.name, g.description, g.created_at,
            COUNT(gm.user_id) AS member_count
       FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
      WHERE g.organization_id = ? AND g.id = ? GROUP BY g.id`,
  )
    .bind(organizationId, groupId)
    .first<GroupRow>();
}

async function updateGroup(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  groupId: string,
): Promise<Response> {
  if (!(await requireGroupManager(env, organizationId, actor.id))) {
    return error('无权管理用户组', 403);
  }
  const group = await findGroup(env, organizationId, groupId);
  if (!group) return error('用户组不存在', 404);
  const input = await body<{ name?: unknown; description?: unknown }>(request);
  const name = input?.name === undefined ? group.name : normalizedName(input.name);
  const description =
    input?.description === undefined
      ? group.description
      : typeof input.description === 'string'
        ? input.description.trim().slice(0, 500) || null
        : null;
  if (!name) return error('用户组名称无效', 400);
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').bind(
        name,
        description,
        groupId,
      ),
      auditStatement(env, organizationId, actor.id, 'group.updated', 'group', groupId),
    ]);
  } catch {
    return error('用户组名称已存在', 409);
  }
  return json({ group: groupFromRow({ ...group, name, description }) });
}

async function listGroupMembers(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  groupId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || membership.role === 'guest') return error('无权查看用户组成员', 403);
  if (!(await findGroup(env, organizationId, groupId))) return error('用户组不存在', 404);
  const rows = (
    await env.DB.prepare(
      `SELECT m.user_id, u.email, u.display_name, u.avatar_url,
              m.role, m.status, m.joined_at, m.updated_at
         FROM group_members gm
         JOIN organization_members m ON m.organization_id = ? AND m.user_id = gm.user_id
         JOIN users u ON u.id = m.user_id
        WHERE gm.group_id = ? AND m.status = 'active'
        ORDER BY u.display_name ASC`,
    )
      .bind(organizationId, groupId)
      .all<MemberRow>()
  ).results;
  return json({ members: rows.map(memberFromRow) });
}

async function setGroupMember(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  groupId: string,
  userId: string,
  add: boolean,
  context: ExecutionContext,
): Promise<Response> {
  if (!(await requireGroupManager(env, organizationId, actor.id))) {
    return error('无权管理用户组成员', 403);
  }
  if (!(await findGroup(env, organizationId, groupId))) return error('用户组不存在', 404);
  const targetMembership = await findActiveMembership(env, organizationId, userId);
  if (!targetMembership) {
    return error('用户不是此组织的有效成员', 400);
  }
  if (add && targetMembership.role === 'guest') {
    return error(
      '历史外部只读成员不能加入用户组；请先将其升级为正式成员',
      400,
      'guest_group_disabled',
    );
  }
  if (add) {
    await env.DB.prepare(
      `INSERT INTO group_members(group_id, user_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id, user_id) DO NOTHING`,
    )
      .bind(groupId, userId, Date.now())
      .run();
  } else {
    await env.DB.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId)
      .run();
  }
  await auditStatement(
    env,
    organizationId,
    actor.id,
    add ? 'group.member.added' : 'group.member.removed',
    'group',
    groupId,
    { userId },
  ).run();
  await bumpOrganizationAcl(env, organizationId, context);
  return listGroupMembers(env, actor, organizationId, groupId);
}

async function deleteGroup(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  groupId: string,
  context: ExecutionContext,
): Promise<Response> {
  if (!(await requireGroupManager(env, organizationId, actor.id))) {
    return error('无权删除用户组', 403);
  }
  if (!(await findGroup(env, organizationId, groupId))) return error('用户组不存在', 404);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM space_grants
        WHERE organization_id = ? AND principal_type = 'group' AND principal_id = ?`,
    ).bind(organizationId, groupId),
    env.DB.prepare(
      `DELETE FROM page_grants
        WHERE organization_id = ? AND principal_type = 'group' AND principal_id = ?`,
    ).bind(organizationId, groupId),
    env.DB.prepare('DELETE FROM groups WHERE organization_id = ? AND id = ?').bind(
      organizationId,
      groupId,
    ),
    auditStatement(env, organizationId, actor.id, 'group.deleted', 'group', groupId),
  ]);
  await bumpOrganizationAcl(env, organizationId, context);
  return json({ ok: true });
}

async function listSpaces(
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
  includeArchived: boolean,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership) return error('组织不存在或无权访问', 404);
  const rows = (
    await env.DB.prepare(
      `SELECT id, organization_id, name, slug, icon, visibility,
              created_at, updated_at, archived_at
         FROM spaces
        WHERE organization_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC, id ASC
        LIMIT ?`,
    )
      .bind(organizationId, MAX_SPACES)
      .all<SpaceRow>()
  ).results;
  const spaces: SpaceSummary[] = [];
  for (const row of rows) {
    if (!includeArchived && row.archived_at !== null) continue;
    const access = includeArchived
      ? await resolveArchivedSpaceAccess(env, row.id, actor.id)
      : await resolveSpaceAccess(env, row.id, actor.id);
    if (access && (row.archived_at === null || canSpace(access.spaceRole, 'manage_space'))) {
      spaces.push(spaceFromRow(row, access.spaceRole));
    }
  }
  return json({ spaces });
}

async function createSpace(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  organizationId: string,
): Promise<Response> {
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || !canManageOrganization(membership.role, 'create_space')) {
    return error('无权创建空间', 403);
  }
  const input = await body<{
    name?: unknown;
    slug?: unknown;
    icon?: unknown;
    visibility?: unknown;
  }>(request);
  const name = normalizedName(input?.name);
  const slug = normalizedSlug(input?.slug ?? name, 'space');
  const visibility = input?.visibility ?? 'organization';
  const icon = typeof input?.icon === 'string' ? input.icon.trim().slice(0, 40) || null : null;
  if (!name || !slug) return error('空间名称或标识无效', 400);
  if (visibility !== 'organization' && visibility !== 'restricted') {
    return error('空间可见性无效', 400);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO spaces(
        id, organization_id, name, slug, icon, visibility, created_by,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).bind(id, organizationId, name, slug, icon, visibility, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO space_grants(
        id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
      ) VALUES (?, ?, ?, 'user', ?, 'space_admin', ?, ?)`,
    ).bind(crypto.randomUUID(), organizationId, id, actor.id, actor.id, now),
    auditStatement(env, organizationId, actor.id, 'space.created', 'space', id, {
      visibility,
    }),
  ];
  if (visibility === 'organization') {
    statements.push(
      env.DB.prepare(
        `INSERT INTO space_grants(
          id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
        ) VALUES (?, ?, ?, 'organization', ?, 'viewer', ?, ?)`,
      ).bind(crypto.randomUUID(), organizationId, id, organizationId, actor.id, now),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch {
    return error('空间标识已存在', 409, 'space_slug_conflict');
  }
  return json(
    {
      space: {
        id,
        organizationId,
        name,
        slug,
        icon,
        visibility,
        role: 'space_admin',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      } satisfies SpaceSummary,
    },
    { status: 201 },
  );
}

async function findSpaceRow(env: Env, spaceId: string): Promise<SpaceRow | null> {
  return env.DB.prepare(
    `SELECT id, organization_id, name, slug, icon, visibility,
            created_at, updated_at, archived_at
       FROM spaces WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(spaceId)
    .first<SpaceRow>();
}

async function getSpace(env: Env, actor: AuthUserSummary, spaceId: string): Promise<Response> {
  const [row, access] = await Promise.all([
    findSpaceRow(env, spaceId),
    resolveArchivedSpaceAccess(env, spaceId, actor.id),
  ]);
  return row && access
    ? json({ space: spaceFromRow(row, access.spaceRole) })
    : error('空间不存在或无权访问', 404);
}

async function updateSpace(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  spaceId: string,
  context: ExecutionContext,
): Promise<Response> {
  const [row, access] = await Promise.all([
    findSpaceRow(env, spaceId),
    resolveArchivedSpaceAccess(env, spaceId, actor.id),
  ]);
  if (!row || !access) return error('空间不存在或无权访问', 404);
  if (!canSpace(access.spaceRole, 'manage_space')) return error('无权管理空间设置', 403);
  const input = await body<{
    name?: unknown;
    slug?: unknown;
    icon?: unknown;
    visibility?: unknown;
    archived?: unknown;
  }>(request);
  const name = input?.name === undefined ? row.name : normalizedName(input.name);
  const slug = input?.slug === undefined ? row.slug : normalizedSlug(input.slug, row.slug);
  const icon =
    input?.icon === undefined
      ? row.icon
      : typeof input.icon === 'string'
        ? input.icon.trim().slice(0, 40) || null
        : null;
  const visibility = input?.visibility ?? row.visibility;
  if (!name || !slug) return error('空间名称或标识无效', 400);
  if (visibility !== 'organization' && visibility !== 'restricted') {
    return error('空间可见性无效', 400);
  }
  if (input?.archived !== undefined && typeof input.archived !== 'boolean') {
    return error('archived 必须是布尔值', 400);
  }
  const archivedAt =
    input?.archived === undefined ? row.archived_at : input.archived ? Date.now() : null;
  const updatedAt = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE spaces
          SET name = ?, slug = ?, icon = ?, visibility = ?, archived_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(name, slug, icon, visibility, archivedAt, updatedAt, spaceId),
    auditStatement(env, row.organization_id, actor.id, 'space.updated', 'space', spaceId, {
      visibility,
      archived: archivedAt !== null,
    }),
  ];
  if (row.visibility !== visibility && visibility === 'restricted') {
    statements.push(
      env.DB.prepare(
        `DELETE FROM space_grants
          WHERE organization_id = ? AND space_id = ?
            AND principal_type = 'organization' AND principal_id = ?`,
      ).bind(row.organization_id, spaceId, row.organization_id),
    );
  } else if (row.visibility !== visibility && visibility === 'organization') {
    statements.push(
      env.DB.prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES (?, ?, ?, 'organization', ?, 'viewer', ?, ?)
         ON CONFLICT(organization_id, space_id, principal_type, principal_id) DO NOTHING`,
      ).bind(
        crypto.randomUUID(),
        row.organization_id,
        spaceId,
        row.organization_id,
        actor.id,
        updatedAt,
      ),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch {
    return error('空间标识已存在', 409, 'space_slug_conflict');
  }
  if (visibility !== row.visibility || archivedAt !== row.archived_at) {
    await bumpSpaceAcl(env, spaceId, context);
  }
  return json({
    space: spaceFromRow(
      {
        ...row,
        name,
        slug,
        icon,
        visibility,
        archived_at: archivedAt,
        updated_at: updatedAt,
      },
      access.spaceRole,
    ),
  });
}

async function listGrants(env: Env, actor: AuthUserSummary, spaceId: string): Promise<Response> {
  const access = await resolveSpaceAccess(env, spaceId, actor.id);
  if (!access || !canSpace(access.spaceRole, 'manage_access')) {
    return error('无权查看空间授权', 403);
  }
  return json({ grants: await spaceGrantSnapshot(env, spaceId) });
}

async function spaceGrantSnapshot(env: Env, spaceId: string): Promise<SpaceGrantSummary[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, organization_id, space_id, principal_type, principal_id, role, created_at
         FROM space_grants WHERE space_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
      .bind(spaceId)
      .all<GrantRow>()
  ).results;
  return rows.map(grantFromRow);
}

async function validatePrincipal(
  env: Env,
  organizationId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
): Promise<boolean> {
  if (principalType === 'organization') return principalId === organizationId;
  if (principalType === 'user') {
    return Boolean(await findActiveMembership(env, organizationId, principalId));
  }
  const group = await env.DB.prepare(
    'SELECT 1 AS found FROM groups WHERE id = ? AND organization_id = ?',
  )
    .bind(principalId, organizationId)
    .first<{ found: number }>();
  return Boolean(group);
}

async function bumpSpaceAcl(env: Env, spaceId: string, context: ExecutionContext): Promise<void> {
  await env.DB.prepare(
    `UPDATE page_access_state
        SET acl_version = acl_version + 1, updated_at = ?
      WHERE page_id IN (SELECT id FROM pages WHERE space_id = ? AND deleted_at IS NULL)`,
  )
    .bind(Date.now(), spaceId)
    .run();
  const pages = (
    await env.DB.prepare(
      `SELECT p.id, p.current_generation, a.acl_version, a.collaboration_enabled
         FROM pages p JOIN page_access_state a ON a.page_id = p.id
        WHERE p.space_id = ? AND p.deleted_at IS NULL
        LIMIT 1000`,
    )
      .bind(spaceId)
      .all<PageAclRow>()
  ).results;
  const notifications = pages.map(async (page) => {
    invalidateCollaborationPage(page.id);
    const room = env.DocumentRoom.get(
      env.DocumentRoom.idFromName(
        `document:${page.id}:generation:${Number(page.current_generation)}`,
      ),
    );
    await room.fetch('https://rdocs.internal/internal/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: Boolean(page.collaboration_enabled),
        aclVersion: Number(page.acl_version),
        closeConnections: true,
      }),
    });
  });
  context.waitUntil(Promise.all(notifications).then(() => undefined));
  await bumpSyncedBlocksForSpace(env, spaceId, context);
}

async function bumpOrganizationAcl(
  env: Env,
  organizationId: string,
  context: ExecutionContext,
): Promise<void> {
  const spaces = (
    await env.DB.prepare('SELECT id FROM spaces WHERE organization_id = ? AND deleted_at IS NULL')
      .bind(organizationId)
      .all<{ id: string }>()
  ).results;
  for (const space of spaces) await bumpSpaceAcl(env, space.id, context);
}

async function putGrant(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  spaceId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
  context: ExecutionContext,
): Promise<Response> {
  const [row, access] = await Promise.all([
    findSpaceRow(env, spaceId),
    resolveSpaceAccess(env, spaceId, actor.id),
  ]);
  if (!row || !access) return error('空间不存在或无权访问', 404);
  if (!canSpace(access.spaceRole, 'manage_access')) return error('无权管理空间授权', 403);
  const input = await body<{ role?: unknown }>(request);
  const role = input?.role;
  if (
    role !== 'none' &&
    role !== 'space_admin' &&
    role !== 'editor' &&
    role !== 'commenter' &&
    role !== 'viewer'
  ) {
    return error('空间角色无效', 400);
  }
  if (!(await validatePrincipal(env, row.organization_id, principalType, principalId))) {
    return error('授权主体不属于此组织', 400, 'principal_tenant_mismatch');
  }
  if (principalType === 'user') {
    const principalMembership = await findActiveMembership(env, row.organization_id, principalId);
    if (principalMembership?.role === 'guest' && role !== 'none' && role !== 'viewer') {
      return error('历史外部只读成员最高只能获得只读权限', 400, 'guest_read_only');
    }
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM space_grants
      WHERE organization_id = ? AND space_id = ? AND principal_type = ? AND principal_id = ?`,
  )
    .bind(row.organization_id, spaceId, principalType, principalId)
    .first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO space_grants(
        id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, space_id, principal_type, principal_id)
      DO UPDATE SET role = excluded.role, created_by = excluded.created_by, created_at = excluded.created_at`,
    ).bind(id, row.organization_id, spaceId, principalType, principalId, role, actor.id, now),
    auditStatement(env, row.organization_id, actor.id, 'space.grant.updated', 'space', spaceId, {
      principalType,
      principalId,
      role,
    }),
  ]);
  await bumpSpaceAcl(env, spaceId, context);
  return json({ grants: await spaceGrantSnapshot(env, spaceId) });
}

async function deleteGrant(
  env: Env,
  actor: AuthUserSummary,
  spaceId: string,
  principalType: SpaceGrantPrincipalType,
  principalId: string,
  context: ExecutionContext,
): Promise<Response> {
  const [row, access] = await Promise.all([
    findSpaceRow(env, spaceId),
    resolveSpaceAccess(env, spaceId, actor.id),
  ]);
  if (!row || !access) return error('空间不存在或无权访问', 404);
  if (!canSpace(access.spaceRole, 'manage_access')) return error('无权管理空间授权', 403);
  const deleted = await env.DB.prepare(
    `DELETE FROM space_grants
      WHERE organization_id = ? AND space_id = ? AND principal_type = ? AND principal_id = ?`,
  )
    .bind(row.organization_id, spaceId, principalType, principalId)
    .run();
  if (!deleted.meta.changes) return error('空间授权不存在', 404);
  await auditStatement(
    env,
    row.organization_id,
    actor.id,
    'space.grant.removed',
    'space',
    spaceId,
    {
      principalType,
      principalId,
    },
  ).run();
  await bumpSpaceAcl(env, spaceId, context);
  return json({ ok: true });
}

function principalType(value: string): SpaceGrantPrincipalType | null {
  return value === 'user' || value === 'group' || value === 'organization' ? value : null;
}

export async function handleTenancyApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  context: ExecutionContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/organizations') {
    if (request.method === 'GET') return listOrganizations(env, actor);
    if (request.method === 'POST') return createOrganization(request, env, actor);
  }

  const acceptMatch = path.match(/^\/api\/invitations\/([^/]+)\/accept$/);
  if (acceptMatch?.[1] && request.method === 'POST') {
    return acceptInvitation(env, actor, decodeURIComponent(acceptMatch[1]));
  }

  const organizationMatch = path.match(/^\/api\/organizations\/([^/]+)$/);
  if (organizationMatch?.[1]) {
    const organizationId = decodeURIComponent(organizationMatch[1]);
    if (!isEntityId(organizationId)) return error('组织 ID 无效', 400);
    if (request.method === 'GET') {
      const organization = await findOrganization(env, organizationId, actor.id);
      return organization ? json({ organization }) : error('组织不存在或无权访问', 404);
    }
    if (request.method === 'PATCH') {
      return updateOrganization(request, env, actor, organizationId);
    }
  }

  const memberListMatch = path.match(/^\/api\/organizations\/([^/]+)\/members$/);
  if (memberListMatch?.[1] && request.method === 'GET') {
    return listMembers(env, actor, decodeURIComponent(memberListMatch[1]));
  }

  const activityMatch = path.match(/^\/api\/organizations\/([^/]+)\/activity$/);
  if (activityMatch?.[1] && request.method === 'GET') {
    return listAuditEvents(env, actor, decodeURIComponent(activityMatch[1]));
  }
  const memberMatch = path.match(/^\/api\/organizations\/([^/]+)\/members\/([^/]+)$/);
  if (memberMatch?.[1] && memberMatch[2]) {
    const organizationId = decodeURIComponent(memberMatch[1]);
    const userId = decodeURIComponent(memberMatch[2]);
    if (request.method === 'PATCH') {
      return updateMember(request, env, actor, organizationId, userId, context);
    }
    if (request.method === 'DELETE') {
      return removeMember(env, actor, organizationId, userId, context);
    }
  }

  const invitationListMatch = path.match(/^\/api\/organizations\/([^/]+)\/invitations$/);
  if (invitationListMatch?.[1]) {
    const organizationId = decodeURIComponent(invitationListMatch[1]);
    if (request.method === 'GET') return listInvitations(env, actor, organizationId);
    if (request.method === 'POST') {
      return createInvitation(request, env, actor, organizationId);
    }
  }

  const invitationMatch = path.match(/^\/api\/organizations\/([^/]+)\/invitations\/([^/]+)$/);
  if (invitationMatch?.[1] && invitationMatch[2] && request.method === 'DELETE') {
    return revokeInvitation(
      env,
      actor,
      decodeURIComponent(invitationMatch[1]),
      decodeURIComponent(invitationMatch[2]),
    );
  }

  const ownershipMatch = path.match(/^\/api\/organizations\/([^/]+)\/transfer-ownership$/);
  if (ownershipMatch?.[1] && request.method === 'POST') {
    return transferOwnership(request, env, actor, decodeURIComponent(ownershipMatch[1]));
  }

  const groupsMatch = path.match(/^\/api\/organizations\/([^/]+)\/groups$/);
  if (groupsMatch?.[1]) {
    const organizationId = decodeURIComponent(groupsMatch[1]);
    if (request.method === 'GET') return listGroups(env, actor, organizationId);
    if (request.method === 'POST') return createGroup(request, env, actor, organizationId);
  }

  const groupMembersMatch = path.match(/^\/api\/organizations\/([^/]+)\/groups\/([^/]+)\/members$/);
  if (groupMembersMatch?.[1] && groupMembersMatch[2] && request.method === 'GET') {
    return listGroupMembers(
      env,
      actor,
      decodeURIComponent(groupMembersMatch[1]),
      decodeURIComponent(groupMembersMatch[2]),
    );
  }

  const groupMemberMatch = path.match(
    /^\/api\/organizations\/([^/]+)\/groups\/([^/]+)\/members\/([^/]+)$/,
  );
  if (groupMemberMatch?.[1] && groupMemberMatch[2] && groupMemberMatch[3]) {
    const organizationId = decodeURIComponent(groupMemberMatch[1]);
    const groupId = decodeURIComponent(groupMemberMatch[2]);
    const userId = decodeURIComponent(groupMemberMatch[3]);
    if (request.method === 'PUT' || request.method === 'DELETE') {
      return setGroupMember(
        env,
        actor,
        organizationId,
        groupId,
        userId,
        request.method === 'PUT',
        context,
      );
    }
  }

  const groupMatch = path.match(/^\/api\/organizations\/([^/]+)\/groups\/([^/]+)$/);
  if (groupMatch?.[1] && groupMatch[2]) {
    const organizationId = decodeURIComponent(groupMatch[1]);
    const groupId = decodeURIComponent(groupMatch[2]);
    if (request.method === 'PATCH') {
      return updateGroup(request, env, actor, organizationId, groupId);
    }
    if (request.method === 'DELETE') {
      return deleteGroup(env, actor, organizationId, groupId, context);
    }
  }

  const spacesMatch = path.match(/^\/api\/organizations\/([^/]+)\/spaces$/);
  if (spacesMatch?.[1]) {
    const organizationId = decodeURIComponent(spacesMatch[1]);
    if (request.method === 'GET') {
      return listSpaces(
        env,
        actor,
        organizationId,
        new URL(request.url).searchParams.get('includeArchived') === '1',
      );
    }
    if (request.method === 'POST') return createSpace(request, env, actor, organizationId);
  }

  const spaceMatch = path.match(/^\/api\/spaces\/([^/]+)$/);
  if (spaceMatch?.[1]) {
    const spaceId = decodeURIComponent(spaceMatch[1]);
    if (request.method === 'GET') return getSpace(env, actor, spaceId);
    if (request.method === 'PATCH') return updateSpace(request, env, actor, spaceId, context);
  }

  const grantsMatch = path.match(/^\/api\/spaces\/([^/]+)\/grants$/);
  if (grantsMatch?.[1] && request.method === 'GET') {
    return listGrants(env, actor, decodeURIComponent(grantsMatch[1]));
  }

  const grantMatch = path.match(/^\/api\/spaces\/([^/]+)\/grants\/([^/]+)\/([^/]+)$/);
  if (grantMatch?.[1] && grantMatch[2] && grantMatch[3]) {
    const spaceId = decodeURIComponent(grantMatch[1]);
    const type = principalType(decodeURIComponent(grantMatch[2]));
    const principalId = decodeURIComponent(grantMatch[3]);
    if (!type || !isEntityId(principalId)) return error('空间授权主体无效', 400);
    if (request.method === 'PUT') {
      return putGrant(request, env, actor, spaceId, type, principalId, context);
    }
    if (request.method === 'DELETE') {
      return deleteGrant(env, actor, spaceId, type, principalId, context);
    }
  }

  return null;
}
