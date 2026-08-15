import { describe, expect, it } from 'vitest';

import { sanitizeHtmlBlock } from './html-sandbox';

describe('html sandbox', () => {
  it('strips executable markup while keeping layout tags', () => {
    expect(
      sanitizeHtmlBlock(
        '<div class="card" onclick="alert(1)"><script>x()</script><p>你好</p></div>',
      ),
    ).toBe('<div class="card"><p>你好</p></div>');
  });
});
