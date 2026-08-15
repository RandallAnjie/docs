import { describe, expect, it } from 'vitest';

import { markdownToHtmlDocument, simplePdf, zipStore } from './export-archive';

describe('export archives', () => {
  it('builds a zip that starts with a local file header', () => {
    const zip = zipStore([{ name: 'page.md', body: '# Hello' }]);
    expect(String.fromCharCode(zip[0] ?? 0, zip[1] ?? 0, zip[2] ?? 0, zip[3] ?? 0)).toBe(
      'PK\u0003\u0004',
    );
  });

  it('emits html and pdf payloads', () => {
    expect(markdownToHtmlDocument('标题', '## 小节\n\n**粗体**')).toContain('<h2>小节</h2>');
    expect(new TextDecoder().decode(simplePdf('标题', '正文')).startsWith('%PDF-1.4')).toBe(true);
  });
});
