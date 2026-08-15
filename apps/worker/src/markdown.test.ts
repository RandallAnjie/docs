import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

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
      `![架构图](/api/attachments/${sourceId})\n\n[📎 需求.pdf](/api/attachments/${sourceId})\n\n![外部图](https://example.com/keep.png)`,
    );
    const rewritten = rewriteYjsAttachmentReferences(
      imported.snapshot,
      new Map([[sourceId, targetId]]),
    );
    const exported = yjsSnapshotToMarkdown(rewritten);
    expect(exported).toContain(`/api/attachments/${targetId}`);
    expect(exported).not.toContain(sourceId);
    expect(exported).toContain(`[📎 需求.pdf](/api/attachments/${targetId})`);
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

<!-- rdocs:breadcrumb -->

<!-- rdocs:synced-block:dddddddd-dddd-4ddd-8ddd-dddddddddddd -->

<!-- rdocs:page-link:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:%E9%A1%B9%E7%9B%AE%2D%E8%AE%A1%E5%88%92 -->

[⚡ 插入结论](rdocs-button:insertText?payload=%E7%BB%93%E8%AE%BA%EF%BC%9A)

[⚡ 打开 Rdocs](rdocs-button:openUrl?payload=https%3A%2F%2Fdocs.bigrandall.io%2F)

[📎 需求.pdf](/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)

[🎵 访谈.mp3](/api/attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb)

[🎬 演示.mp4](/api/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc)

<!-- rdocs:columns:start -->
<!-- rdocs:column -->
左栏内容

<!-- rdocs:column -->
右栏内容
<!-- rdocs:columns:end -->

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
    expect(exported).toContain('<!-- rdocs:breadcrumb -->');
    expect(exported).toContain('<!-- rdocs:synced-block:dddddddd-dddd-4ddd-8ddd-dddddddddddd -->');
    expect(exported).toContain(
      '<!-- rdocs:page-link:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:%E9%A1%B9%E7%9B%AE%2D%E8%AE%A1%E5%88%92 -->',
    );
    expect(exported).toContain(
      '[⚡ 插入结论](rdocs-button:insertText?payload=%E7%BB%93%E8%AE%BA%EF%BC%9A)',
    );
    expect(exported).toContain(
      '[⚡ 打开 Rdocs](rdocs-button:openUrl?payload=https%3A%2F%2Fdocs.bigrandall.io%2F)',
    );
    expect(exported).toContain(
      '[📎 需求.pdf](/api/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)',
    );
    expect(exported).toContain(
      '[🎵 访谈.mp3](/api/attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb)',
    );
    expect(exported).toContain(
      '[🎬 演示.mp4](/api/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc)',
    );
    expect(exported).toContain('<!-- rdocs:columns:start -->');
    expect(exported).toContain('左栏内容');
    expect(exported).toContain('右栏内容');
    expect(exported).toContain('$$\nE = mc^2\n$$');
  });

  it('保留文件块名称中的 Markdown 转义字符', () => {
    const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const source = `[📎 需求\\\\终稿\\].pdf](/api/attachments/${attachmentId})`;

    expect(yjsSnapshotToMarkdown(markdownToYjsSnapshot(source).snapshot)).toContain(source);
  });

  it('exports a recoverable synced-block deletion as an explicit note', () => {
    const document = new Y.Doc();
    const placeholder = new Y.XmlElement('deletedSyncedBlock');
    placeholder.setAttribute('syncedBlockId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    placeholder.setAttribute('deletionOperationId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    document.getXmlFragment('default').insert(0, [placeholder]);

    expect(yjsSnapshotToMarkdown(Y.encodeStateAsUpdate(document))).toContain(
      '已删除的同步块（可在 Rdocs 中于 30 天内整体撤销）',
    );
    document.destroy();
  });
});
