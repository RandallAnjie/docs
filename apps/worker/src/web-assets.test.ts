import { describe, expect, it } from 'vitest';

import { webHtml } from './generated-web-assets';

describe('embedded web shell', () => {
  it('always has a mount node', () => {
    expect(webHtml).toContain('id="root"');
  });
});
