import { describe, expect, it } from 'vitest';

import { markdownToEditorContent, parseInlineMarkdown } from './ai-markdown';

describe('AI markdown insertion', () => {
  it('parses inline marks used by model output', () => {
    expect(parseInlineMarkdown('先 **加粗** 再 *斜体* 和 `code`')).toEqual([
      { type: 'text', text: '先 ' },
      { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' 再 ' },
      { type: 'text', text: '斜体', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' 和 ' },
      { type: 'text', text: 'code', marks: [{ type: 'code' }] },
    ]);
  });

  it('turns headings, lists, quotes and links into editor nodes', () => {
    const content = markdownToEditorContent(
      [
        '## 标题',
        '',
        '一段 **重点** 和 [文档](https://docs.bigrandall.io)',
        '',
        '- 一项',
        '- 二项',
        '',
        '1. 首先',
        '',
        '> 引用句',
      ].join('\n'),
    );
    expect(content.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'blockquote',
    ]);
    expect(content[0]).toMatchObject({ attrs: { level: 2 } });
    expect(content[1]?.content).toEqual([
      { type: 'text', text: '一段 ' },
      { type: 'text', text: '重点', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' 和 ' },
      {
        type: 'text',
        text: '文档',
        marks: [{ type: 'link', attrs: { href: 'https://docs.bigrandall.io' } }],
      },
    ]);
  });

  it('unwraps a whole-document markdown fence and keeps task items', () => {
    const content = markdownToEditorContent('```markdown\n- [x] 已完成\n- [ ] 待办\n```');
    expect(content).toEqual([
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '已完成' }] }],
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '待办' }] }],
          },
        ],
      },
    ]);
  });
});
