import { getSchema } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Mathematics } from '@tiptap/extension-mathematics';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { normalizeBookmarkUrl, normalizeEmbedUrl, rdocsEditorBlocks } from './EditorBlocks';
import {
  moveTopLevelBlock,
  removeAttachmentNodes,
  topLevelBlocks,
} from './editor-block-operations';

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
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '左栏' }] }],
            },
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '右栏' }] }],
            },
          ],
        },
        {
          type: 'attachmentFile',
          attrs: {
            attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            byteSize: 100,
            mimeType: 'application/pdf',
            name: '需求.pdf',
          },
        },
        {
          type: 'attachmentAudio',
          attrs: {
            attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            byteSize: 200,
            mimeType: 'audio/mpeg',
            name: '访谈.mp3',
          },
        },
        {
          type: 'attachmentVideo',
          attrs: {
            attachmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            byteSize: 300,
            mimeType: 'video/mp4',
            name: '演示.mp4',
          },
        },
        { type: 'breadcrumb' },
        {
          type: 'pageButton',
          attrs: { action: 'insertText', label: '插入结论', payload: '结论：' },
        },
        {
          type: 'pageLink',
          attrs: {
            pageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            title: '关联页面',
          },
        },
      ],
    });

    expect(() => document.check()).not.toThrow();
    expect(document.toJSON().content).toHaveLength(14);
  });

  it('moves complete top-level blocks without changing their content', () => {
    const schema = getSchema([StarterKit]);
    const document = schema.nodeFromJSON({
      type: 'doc',
      content: ['A', 'B', 'C'].map((text) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }],
      })),
    });
    const state = EditorState.create({ doc: document, schema });
    const firstPosition = topLevelBlocks(state.doc)[0]?.position ?? -1;
    const transaction = moveTopLevelBlock(state, firstPosition, 'down');

    expect(transaction).not.toBeNull();
    const moved = transaction ? state.apply(transaction) : state;
    expect(topLevelBlocks(moved.doc).map((block) => block.node.textContent)).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('removes deleted attachment nodes and keeps required containers valid', () => {
    const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const schema = getSchema([StarterKit, ...rdocsEditorBlocks]);
    const document = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [
                {
                  type: 'attachmentAudio',
                  attrs: {
                    attachmentId,
                    byteSize: 200,
                    mimeType: 'audio/mpeg',
                    name: '访谈.mp3',
                  },
                },
              ],
            },
            { type: 'column', content: [{ type: 'paragraph' }] },
          ],
        },
      ],
    });
    const state = EditorState.create({ doc: document, schema });
    const transaction = removeAttachmentNodes(state, attachmentId);

    expect(transaction).not.toBeNull();
    const updated = transaction ? state.apply(transaction) : state;
    expect(() => updated.doc.check()).not.toThrow();
    expect(JSON.stringify(updated.doc.toJSON())).not.toContain(attachmentId);
    expect(updated.doc.firstChild?.firstChild?.firstChild?.type.name).toBe('paragraph');
  });
});
