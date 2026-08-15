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
  it('never re-enables anonymous mode from configuration', () => {
    expect(authMode(env({ AUTH_MODE: 'phase0' }))).toBe('passkey');
    expect(authMode(env({ AUTH_MODE: 'passkey' }))).toBe('passkey');
    expect(authMode(env({ AUTH_MODE: undefined }))).toBe('passkey');
    expect(authMode(env({ AUTH_MODE: 'typo' }))).toBe('passkey');
  });

  it('accepts unsafe requests only from the configured browser Origin', () => {
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
    ).toBe(true);
    expect(
      isTrustedMutationOrigin(
        new Request('https://docs.example.com/api/pages', {
          method: 'POST',
          headers: { origin: 'https://preview.example.com' },
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

  it('does not let a legacy Phase 0 value bypass Origin checks', () => {
    expect(
      isTrustedMutationOrigin(
        new Request('https://preview.example.com/api/pages', { method: 'POST' }),
        env({ AUTH_MODE: 'phase0' }),
      ),
    ).toBe(false);
  });

  it('keeps passkey registration fail-closed for legacy Phase 0 configuration', async () => {
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

    const forwardedUrl = await handleAuthApi(
      new Request('https://worker.internal/api/auth/passkey/registration/options', {
        method: 'POST',
        headers: { origin: 'https://docs.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env({ AUTH_MODE: 'phase0' }),
      {} as ExecutionContext,
    );
    expect(forwardedUrl?.status).toBe(400);
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
      registrationOpen: true,
      expectedOrigin: 'https://docs.example.com',
    });
  });
});
