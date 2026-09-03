import { describe, expect, it } from 'vitest';

import { documentContentSecurityPolicy } from './security-headers';

describe('documentContentSecurityPolicy', () => {
  it('allows https images, media, and same-origin frames', () => {
    const policy = documentContentSecurityPolicy();
    expect(policy).toContain("img-src 'self' data: blob: https:");
    expect(policy).toContain("media-src 'self' data: blob: https:");
    expect(policy).toContain("frame-src 'self' https://www.youtube-nocookie.com");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('opens analytics endpoints only when requested', () => {
    const locked = documentContentSecurityPolicy();
    expect(locked).not.toContain('googletagmanager.com');
    const open = documentContentSecurityPolicy({ analytics: true, embeddable: true });
    expect(open).toContain('https://www.googletagmanager.com');
    expect(open).toContain('https://www.google-analytics.com');
    expect(open).toContain('frame-ancestors *');
  });
});
