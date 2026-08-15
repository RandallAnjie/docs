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

  it('round-trips Rdocs callouts, toggles, bookmarks, embeds, formulas and table of contents', () => {
    const source = `> [!NOTE] 💡 这是一条重要提示

<details>
<summary>查看详细步骤</summary>

先完成设备密钥登录
</details>

[🔖 Rdocs](https://docs.bigrandall.io/)

[▶ YouTube 嵌入](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

<!-- rdocs:table-of-contents -->

$$
E = mc^2
$$`;
    const imported = markdownToYjsSnapshot(source);
    const exported = yjsSnapshotToMarkdown(imported.snapshot);

    expect(exported).toContain('> [!NOTE] 💡 这是一条重要提示');
    expect(exported).toContain('<summary>查看详细步骤</summary>');
    expect(exported).toContain('[🔖 Rdocs](https://docs.bigrandall.io/)');
    expect(exported).toContain('[▶ YouTube 嵌入](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
    expect(exported).toContain('<!-- rdocs:table-of-contents -->');
    expect(exported).toContain('$$\nE = mc^2\n$$');
  });
});
