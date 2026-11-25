import type { AuthSessionResponse, AuthUserSummary } from '@rdocs/shared';

import type { Env } from './env';
import { provisionPersonalWorkspace } from './tenancy';

/**
 * Rdocs signs people in with their RandallFlare account only.
 *
 * The app runs as a *public* RandallFlare app. Visitors sign in through the
 * edge gateway (`/__rf_access/login`), which keeps its own `__Host-rf_user`
 * cookie and states who the visitor is on every request in `RF-User-*`
 * headers. The gateway strips any `RF-User-*` header a client sends before
 * writing its own verified values, and leaves them off cross-site writes and
 * WebSockets, so these headers are the only identity source Rdocs trusts.
 * Rdocs keeps no passwords, passkeys or session cookies of its own.
 */
export const RF_LOGIN_PATH = '/__rf_access/login';
export const RF_LOGOUT_PATH = '/__rf_access/logout';

const MAX_HEADER_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 80;

export type AccessPolicy = 'members' | 'accounts';

export interface RandallFlareIdentity {
  /** RandallFlare account id, or `email:<address>` for an email-code visitor. */
  id: string;
  email: string | null;
  username: string | null;
  name: string | null;
  owner: boolean;
  member: boolean;
}

export type AuthStatus = 'anonymous' | 'forbidden' | 'active';

export interface AuthContext {
  status: AuthStatus;
  user: AuthUserSummary | null;
  identity: RandallFlareIdentity | null;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: 'active' | 'disabled';
  external_id: string | null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function headerValue(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim() ?? '';
  if (!value || value.length > MAX_HEADER_LENGTH) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return null;
  }
  return value;
}

function normalizedEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() ?? '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function accessPolicy(env: Env): AccessPolicy {
  return env.RF_ACCESS_POLICY?.trim().toLowerCase() === 'accounts' ? 'accounts' : 'members';
}

/** Reads the visitor the RandallFlare gateway verified, or null for an anonymous request. */
export function randallFlareIdentity(request: Request): RandallFlareIdentity | null {
  const id = headerValue(request, 'rf-user-id');
  if (!id) return null;
  let name: string | null = null;
  const encodedName = headerValue(request, 'rf-user-name');
  if (encodedName) {
    try {
      name = decodeURIComponent(encodedName).trim().slice(0, MAX_DISPLAY_NAME_LENGTH) || null;
    } catch {
      name = null;
    }
  }
  const owner = request.headers.get('rf-user-owner') === '1';
  return {
    id,
    email: normalizedEmail(headerValue(request, 'rf-user-email')),
    username: headerValue(request, 'rf-user-username'),
    name,
    owner,
    member: owner || request.headers.get('rf-user-member') === '1',
  };
}

function isEmailVisitor(identity: RandallFlareIdentity): boolean {
  return identity.id.startsWith('email:');
}

export function identityAllowed(identity: RandallFlareIdentity, policy: AccessPolicy): boolean {
  if (identity.member) return true;
  return policy === 'accounts' && !isEmailVisitor(identity);
}

function profileFromIdentity(identity: RandallFlareIdentity): {
  email: string;
  displayName: string;
} {
  const email =
    identity.email ??
    `${identity.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)}@users.randallflare.invalid`;
  const displayName = (
    identity.name ||
    identity.username ||
    email.slice(0, email.indexOf('@')) ||
    'RandallFlare 用户'
  ).slice(0, MAX_DISPLAY_NAME_LENGTH);
  return { email, displayName };
}

function summary(row: UserRow): AuthUserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

const USER_COLUMNS = 'id, email, display_name, avatar_url, status, external_id';

async function userByExternalId(env: Env, externalId: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE external_id = ?`)
    .bind(externalId)
    .first<UserRow>();
}

async function refreshProfile(
  env: Env,
  row: UserRow,
  profile: { email: string; displayName: string },
): Promise<UserRow> {
  if (row.email === profile.email && row.display_name === profile.displayName) return row;
  const now = Date.now();
  try {
    await env.DB.prepare(
      'UPDATE users SET email = ?, display_name = ?, updated_at = ? WHERE id = ?',
    )
      .bind(profile.email, profile.displayName, now, row.id)
      .run();
    return { ...row, email: profile.email, display_name: profile.displayName };
  } catch {
    // Another Rdocs user already holds that address; keep the stored email.
    await env.DB.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
      .bind(profile.displayName, now, row.id)
      .run();
    return { ...row, display_name: profile.displayName };
  }
}

/**
 * Finds the Rdocs user behind a RandallFlare identity, creating it (with a
 * personal workspace) on first sign-in. A user that SCIM or an older
 * deployment created with the same email and no RandallFlare link is linked.
 */
export async function ensureUser(
  env: Env,
  identity: RandallFlareIdentity,
): Promise<UserRow | null> {
  const profile = profileFromIdentity(identity);
  const existing = await userByExternalId(env, identity.id);
  if (existing) return refreshProfile(env, existing, profile);

  const now = Date.now();
  const linked = await env.DB.prepare(
    `UPDATE users SET external_id = ?, display_name = ?, updated_at = ?
      WHERE email = ? AND external_id IS NULL`,
  )
    .bind(identity.id, profile.displayName, now, profile.email)
    .run();
  if (linked.meta.changes) return userByExternalId(env, identity.id);

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at, external_id)
       VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
    )
      .bind(id, profile.email, profile.displayName, now, now, identity.id)
      .run();
  } catch {
    // A concurrent first request created it, or the email belongs to a user
    // already linked to another RandallFlare account.
    const raced = await userByExternalId(env, identity.id);
    if (raced) return raced;
    await env.DB.prepare(
      `INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at, external_id)
       VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
    )
      .bind(id, `${id}@users.randallflare.invalid`, profile.displayName, now, now, identity.id)
      .run();
  }
  const created = await userByExternalId(env, identity.id);
  if (created?.status === 'active') {
    await provisionPersonalWorkspace(env, summary(created)).catch(() => undefined);
  }
  return created;
}

export async function authenticateRequest(request: Request, env: Env): Promise<AuthContext> {
  const identity = randallFlareIdentity(request);
  if (!identity) return { status: 'anonymous', user: null, identity: null };
  if (!identityAllowed(identity, accessPolicy(env))) {
    return { status: 'forbidden', user: null, identity };
  }
  const row = await ensureUser(env, identity);
  if (!row || row.status !== 'active') return { status: 'forbidden', user: null, identity };
  return { status: 'active', user: summary(row), identity };
}

function appOrigin(env: Env): string | null {
  const raw = env.APP_ORIGIN?.trim() ?? '';
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Writes must come from the app's own origin (the gateway enforces the same for identity). */
export function isTrustedMutationOrigin(request: Request, env: Env): boolean {
  const origin = appOrigin(env);
  return Boolean(origin && request.headers.get('origin') === origin);
}

async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  const response: AuthSessionResponse = {
    mode: 'randallflare',
    status: auth.status,
    authenticated: auth.status === 'active',
    user: auth.user,
    account: auth.identity
      ? {
          email: auth.identity.email,
          name: auth.identity.name,
          username: auth.identity.username,
        }
      : null,
    loginPath: RF_LOGIN_PATH,
    logoutPath: RF_LOGOUT_PATH,
  };
  return json(response);
}

export async function handleAuthApi(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/session' && request.method === 'GET') {
    return sessionResponse(request, env);
  }
  if (path.startsWith('/api/auth/')) return json({ error: '认证路径不存在' }, { status: 404 });
  return null;
}
