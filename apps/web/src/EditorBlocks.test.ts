import { getSchema } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Mathematics } from '@tiptap/extension-mathematics';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { normalizeBookmarkUrl, normalizeEmbedUrl, rdocsEditorBlocks } from './EditorBlocks';

describe('editor block URL normalization', () => {
  it('accepts HTTP(S) bookmarks and rejects executable protocols', () => {
    expect(normalizeBookmarkUrl('docs.bigrandall.io')).toBe('https://docs.bigrandall.io/');
    expect(normalizeBookmarkUrl('http://example.com/path')).toBe('http://example.com/path');
    expect(normalizeBookmarkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBookmarkUrl('data:text/html,hello')).toBeNull();
  });

  it('converts YouTube links to privacy-enhanced embeds', () => {
    expect(normalizeEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      originalUrl: 'https://youtu.be/dQw4w9WgXcQ',
      provider: 'YouTube',
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
  });

  it('allows supported HTTPS providers and rejects arbitrary or insecure frames', () => {
    expect(normalizeEmbedUrl('https://www.figma.com/design/abc/Rdocs')?.provider).toBe('Figma');
    expect(normalizeEmbedUrl('https://www.loom.com/share/abc123')?.src).toBe(
      'https://www.loom.com/embed/abc123',
    );
    expect(normalizeEmbedUrl('https://example.com/embed')).toBeNull();
    expect(normalizeEmbedUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('builds a valid collaborative schema for every new persisted block', () => {
    const schema = getSchema([
      StarterKit,
      Details,
      DetailsSummary,
      DetailsContent,
      Mathematics,
      ...rdocsEditorBlocks,
    ]);
    const document = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { icon: '💡', tone: 'gray' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '提示' }] }],
        },
        {
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: '详情' }] },
            { type: 'detailsContent', content: [{ type: 'paragraph' }] },
          ],
        },
        { type: 'tableOfContents' },
        {
          type: 'bookmark',
          attrs: { title: 'Rdocs', url: 'https://docs.bigrandall.io/' },
        },
        {
          type: 'embed',
          attrs: {
            originalUrl: 'https://youtu.be/dQw4w9WgXcQ',
            provider: 'YouTube',
            src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
          },
        },
        { type: 'blockMath', attrs: { latex: 'E = mc^2' } },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '行内公式 ' },
            { type: 'inlineMath', attrs: { latex: 'x^2' } },
          ],
        },
      ],
    });

    expect(() => document.check()).not.toThrow();
    expect(document.toJSON().content).toHaveLength(7);
  });
});
