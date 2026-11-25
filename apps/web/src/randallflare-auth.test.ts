import { describe, expect, it } from 'vitest';

import { randallFlareLoginUrl, randallFlareLogoutUrl, returnPath } from './randallflare-auth';

describe('RandallFlare sign-in links', () => {
  it('returns to the page the visitor asked for', () => {
    expect(
      randallFlareLoginUrl({
        pathname: '/p/11111111-1111-4111-8111-111111111111',
        search: '?view=1',
        hash: '#block-1',
      }),
    ).toBe(
      '/__rf_access/login?rd=%2Fp%2F11111111-1111-4111-8111-111111111111%3Fview%3D1%23block-1',
    );
  });

  it('sends the old login and register routes home', () => {
    expect(returnPath({ pathname: '/login', search: '', hash: '' })).toBe('/');
    expect(returnPath({ pathname: '/register/', search: '?x=1', hash: '' })).toBe('/');
  });

  it('never returns to another origin', () => {
    expect(returnPath({ pathname: '//evil.example', search: '', hash: '' })).toBe('/');
  });

  it('signs out back to home', () => {
    expect(randallFlareLogoutUrl()).toBe('/__rf_access/logout?rd=%2F');
  });
});
