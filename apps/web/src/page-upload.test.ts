import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '@rdocs/shared';

import {
  attachmentLimitLabel,
  contentForSyncedEditor,
  validateAttachmentFile,
} from './page-upload';

describe('page uploads', () => {
  it('allows files up to 1 GB and rejects empty or oversized files', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(1024 * 1024 * 1024);
    expect(attachmentLimitLabel()).toBe('1 GB');
    expect(validateAttachmentFile(new File(['x'], 'ok.txt'))).toBeNull();
    expect(validateAttachmentFile(new File([], 'empty.txt'))).toBe('不能上传空文件');
    const huge = new File(['x'], 'huge.bin');
    Object.defineProperty(huge, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    expect(validateAttachmentFile(huge)).toContain('1 GB');
  });

  it('flattens unsupported blocks so synced-block drops do not lose text', () => {
    expect(
      contentForSyncedEditor([
        { type: 'paragraph', content: [{ type: 'text', text: '保留' }] },
        {
          type: 'callout',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '提示内容' }] }],
        },
        { type: 'syncedBlock', attrs: { syncedBlockId: 'x' } },
      ]),
    ).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: '保留' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '提示内容' }] },
      { type: 'paragraph' },
    ]);
  });
});
