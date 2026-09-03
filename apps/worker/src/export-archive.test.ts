import { describe, expect, it } from 'vitest';

import { markdownToHtmlDocument, simplePdf, unzipEntries, zipStore } from './export-archive';

describe('export archives', () => {
  it('round-trips a stored zip entry', async () => {
    const zip = zipStore([{ name: 'page.md', body: '# Hello' }]);
    expect(String.fromCharCode(zip[0] ?? 0, zip[1] ?? 0, zip[2] ?? 0, zip[3] ?? 0)).toBe(
      'PK\u0003\u0004',
    );
    await expect(unzipEntries(zip)).resolves.toEqual([{ name: 'page.md', body: '# Hello' }]);
  });

  it('emits html and pdf payloads', () => {
    const html = markdownToHtmlDocument('标题', '## 小节\n\n**粗体**\n\n- 一项');
    expect(html).toContain('<h2>小节</h2>');
    expect(html).toContain('<p><strong>粗体</strong></p>');
    expect(html).toContain('<ul><li>一项</li></ul>');
    expect(html).not.toMatch(/<p>\s*<h2/);
    expect(html).not.toMatch(/<p>\s*<ul/);
    expect(new TextDecoder().decode(simplePdf('标题', '正文')).startsWith('%PDF-1.4')).toBe(true);
  });
});
