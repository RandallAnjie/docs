import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

import type { AuthMode, AuthSessionResponse, AuthUserSummary } from '@rdocs/shared';

import type { Env } from './env';
import {
  findRegistrationInvitation,
  provisionPersonalWorkspace,
  registrationInvitationStillValid,
} from './tenancy';

const SESSION_COOKIE = '__Host-rdocs_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const MAX_AUTH_BODY_BYTES = 256 * 1_024;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 254;
const RP_NAME = 'Rdocs';
const AUTHENTICATOR_TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);
interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  last_seen_at: number;
}

interface ChallengeRow {
  id: string;
  purpose: 'registration' | 'authentication';
  challenge: string;
  user_id: string | null;
  pending_user_id: string | null;
  pending_email: string | null;
  pending_display_name: string | null;
  invitation_id: string | null;
  expires_at: number;
  consumed_at: number | null;
}

interface CredentialRow {
  credential_id: string;
  user_id: string;
  public_key: unknown;
  counter: number;
  transports_json: string;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: number;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: 'active' | 'disabled';
}

export interface AuthContext {
  mode: AuthMode;
  user: AuthUserSummary | null;
  sessionId: string | null;
}

interface PasskeyConfiguration {
  rpId: string;
  origin: string;
  enrollmentSecret: string | null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number): Response {
  return json({ error: message }, { status });
}

export function authMode(_env: Env): AuthMode {
  return 'passkey';
}

function passkeyConfiguration(env: Env): PasskeyConfiguration | null {
  const rpId = env.PASSKEY_RP_ID?.trim() ?? '';
  const rawOrigin = env.PASSKEY_ORIGIN?.trim() ?? '';
  const enrollmentSecret = env.PASSKEY_ENROLLMENT_SECRET ?? '';
  if (!rpId || !rawOrigin) return null;
  try {
    const origin = new URL(rawOrigin);
    if (origin.origin !== rawOrigin.replace(/\/$/, '')) return null;
    if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') return null;
    if (origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`)) return null;
    return {
      rpId,
      origin: origin.origin,
      enrollmentSecret: enrollmentSecret.length >= 32 ? enrollmentSecret : null,
    };
  } catch {
    return null;
  }
}

function isPasskeyMutationOrigin(request: Request, configuration: PasskeyConfiguration): boolean {
  return request.headers.get('origin') === configuration.origin;
}

function userFromSessionRow(row: SessionRow): AuthUserSummary {
  return {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesFromUnknown(value: unknown): Uint8Array | null {
  if (typeof value === 'string') {
    if (!value || value === '{}') return null;
    try {
      return base64UrlToBytes(value);
    } catch {
      const bytes = new TextEncoder().encode(value);
      return bytes.length ? bytes : null;
    }
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function encodePasskeyPublicKey(bytes: Uint8Array): string {
  return base64Url(bytes);
}

export function decodeStoredPasskeyPublicKey(value: unknown): Uint8Array | null {
  const bytes = bytesFromUnknown(value);
  if (!bytes || bytes.length < 16) return null;
  if (bytes.length === 2 && bytes[0] === 0x7b && bytes[1] === 0x7d) return null;
  return bytes;
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function secretsEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < Math.max(leftHash.length, rightHash.length); index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1_000,
  )}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function parseJson<T>(request: Request): Promise<T | null> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_AUTH_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_AUTH_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

function normalizedDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const displayName = value.trim();
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) return null;
  return displayName;
}

function transports(value: string): WebAuthnCredential['transports'] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is AuthenticatorTransportFuture =>
            typeof item === 'string' &&
            AUTHENTICATOR_TRANSPORTS.has(item as AuthenticatorTransportFuture),
        )
      : [];
  } catch {
    return [];
  }
}

async function findChallenge(
  env: Env,
  challengeId: string,
  purpose: ChallengeRow['purpose'],
): Promise<ChallengeRow | null> {
  return env.DB.prepare(
    `SELECT id, purpose, challenge, user_id, pending_user_id, pending_email,
            pending_display_name, invitation_id, expires_at, consumed_at
       FROM auth_challenges
      WHERE id = ? AND purpose = ?`,
  )
    .bind(challengeId, purpose)
    .first<ChallengeRow>();
}

async function consumeChallenge(env: Env, challenge: ChallengeRow): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE auth_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(Date.now(), challenge.id, Date.now())
    .run();
  return Boolean(result.meta.changes);
}

export async function createSession(
  env: Env,
  userId: string,
): Promise<{ cookie: string; expiresAt: number }> {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(crypto.randomUUID(), userId, await sha256(token), expiresAt, now, now)
    .run();
  return { cookie: sessionCookie(token), expiresAt };
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  context?: ExecutionContext,
): Promise<AuthContext> {
  const mode = authMode(env);
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return { mode, user: null, sessionId: null };
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.last_seen_at,
            u.email, u.display_name, u.avatar_url
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND u.status = 'active'`,
  )
    .bind(await sha256(token), now)
    .first<SessionRow>();
  if (!row) return { mode, user: null, sessionId: null };
  if (now - Number(row.last_seen_at) >= SESSION_TOUCH_INTERVAL_MS) {
    const touch = env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .bind(now, row.session_id)
      .run();
    if (context) context.waitUntil(touch.then(() => undefined));
    else await touch;
  }
  return { mode, user: userFromSessionRow(row), sessionId: row.session_id };
}

export function isTrustedMutationOrigin(request: Request, env: Env): boolean {
  const configuration = passkeyConfiguration(env);
  return Boolean(configuration && request.headers.get('origin') === configuration.origin);
}

async function sessionResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const auth = await authenticateRequest(request, env, context);
  const configuration = passkeyConfiguration(env);
  const response: AuthSessionResponse = {
    mode: auth.mode,
    authenticated: Boolean(auth.user),
    user: auth.user,
    passkeyConfigured: Boolean(configuration),
    enrollmentConfigured: Boolean(configuration?.enrollmentSecret),
    registrationOpen: Boolean(configuration),
    expectedOrigin: configuration?.origin ?? null,
  };
  return json(response);
}

