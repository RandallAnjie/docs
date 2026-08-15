import type { Editor } from '@tiptap/core';
import type { AttachmentSummary } from '@rdocs/shared';
import { MAX_ATTACHMENT_BYTES } from '@rdocs/shared';

import { attachmentDownloadUrl } from './api';

export function attachmentLimitLabel(bytes = MAX_ATTACHMENT_BYTES): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024 * 1024))} GB`
    : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function acceptForAttachmentKind(kind: 'audio' | 'file' | 'image' | 'video'): string {
  if (kind === 'audio') return 'audio/*';
  if (kind === 'image') return 'image/*';
  if (kind === 'video') return 'video/*';
  return '';
}

export function pickLocalFiles(accept = '', multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener(
      'change',
      () => {
        resolve([...(input.files ?? [])]);
        input.remove();
      },
      { once: true },
    );
    input.addEventListener(
      'cancel',
      () => {
        resolve([]);
        input.remove();
      },
      { once: true },
    );
    input.click();
  });
}

export function filesFromDataTransfer(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  if (transfer.files.length) return [...transfer.files];
  return [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export function validateAttachmentFile(file: File): string | null {
  if (!file.size) return '不能上传空文件';
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `“${file.name}”超过 ${attachmentLimitLabel()} 上限`;
  }
  return null;
}

export function attachmentInsertContent(attachment: AttachmentSummary) {
  if (attachment.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      attrs: {
        src: attachmentDownloadUrl(attachment.id),
        alt: attachment.originalName,
        title: attachment.originalName,
      },
    };
  }
  const attrs = {
    attachmentId: attachment.id,
    byteSize: attachment.byteSize,
    mimeType: attachment.mimeType,
    name: attachment.originalName,
  };
  if (attachment.mimeType.startsWith('audio/')) return { type: 'attachmentAudio', attrs };
  if (attachment.mimeType.startsWith('video/')) return { type: 'attachmentVideo', attrs };
  return { type: 'attachmentFile', attrs };
}

export function insertAttachments(editor: Editor, attachments: readonly AttachmentSummary[]) {
  if (!attachments.length || !editor.isEditable) return;
  editor
    .chain()
    .focus()
    .insertContent(attachments.map((attachment) => attachmentInsertContent(attachment)))
    .run();
}

const SYNCED_BLOCK_TYPES = new Set([
  'blockquote',
  'bulletList',
  'codeBlock',
  'hardBreak',
  'heading',
  'horizontalRule',
  'image',
  'listItem',
  'orderedList',
  'paragraph',
  'table',
  'tableCell',
  'tableHeader',
  'tableRow',
  'taskItem',
  'taskList',
  'text',
]);

function nodeText(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text;
  const content = node.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((child) =>
      child && typeof child === 'object' ? nodeText(child as Record<string, unknown>) : '',
    )
    .join('');
}

export function contentForSyncedEditor(
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const node of nodes) {
    const type = typeof node.type === 'string' ? node.type : '';
    if (type === 'syncedBlock' || type === 'deletedSyncedBlock') {
      const inner = Array.isArray(node.content)
        ? contentForSyncedEditor(node.content as Record<string, unknown>[])
        : [];
      result.push(...(inner.length ? inner : [{ type: 'paragraph' }]));
      continue;
    }
    if (!SYNCED_BLOCK_TYPES.has(type)) {
      const text = nodeText(node).trim();
      result.push(
        text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' },
      );
      continue;
    }
    const content = Array.isArray(node.content)
      ? contentForSyncedEditor(node.content as Record<string, unknown>[])
      : undefined;
    result.push(content ? { ...node, content } : { ...node });
  }
  return result.length ? result : [{ type: 'paragraph' }];
}

export function draggingNodeJson(editor: Editor): Record<string, unknown>[] | null {
  const dragging = editor.view.dragging as
    { slice?: { content?: { toJSON?: () => unknown } } } | null | undefined;
  const json = dragging?.slice?.content?.toJSON?.();
  if (!Array.isArray(json) || !json.length) return null;
  return json.filter(
    (node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object',
  );
}
