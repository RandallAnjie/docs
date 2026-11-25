import { describe, expect, it } from 'vitest';

import {
  notionBlocksToMarkdown,
  notionDatabaseSchema,
  notionValueToRdocs,
  planRdocsProperties,
  rdocsValueToNotion,
  type NotionBlock,
} from './notion-convert';

const text = (content: string, annotations = {}, href: string | null = null) => ({
  plain_text: content,
  annotations,
  href,
});

describe('Notion database schema', () => {
  const database = {
    title: [text('项目')],
    properties: {
      状态: { type: 'status', status: { options: [{ name: '未开始' }, { name: '完成' }] } },
      名称: { type: 'title', title: {} },
      标签: { type: 'multi_select', multi_select: { options: [{ name: 'A' }] } },
      创建时间: { type: 'created_time', created_time: {} },
      负责人: { type: 'people', people: {} },
      按钮: { type: 'button', button: {} },
    },
  };

  it('puts the title first and keeps options', () => {
    const schema = notionDatabaseSchema(database);
    expect(schema[0]).toEqual({ name: '名称', type: 'title', options: [] });
    expect(schema.find((item) => item.name === '状态')?.options).toEqual(['未开始', '完成']);
  });

  it('maps Notion types to Rdocs fields and skips unsupported ones', () => {
    const plan = planRdocsProperties(notionDatabaseSchema(database));
    expect(plan.map((item) => [item.name, item.type])).toEqual([
      ['名称', 'title'],
      ['状态', 'status'],
      ['标签', 'multi_select'],
      ['创建时间', 'date'],
      ['负责人', 'text'],
    ]);
    expect(plan.find((item) => item.name === '状态')?.config).toEqual({
      options: ['未开始', '完成'],
    });
    expect(plan.find((item) => item.name === '创建时间')?.config).toEqual({ includeTime: true });
  });
});

describe('Notion values', () => {
  it('converts common property values', () => {
    expect(notionValueToRdocs({ type: 'title', title: [text('发布'), text(' v2')] })).toBe(
      '发布 v2',
    );
    expect(notionValueToRdocs({ type: 'status', status: { name: '完成' } })).toBe('完成');
    expect(notionValueToRdocs({ type: 'select', select: null })).toBeNull();
    expect(
      notionValueToRdocs({ type: 'multi_select', multi_select: [{ name: 'A' }, { name: 'B' }] }),
    ).toEqual(['A', 'B']);
    expect(notionValueToRdocs({ type: 'checkbox', checkbox: true })).toBe(true);
    expect(notionValueToRdocs({ type: 'date', date: { start: '2026-11-20', end: null } })).toEqual({
      start: '2026-11-20T00:00:00.000Z',
      end: null,
      includeTime: false,
    });
    expect(
      notionValueToRdocs({ type: 'date', date: { start: '2026-11-20T09:00:00.000+08:00' } }),
    ).toEqual({
      start: '2026-11-20T01:00:00.000Z',
      end: null,
      includeTime: true,
    });
    expect(
      notionValueToRdocs({
        type: 'people',
        people: [{ name: 'Ada' }, { person: { email: 'b@x.io' } }],
      }),
    ).toBe('Ada、b@x.io');
    expect(notionValueToRdocs({ type: 'formula', formula: { type: 'number', number: 3 } })).toBe(
      '3',
    );
    expect(
      notionValueToRdocs({ type: 'unique_id', unique_id: { prefix: 'TASK', number: 7 } }),
    ).toBe('TASK-7');
    expect(notionValueToRdocs({ type: 'button', button: {} })).toBeNull();
  });
});

describe('Notion blocks to Markdown', () => {
  it('converts headings, lists, todos, code, callouts, tables and nested items', () => {
    const blocks: NotionBlock[] = [
      { type: 'heading_1', heading_1: { rich_text: [text('计划')] } },
      {
        type: 'paragraph',
        paragraph: {
          rich_text: [text('重点', { bold: true }), text('：'), text('链接', {}, 'https://x.io')],
        },
      },
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [text('一')] },
        children: [
          { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [text('一.1')] } },
        ],
      },
      { type: 'numbered_list_item', numbered_list_item: { rich_text: [text('甲')] } },
      { type: 'numbered_list_item', numbered_list_item: { rich_text: [text('乙')] } },
      { type: 'to_do', to_do: { rich_text: [text('完成')], checked: true } },
      { type: 'code', code: { language: 'javascript', rich_text: [text('let a = 1;')] } },
      { type: 'callout', callout: { rich_text: [text('注意')], icon: { emoji: '⚠️' } } },
      {
        type: 'table',
        table: {},
        children: [
          { type: 'table_row', table_row: { cells: [[text('名')], [text('值')]] } },
          { type: 'table_row', table_row: { cells: [[text('a|b')], [text('1')]] } },
        ],
      },
      { type: 'image', image: { type: 'file', file: { url: 'https://s3/x.png' }, caption: [] } },
      {
        type: 'image',
        image: { type: 'external', external: { url: 'https://cdn/y.png' }, caption: [text('图')] },
      },
    ];
    expect(notionBlocksToMarkdown(blocks)).toBe(
      [
        '## 计划',
        '',
        '**重点**：[链接](https://x.io)',
        '',
        '- 一',
        '  - 一.1',
        '1. 甲',
        '2. 乙',
        '- [x] 完成',
        '```javascript',
        'let a = 1;',
        '```',
        '',
        '> [!NOTE] ⚠️ 注意',
        '',
        '| 名 | 值 |',
        '| --- | --- |',
        '| a\\|b | 1 |',
        '',
        '[🖼 图片（Notion 托管文件，请重新上传）](https://s3/x.png)',
        '',
        '![图](https://cdn/y.png)',
      ].join('\n'),
    );
  });
});

describe('Rdocs values to Notion', () => {
  it('builds Notion property payloads by type', () => {
    expect(rdocsValueToNotion('title', '发布 v2')).toEqual({
      title: [{ type: 'text', text: { content: '发布 v2' } }],
    });
    expect(rdocsValueToNotion('number', '1,200')).toEqual({ number: 1200 });
    expect(rdocsValueToNotion('number', '')).toEqual({ number: null });
    expect(rdocsValueToNotion('status', '完成')).toEqual({ status: { name: '完成' } });
    expect(rdocsValueToNotion('multi_select', ['A', 'B,C'])).toEqual({
      multi_select: [{ name: 'A' }, { name: 'B C' }],
    });
    expect(
      rdocsValueToNotion('date', {
        start: '2026-11-20T00:00:00.000Z',
        end: null,
        includeTime: false,
      }),
    ).toEqual({ date: { start: '2026-11-20' } });
    expect(rdocsValueToNotion('checkbox', '是')).toEqual({ checkbox: true });
    expect(rdocsValueToNotion('formula', 'x')).toBeUndefined();
  });
});

describe('Notion ids', () => {
  it('reads the page id from links, not the view id', async () => {
    const { normalizeNotionId } = await import('./notion');
    expect(
      normalizeNotionId(
        `https://www.notion.so/acme/Tasks-11112222333344445555666677778888?v=${'f'.repeat(32)}`,
      ),
    ).toBe('11112222-3333-4444-5555-666677778888');
    expect(normalizeNotionId('11112222-3333-4444-5555-666677778888')).toBe(
      '11112222-3333-4444-5555-666677778888',
    );
    expect(normalizeNotionId('nope')).toBeNull();
  });
});
