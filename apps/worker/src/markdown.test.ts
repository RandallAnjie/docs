import { describe, expect, it } from 'vitest';

import {
  markdownToYjsSnapshot,
  rewriteYjsAttachmentReferences,
  yjsSnapshotToMarkdown,
} from './markdown';

describe('Markdown import and export', () => {
  it('preserves headings, paragraphs, lists, quotes and code blocks', () => {
    const source = `# Rdocs\n\n协作文档\n\n- 第一项\n- 第二项\n\n- [ ] 待办\n- [x] 已完成\n\n| 项目 | 负责人 |\n| --- | --- |\n| Rdocs | Randall |\n\n> 提示\n\n\`\`\`ts\nconst ok = true\n\`\`\``;
    const imported = markdownToYjsSnapshot(source);
    expect(imported.title).toBe('Rdocs');
    const exported = yjsSnapshotToMarkdown(imported.snapshot);
    expect(exported).toContain('# Rdocs');
    expect(exported).toContain('- 第一项');
    expect(exported).toContain('> 提示');
    expect(exported).toContain('```ts');
    expect(exported).toContain('- [ ] 待办');
    expect(exported).toContain('- [x] 已完成');
    expect(exported).toContain('| 项目 | 负责人 |');
  });

  it('rewrites private attachment references when a page is copied', () => {
    const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const imported = markdownToYjsSnapshot(
      `![架构图](/api/attachments/${sourceId})\n\n![外部图](https://example.com/keep.png)`,
    );
    const rewritten = rewriteYjsAttachmentReferences(
      imported.snapshot,
      new Map([[sourceId, targetId]]),
    );
    const exported = yjsSnapshotToMarkdown(rewritten);
    expect(exported).toContain(`/api/attachments/${targetId}`);
    expect(exported).not.toContain(sourceId);
    expect(exported).toContain('https://example.com/keep.png');
  });
});