async function registrationOptions(request: Request, env: Env): Promise<Response> {
  const configuration = passkeyConfiguration(env);
  if (!configuration) return error('设备密钥尚未完成配置', 503);
  if (!isPasskeyMutationOrigin(request, configuration)) return error('请求来源不允许', 403);
  const auth = await authenticateRequest(request, env);
  const body = await parseJson<{
    email?: unknown;
    displayName?: unknown;
    enrollmentSecret?: unknown;
    invitationToken?: unknown;
  }>(request);
  if (!body) return error('请求内容无效或过大', 400);

  let userId: string;
  let email: string;
  let displayName: string;
  let invitationId: string | null = null;
  if (auth.user) {
    userId = auth.user.id;
    email = auth.user.email;
    displayName = auth.user.displayName;
  } else {
    email = normalizedEmail(body.email) ?? '';
    displayName = normalizedDisplayName(body.displayName) ?? '';
    if (!email) return error('请输入有效邮箱', 400);
    if (!displayName) return error('请输入 1–80 个字符的名称', 400);
    if (typeof body.invitationToken === 'string' && body.invitationToken) {
      const invitation = await findRegistrationInvitation(env, body.invitationToken, email);
      if (!invitation) return error('邀请不存在、已撤销或邮箱不匹配', 403);
      invitationId = invitation.id;
    } else if (typeof body.enrollmentSecret === 'string' && body.enrollmentSecret) {
      if (
        !configuration.enrollmentSecret ||
        !(await secretsEqual(body.enrollmentSecret, configuration.enrollmentSecret))
      ) {
        return error('设备登记码无效', 403);
      }
    }
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();
    if (existing) {
      if (await userHasUsablePasskey(env, existing.id)) {
        return error('该邮箱已存在，请先使用已有设备密钥登录', 409);
      }
      userId = existing.id;
    } else {
      userId = crypto.randomUUID();
    }
  }

  const credentials = (
    await env.DB.prepare(
      `SELECT credential_id, public_key, transports_json
         FROM passkey_credentials
        WHERE user_id = ?`,
    )
      .bind(userId)
      .all<{ credential_id: string; public_key: unknown; transports_json: string }>()
  ).results;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: configuration.rpId,
    userID: new TextEncoder().encode(userId),
    userName: email,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials: credentials
      .filter((credential) => decodeStoredPasskeyPublicKey(credential.public_key))
      .map((credential) => ({
        id: credential.credential_id,
        transports: transports(credential.transports_json),
      })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    preferredAuthenticatorType: 'localDevice',
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_challenges(
      id, purpose, challenge, user_id, pending_user_id, pending_email, pending_display_name,
      invitation_id, expires_at, created_at, consumed_at
    ) VALUES (?, 'registration', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      challengeId,
      options.challenge,
      auth.user ? userId : null,
      auth.user ? null : userId,
      auth.user ? null : email,
      auth.user ? null : displayName,
      invitationId,
      now + CHALLENGE_TTL_MS,
      now,
    )
    .run();
  return json({ challengeId, options });
}

async function verifyRegistration(request: Request, env: Env): Promise<Response> {
  const configuration = passkeyConfiguration(env);
  if (!configuration) return error('设备密钥尚未完成配置', 503);
  if (!isPasskeyMutationOrigin(request, configuration)) return error('请求来源不允许', 403);
  const body = await parseJson<{
    challengeId?: unknown;
    response?: RegistrationResponseJSON;
  }>(request);
  if (!body || typeof body.challengeId !== 'string' || !body.response) {
    return error('设备登记响应无效', 400);
  }
  const challenge = await findChallenge(env, body.challengeId, 'registration');
  if (!challenge || challenge.consumed_at !== null || Number(challenge.expires_at) <= Date.now()) {
    return error('设备登记请求已失效，请重试', 409);
  }

  const verification = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: configuration.origin,
    expectedRPID: configuration.rpId,
    requireUserVerification: true,
  }).catch((reason: unknown) => {
    console.error(
      JSON.stringify({
        event: 'passkey_registration_verify_failed',
        level: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
    return null;
  });
  if (!verification?.verified || !verification.registrationInfo) {
    return error('无法验证设备密钥', 401);
  }
  const registration = verification.registrationInfo;
  const credential = registration.credential;
  const authenticated = await authenticateRequest(request, env);
  let userId = challenge.user_id;
  let createsUser = false;
  if (userId) {
    if (!authenticated.user || authenticated.user.id !== userId) {
      return error('当前会话不能为此用户添加设备密钥', 403);
    }
  } else {
    if (!challenge.pending_user_id || !challenge.pending_email || !challenge.pending_display_name) {
      return error('设备登记用户信息缺失', 409);
    }
    userId = challenge.pending_user_id;
    if (
      challenge.invitation_id &&
      !(await registrationInvitationStillValid(
        env,
        challenge.invitation_id,
        challenge.pending_email,
      ))
    ) {
      return error('邀请已失效，请重新获取邀请', 409);
    }
    const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string }>();
    createsUser = !existing;
  }
  if (!userId) return error('设备登记用户信息缺失', 409);
  if (!(await consumeChallenge(env, challenge))) return error('设备登记请求已被使用', 409);
  if (!createsUser && !authenticated.user) {
    await deleteCorruptPasskeys(env, userId);
  }

  const now = Date.now();
  const credentialInsert = env.DB.prepare(
    `INSERT INTO passkey_credentials(
      credential_id, user_id, public_key, counter, transports_json, device_type,
      backed_up, aaguid, label, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    credential.id,
    userId,
    encodePasskeyPublicKey(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    registration.credentialDeviceType,
    registration.credentialBackedUp ? 1 : 0,
    registration.aaguid,
    '设备密钥',
    now,
  );
  try {
    if (createsUser) {
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          `INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
        ).bind(userId, challenge.pending_email, challenge.pending_display_name, now, now),
        credentialInsert,
      ];
      await env.DB.batch(statements);
    } else {
      await credentialInsert.run();
    }
  } catch {
    return error(createsUser ? '邮箱或设备密钥已登记，请直接登录' : '此设备密钥已登记', 409);
  }

  if (createsUser && !challenge.invitation_id) {
    const createdUser = await findUser(env, userId);
    if (createdUser) await provisionPersonalWorkspace(env, createdUser).catch(() => undefined);
  }

  const session = await createSession(env, userId);
  return json(
    { verified: true, user: await findUser(env, userId), expiresAt: session.expiresAt },
    { headers: { 'set-cookie': session.cookie } },
  );
}

