import { Download, File, FilePlus2, Paperclip, Trash2, Upload } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { AttachmentSummary } from '@rdocs/shared';

import { MAX_ATTACHMENT_BYTES } from '@rdocs/shared';

import { attachmentDownloadUrl, deleteAttachment, listAttachments, uploadAttachment } from './api';
import { confirmDialog } from './dialogs';
import { attachmentLimitLabel, validateAttachmentFile } from './page-upload';

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface AttachmentPanelHandle {
  openPicker: (accept?: string) => void;
}

interface AttachmentPanelProps {
  pageId: string;
  canEdit: boolean;
  onInsert: (attachment: AttachmentSummary) => void;
  onDeleted?: (attachment: AttachmentSummary) => void;
}

export const AttachmentPanel = forwardRef<AttachmentPanelHandle, AttachmentPanelProps>(
  function AttachmentPanel({ pageId, canEdit, onInsert, onDeleted }, ref) {
    const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        setAttachments((await listAttachments(pageId)).attachments);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法加载附件');
      } finally {
        setLoading(false);
      }
    }, [pageId]);

    useEffect(() => {
      void load();
    }, [load]);

    const openPicker = useCallback((accept?: string) => {
      const input = fileInput.current;
      if (!input) return;
      input.accept = accept ?? '';
      input.click();
    }, []);

    useImperativeHandle(ref, () => ({ openPicker }), [openPicker]);

    const selectFile = async (file: File | undefined) => {
      if (!file || uploading) return;
      const invalid = validateAttachmentFile(file);
      if (invalid) {
        setError(invalid);
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const result = await uploadAttachment(pageId, file);
        setAttachments((current) => [result.attachment, ...current]);
        onInsert(result.attachment);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '附件上传失败');
      } finally {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    };

    const remove = async (attachment: AttachmentSummary) => {
      if (
        !(await confirmDialog({
          title: '删除附件',
          message: `从页面中删除“${attachment.originalName}”？`,
          confirmLabel: '删除',
          danger: true,
        }))
      )
        return;
      setError(null);
      try {
        await deleteAttachment(attachment.id);
        setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));
        onDeleted?.(attachment);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法删除附件');
      }
    };

    return (
      <div className="attachment-panel">
        {canEdit ? (
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={(event) => void selectFile(event.target.files?.[0])}
            />
            <button
              className="attachment-upload"
              type="button"
              onClick={() => openPicker()}
              disabled={uploading}
            >
              <Upload size={15} /> {uploading ? '正在上传…' : '上传到附件库'}
              <small>最大 {attachmentLimitLabel(MAX_ATTACHMENT_BYTES)}</small>
            </button>
          </>
        ) : null}
        {error ? (
          <p className="attachment-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="attachment-heading">
          <span>页面附件</span>
          <b>{attachments.length}</b>
        </div>
        {loading ? (
          <div className="attachment-state">
            <span className="mini-spinner" /> 正在读取…
          </div>
        ) : attachments.length ? (
          <ul className="attachment-list">
            {attachments.map((attachment) => (
              <li key={attachment.id}>
                <span>
                  {attachment.mimeType.startsWith('image/') ? (
                    <Paperclip size={15} />
                  ) : (
                    <File size={15} />
                  )}
                </span>
                <div>
                  <strong title={attachment.originalName}>{attachment.originalName}</strong>
                  <small>
                    {byteLabel(attachment.byteSize)} ·{' '}
                    {new Date(attachment.createdAt).toLocaleDateString()}
                  </small>
                </div>
                <a href={attachmentDownloadUrl(attachment.id)} title="下载">
                  <Download size={14} />
                </a>
                {canEdit ? (
                  <>
                    <button type="button" title="插入正文" onClick={() => onInsert(attachment)}>
                      <FilePlus2 size={14} />
                    </button>
                    <button type="button" title="删除" onClick={() => void remove(attachment)}>
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="attachment-state">还没有附件</div>
        )}
      </div>
    );
  },
);
