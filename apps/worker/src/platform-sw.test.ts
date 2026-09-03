import { describe, expect, it } from 'vitest';

import { serviceWorkerSource } from './platform';

describe('service worker shell', () => {
  it('only intercepts same-origin navigations and ignores extension schemes', () => {
    const source = serviceWorkerSource();
    expect(source).toContain("CACHE='rdocs-shell-v4'");
    expect(source).toContain('url.origin !== self.location.origin');
    expect(source).toContain("request.mode !== 'navigate'");
    expect(source).not.toContain('/assets/');
    expect(source).not.toContain('cache.put(event.request');
  });
});