async function authenticationOptions(request: Request, env: Env): Promise<Response> {
  const configuration = passkeyConfiguration(env);
  if (!configuration) return error('设备密钥尚未完成配置', 503);
  if (!isPasskeyMutationOrigin(request, configuration)) return error('请求来源不允许', 403);
  const options = await generateAuthenticationOptions({
    rpID: configuration.rpId,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_challenges(
      id, purpose, challenge, user_id, pending_user_id, pending_email, pending_display_name,
      invitation_id, expires_at, created_at, consumed_at
    ) VALUES (?, 'authentication', ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  )
    .bind(challengeId, options.challenge, now + CHALLENGE_TTL_MS, now)
    .run();
  return json({ challengeId, options });
}

async function listStoredPasskeys(
  env: Env,
  userId: string,
): Promise<Array<{ credential_id: string; public_key: unknown }>> {
  return (
    await env.DB.prepare(
      'SELECT credential_id, public_key FROM passkey_credentials WHERE user_id = ?',
    )
      .bind(userId)
      .all<{ credential_id: string; public_key: unknown }>()
  ).results;
}

async function userHasUsablePasskey(env: Env, userId: string): Promise<boolean> {
  const credentials = await listStoredPasskeys(env, userId);
  return credentials.some((credential) => decodeStoredPasskeyPublicKey(credential.public_key));
}

async function deleteCorruptPasskeys(env: Env, userId: string): Promise<void> {
  const credentials = await listStoredPasskeys(env, userId);
  const corrupt = credentials.filter(
    (credential) => !decodeStoredPasskeyPublicKey(credential.public_key),
  );
  if (!corrupt.length) return;
  await env.DB.batch(
    corrupt.map((credential) =>
      env.DB.prepare('DELETE FROM passkey_credentials WHERE credential_id = ?').bind(
        credential.credential_id,
      ),
    ),
  );
}

async function findCredential(env: Env, credentialId: string): Promise<CredentialRow | null> {
  return env.DB.prepare(
    `SELECT c.credential_id, c.user_id, c.public_key, c.counter, c.transports_json,
            c.device_type, c.backed_up,
            u.email, u.display_name, u.avatar_url, u.status
       FROM passkey_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE c.credential_id = ?`,
  )
    .bind(credentialId)
    .first<CredentialRow>();
}

async function findUser(env: Env, userId: string): Promise<AuthUserSummary | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, avatar_url FROM users WHERE id = ? AND status = 'active'`,
  )
    .bind(userId)
    .first<{ id: string; email: string; display_name: string; avatar_url: string | null }>();
  return row
    ? {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      }
    : null;
}

async function verifyAuthentication(request: Request, env: Env): Promise<Response> {
  const configuration = passkeyConfiguration(env);
  if (!configuration) return error('设备密钥尚未完成配置', 503);
  if (!isPasskeyMutationOrigin(request, configuration)) return error('请求来源不允许', 403);
  const body = await parseJson<{
    challengeId?: unknown;
    response?: AuthenticationResponseJSON;
  }>(request);
  if (!body || typeof body.challengeId !== 'string' || !body.response) {
    return error('设备登录响应无效', 400);
  }
  const challenge = await findChallenge(env, body.challengeId, 'authentication');
  if (!challenge || challenge.consumed_at !== null || Number(challenge.expires_at) <= Date.now()) {
    return error('设备登录请求已失效，请重试', 409);
  }
  const stored = await findCredential(env, body.response.id);
  if (!stored || stored.status !== 'active') return error('未找到此设备密钥', 401);
  const publicKey = decodeStoredPasskeyPublicKey(stored.public_key);
  if (!publicKey) {
    return error('此设备密钥数据已损坏，请前往注册页用同一邮箱重新登记', 401);
  }
  const expectedUserHandle = base64Url(new TextEncoder().encode(stored.user_id));
  if (body.response.response.userHandle !== expectedUserHandle) {
    return error('设备密钥用户标识不匹配', 401);
  }
  const credential: WebAuthnCredential = {
    id: stored.credential_id,
    publicKey: Uint8Array.from(publicKey),
    counter: Number(stored.counter),
    transports: transports(stored.transports_json),
  };
  const verification = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: configuration.origin,
    expectedRPID: configuration.rpId,
    credential,
    requireUserVerification: true,
  }).catch((reason: unknown) => {
    console.error(
      JSON.stringify({
        event: 'passkey_authentication_verify_failed',
        level: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
    return null;
  });
  if (!verification?.verified) return error('无法验证设备密钥', 401);
  if (verification.authenticationInfo.credentialDeviceType !== stored.device_type) {
    return error('设备密钥备份属性异常', 401);
  }
  if (!(await consumeChallenge(env, challenge))) return error('设备登录请求已被使用', 409);

  const now = Date.now();
  const updated = await env.DB.prepare(
    `UPDATE passkey_credentials
        SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ?
      WHERE credential_id = ? AND counter = ?`,
  )
    .bind(
      verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialDeviceType,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0,
      now,
      stored.credential_id,
      stored.counter,
    )
    .run();
  if (!updated.meta.changes) return error('设备密钥计数已变化，请重新验证', 409);

  const session = await createSession(env, stored.user_id);
  return json(
    { verified: true, user: await findUser(env, stored.user_id), expiresAt: session.expiresAt },
    { headers: { 'set-cookie': session.cookie } },
  );
}

async function logout(request: Request, env: Env): Promise<Response> {
  const configuration = passkeyConfiguration(env);
  if (!configuration) return error('设备密钥尚未完成配置', 503);
  if (!isPasskeyMutationOrigin(request, configuration)) return error('请求来源不允许', 403);
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
    )
      .bind(Date.now(), await sha256(token))
      .run();
  }
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
}

export async function handleAuthApi(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/session' && request.method === 'GET') {
    return sessionResponse(request, env, context);
  }
  if (path === '/api/auth/passkey/registration/options' && request.method === 'POST') {
    return registrationOptions(request, env);
  }
  if (path === '/api/auth/passkey/registration/verify' && request.method === 'POST') {
    return verifyRegistration(request, env);
  }
  if (path === '/api/auth/passkey/authentication/options' && request.method === 'POST') {
    return authenticationOptions(request, env);
  }
  if (path === '/api/auth/passkey/authentication/verify' && request.method === 'POST') {
    return verifyAuthentication(request, env);
  }
  if (path === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (path.startsWith('/api/auth/')) return error('认证路径不存在', 404);
  return null;
}
