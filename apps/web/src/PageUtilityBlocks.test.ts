import { describe, expect, it } from 'vitest';

import { buttonInsertionContent, normalizePageButtonUrl } from './PageUtilityBlocks';

describe('page utility blocks', () => {
  it('normalizes HTTP(S) button destinations and rejects executable protocols', () => {
    expect(normalizePageButtonUrl('docs.bigrandall.io')).toBe('https://docs.bigrandall.io/');
    expect(normalizePageButtonUrl('http://example.com/path')).toBe('http://example.com/path');
    expect(normalizePageButtonUrl('javascript:alert(1)')).toBeNull();
  });

  it('turns each template line into an insertable paragraph', () => {
    expect(buttonInsertionContent('第一段\n\n第三段')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: '第三段' }] },
    ]);
  });

  it('bounds templates before building editor nodes', () => {
    expect(buttonInsertionContent(`${'a'.repeat(10_000)}\nignored`)).toHaveLength(1);
    expect(
      buttonInsertionContent(Array.from({ length: 120 }, () => 'line').join('\n')),
    ).toHaveLength(100);
  });
});
