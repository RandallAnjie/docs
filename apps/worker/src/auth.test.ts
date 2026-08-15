import { describe, expect, it } from 'vitest';

import { authMode, handleAuthApi, isTrustedMutationOrigin } from './auth';
import type { Env } from './env';

function env(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_MODE: 'passkey',
    PASSKEY_RP_ID: 'docs.example.com',
    PASSKEY_ORIGIN: 'https://docs.example.com',
    PASSKEY_ENROLLMENT_SECRET: 'a-secure-enrollment-secret-with-32-chars',
    ...overrides,
  } as Env;
}

describe('passkey authentication configuration', () => {
  it('only enables anonymous Phase 0 mode explicitly', () => {
    expect(authMode(env({ AUTH_MODE: 'phase0' }))).toBe('phase0');
    expect(authMode(env({ AUTH_MODE: 'passkey' }))).toBe('passkey');
    expect(authMode(env({ AUTH_MODE: undefined }))).toBe('passkey');
    expect(authMode(env({ AUTH_MODE: 'typo' }))).toBe('passkey');
  });

  it('accepts unsafe requests only from the configured RP origin', () => {
    expect(
      isTrustedMutationOrigin(
        new Request('https://docs.example.com/api/pages', {
          method: 'POST',
          headers: { origin: 'https://docs.example.com' },
        }),
        env(),
      ),
    ).toBe(true);
    expect(
      isTrustedMutationOrigin(
        new Request('https://preview.example.com/api/pages', {
          method: 'POST',
          headers: { origin: 'https://docs.example.com' },
        }),
        env(),
      ),
    ).toBe(false);
    expect(
      isTrustedMutationOrigin(
        new Request('https://docs.example.com/api/pages', { method: 'POST' }),
        env(),
      ),
    ).toBe(false);
  });

  it('fails closed when the relying-party settings are incomplete', () => {
    const request = new Request('https://docs.example.com/api/pages', {
      method: 'POST',
      headers: { origin: 'https://docs.example.com' },
    });
    expect(isTrustedMutationOrigin(request, env({ PASSKEY_ORIGIN: undefined }))).toBe(false);
    expect(isTrustedMutationOrigin(request, env({ PASSKEY_RP_ID: 'other.example.com' }))).toBe(
      false,
    );
  });

  it('does not make existing login depend on the enrollment secret', () => {
    const request = new Request('https://docs.example.com/api/pages', {
      method: 'POST',
      headers: { origin: 'https://docs.example.com' },
    });
    expect(isTrustedMutationOrigin(request, env({ PASSKEY_ENROLLMENT_SECRET: undefined }))).toBe(
      true,
    );
  });

  it('keeps existing Phase 0 smoke requests compatible', () => {
    expect(
      isTrustedMutationOrigin(
        new Request('https://preview.example.com/api/pages', { method: 'POST' }),
        env({ AUTH_MODE: 'phase0' }),
      ),
    ).toBe(true);
  });

  it('allows only the passkey registration bootstrap endpoint during Phase 0', async () => {
    const bootstrap = await handleAuthApi(
      new Request('https://docs.example.com/api/auth/passkey/registration/options', {
        method: 'POST',
        headers: { origin: 'https://docs.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env({ AUTH_MODE: 'phase0' }),
      {} as ExecutionContext,
    );
    expect(bootstrap?.status).toBe(400);

    const login = await handleAuthApi(
      new Request('https://docs.example.com/api/auth/passkey/authentication/options', {
        method: 'POST',
        headers: { origin: 'https://docs.example.com' },
      }),
      env({ AUTH_MODE: 'phase0' }),
      {} as ExecutionContext,
    );
    expect(login?.status).toBe(409);

    const wrongOrigin = await handleAuthApi(
      new Request('https://docs.example.com/api/auth/passkey/registration/options', {
        method: 'POST',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env({ AUTH_MODE: 'phase0' }),
      {} as ExecutionContext,
    );
    expect(wrongOrigin?.status).toBe(403);
  });

  it('reports enrollment separately from passkey login configuration', async () => {
    const response = await handleAuthApi(
      new Request('https://docs.example.com/api/auth/session'),
      env({ PASSKEY_ENROLLMENT_SECRET: undefined }),
      {} as ExecutionContext,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      mode: 'passkey',
      authenticated: false,
      passkeyConfigured: true,
      enrollmentConfigured: false,
      expectedOrigin: 'https://docs.example.com',
    });
  });
});
