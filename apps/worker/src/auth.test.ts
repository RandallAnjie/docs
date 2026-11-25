import { describe, expect, it } from 'vitest';

import {
  accessPolicy,
  handleAuthApi,
  identityAllowed,
  isTrustedMutationOrigin,
  randallFlareIdentity,
} from './auth';
import type { Env } from './env';

function env(overrides: Partial<Env> = {}): Env {
  return { APP_ORIGIN: 'https://docs.example.com', ...overrides } as Env;
}

function signedIn(headers: Record<string, string>): Request {
  return new Request('https://docs.example.com/api/auth/session', { headers });
}

describe('RandallFlare sign-in', () => {
  it('reads the identity the gateway states', () => {
    const identity = randallFlareIdentity(
      signedIn({
        'RF-User-Id': 'cmacct123',
        'RF-User-Username': 'ada',
        'RF-User-Name': encodeURIComponent('Ada 洛芙莱斯'),
        'RF-User-Email': 'Ada@Example.com',
        'RF-User-Member': '1',
      }),
    );
    expect(identity).toEqual({
      id: 'cmacct123',
      email: 'ada@example.com',
      username: 'ada',
      name: 'Ada 洛芙莱斯',
      owner: false,
      member: true,
    });
  });

  it('treats a request without RF-User-Id as anonymous', () => {
    expect(randallFlareIdentity(signedIn({ 'RF-User-Email': 'a@b.c' }))).toBeNull();
    expect(randallFlareIdentity(signedIn({ 'RF-User-Id': '' }))).toBeNull();
  });

  it('counts the owner as a member', () => {
    expect(
      randallFlareIdentity(signedIn({ 'RF-User-Id': 'owner1', 'RF-User-Owner': '1' }))?.member,
    ).toBe(true);
  });

  it('admits only members unless the policy opens Rdocs to every account', () => {
    const outsider = randallFlareIdentity(signedIn({ 'RF-User-Id': 'acct2' }))!;
    const emailVisitor = randallFlareIdentity(
      signedIn({ 'RF-User-Id': 'email:x@y.z', 'RF-User-Email': 'x@y.z' }),
    )!;
    expect(accessPolicy(env())).toBe('members');
    expect(accessPolicy(env({ RF_ACCESS_POLICY: 'ACCOUNTS' }))).toBe('accounts');
    expect(identityAllowed(outsider, 'members')).toBe(false);
    expect(identityAllowed(outsider, 'accounts')).toBe(true);
    expect(identityAllowed(emailVisitor, 'accounts')).toBe(false);
  });

  it('accepts unsafe requests only from the app Origin', () => {
    const post = (origin?: string) =>
      new Request('https://docs.example.com/api/pages', {
        method: 'POST',
        headers: origin ? { origin } : {},
      });
    expect(isTrustedMutationOrigin(post('https://docs.example.com'), env())).toBe(true);
    expect(isTrustedMutationOrigin(post('https://evil.example.com'), env())).toBe(false);
    expect(isTrustedMutationOrigin(post(), env())).toBe(false);
    expect(isTrustedMutationOrigin(post('https://docs.example.com'), env({ APP_ORIGIN: '' }))).toBe(
      false,
    );
  });

  it('reports an anonymous session with the gateway login path', async () => {
    const response = await handleAuthApi(signedIn({}), env());
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      mode: 'randallflare',
      status: 'anonymous',
      authenticated: false,
      loginPath: '/__rf_access/login',
      logoutPath: '/__rf_access/logout',
    });
  });

  it('no longer serves passkey endpoints', async () => {
    const response = await handleAuthApi(
      new Request('https://docs.example.com/api/auth/passkey/authentication/options', {
        method: 'POST',
      }),
      env(),
    );
    expect(response?.status).toBe(404);
  });
});
