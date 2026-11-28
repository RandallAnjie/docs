import { describe, expect, it } from 'vitest';

import {
  notionBlocksToMarkdown,
  notionChildEntries,
  notionHostedFiles,
  type NotionBlock,
} from './notion-convert';
import { importSortKey, notionRoots } from './notion-import';
import { markdownToYjsSnapshot } from './markdown';

const entry = (
  id: string,
  type: string,
  parentId: string | null,
  object: 'page' | 'database' = 'page',
) => ({
  id,
  object,
  parent: { type, id: parentId },
  title: id,
  icon: null,
});

describe('notion tree import', () => {
  it('keeps only top-level entries; shared children come with their parents', () => {
    const roots = notionRoots([
      entry('home', 'workspace', null),
      entry('child', 'page_id', 'home'),
      entry('tasks', 'page_id', 'home', 'database'),
      entry('row', 'database_id', 'tasks'),
      entry('orphan', 'page_id', 'not-shared'),
      entry('row-of-unlisted-database', 'database_id', 'beyond-the-search-limit'),
    ]);
    expect(roots.map((root) => root.id)).toEqual(['home', 'orphan']);
  });

  it('keeps Notion order among siblings', () => {
    expect(importSortKey(1_795_000_000_000, 2) < importSortKey(1_795_000_000_000, 10)).toBe(true);
    expect(importSortKey(1_795_000_000_000, 1)).toHaveLength(20);
  });

  const blocks: NotionBlock[] = [
    { id: 'p1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: '介绍' }] } },
    { id: 'sub', type: 'child_page', child_page: { title: '子页面' } },
    {
      id: 'col',
      type: 'column_list',
      has_children: true,
      children: [{ id: 'db', type: 'child_database', child_database: { title: '任务' } }],
    },
    {
      id: 'img',
      type: 'image',
      image: {
        type: 'file',
        file: { url: 'https://s3.example/a/%E5%9B%BE.png?sig=1' },
        caption: [],
      },
    },
    {
      id: 'ext',
      type: 'image',
      image: { type: 'external', external: { url: 'https://x.test/b.png' } },
    },
  ];

  it('finds child pages and databases anywhere, in order', () => {
    expect(notionChildEntries(blocks)).toEqual([
      { id: 'sub', kind: 'page', title: '子页面' },
      { id: 'db', kind: 'database', title: '任务' },
    ]);
  });

  it('copies only Notion-hosted files', () => {
    expect(notionHostedFiles(blocks)).toEqual([
      { url: 'https://s3.example/a/%E5%9B%BE.png?sig=1', name: '图.png', type: 'image' },
    ]);
  });

  it('links children and copied files in the body', () => {
    const markdown = notionBlocksToMarkdown(blocks, 0, {
      childPages: new Map([
        ['sub', { pageId: '11111111-1111-4111-8111-111111111111', title: '子页面' }],
        ['db', { pageId: '22222222-2222-4222-8222-222222222222', title: '任务' }],
      ]),
      files: new Map([
        [
          'https://s3.example/a/%E5%9B%BE.png?sig=1',
          { attachmentId: '33333333-3333-4333-8333-333333333333', name: '图.png' },
        ],
      ]),
    });
    expect(markdown).toContain('<!-- rdocs:page-link:11111111-1111-4111-8111-111111111111:');
    expect(markdown).toContain('<!-- rdocs:page-link:22222222-2222-4222-8222-222222222222:');
    expect(markdown).toContain('![图片](/api/attachments/33333333-3333-4333-8333-333333333333)');
    expect(markdown).toContain('![图片](https://x.test/b.png)');
    // The importer turns these into page links and an image.
    const imported = markdownToYjsSnapshot(markdown);
    expect(imported.plainText).toContain('介绍');
  });
});
