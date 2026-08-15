import { Eye, RotateCcw, Save, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { RevisionKind, RevisionSummary } from '@rdocs/shared';

import { createRevision, getRevisionSnapshot, listRevisions, restoreRevision } from './api';
import { confirmDialog } from './dialogs';
import { diffRevisionLines, textFromYjsSnapshot, type RevisionDiffLine } from './revision-diff';

const revisionDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const revisionKindLabels: Record<RevisionKind, string> = {
  automatic: '自动版本',
  manual: '手动版本',
  restore: '恢复前版本',
  pre_delete: '删除前版本',
  pre_export: '导出前版本',
};

export function RevisionPanel({
  pageId,
  flushDocument,
  getCurrentSnapshot,
}: {
  pageId: string;
  flushDocument: () => Promise<void>;
  getCurrentSnapshot: () => Uint8Array | null;
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState<{
    revisionId: string;
    idempotencyKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    revision: RevisionSummary;
    text: string;
    diff: RevisionDiffLine[];
  } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listRevisions(pageId);
      setRevisions(response.revisions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取历史版本');
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveVersion = async () => {
    if (creating || restoringId) return;
    setCreating(true);
    setError(null);
    try {
      await flushDocument();
      const response = await createRevision(pageId, label);
      setRevisions((current) => [response.revision, ...current]);
      setLabel('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建版本');
    } finally {
      setCreating(false);
    }
  };

  const restore = async (revision: RevisionSummary) => {
    if (creating || restoringId) return;
    const name = revision.label || revisionKindLabels[revision.kind];
    if (
      !(await confirmDialog({
        title: '恢复版本',
        message: `恢复到“${name}”？当前内容会先自动保存为一个新版本。`,
        confirmLabel: '恢复此版本',
      }))
    )
      return;

    setRestoringId(revision.id);
    setError(null);
    const attempt =
      restoreAttempt?.revisionId === revision.id
        ? restoreAttempt
        : { revisionId: revision.id, idempotencyKey: crypto.randomUUID() };
    setRestoreAttempt(attempt);
    try {
      await flushDocument();
      await restoreRevision(revision.id, attempt.idempotencyKey);
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复版本');
      setRestoringId(null);
    }
  };

  const showPreview = async (revision: RevisionSummary) => {
    if (previewLoadingId) return;
    setPreviewLoadingId(revision.id);
    setError(null);
    try {
      const snapshot = await getRevisionSnapshot(revision.id);
      const text = textFromYjsSnapshot(snapshot);
      const currentSnapshot = getCurrentSnapshot();
      const currentText = currentSnapshot ? textFromYjsSnapshot(currentSnapshot) : '';
      setPreview({ revision, text, diff: diffRevisionLines(text, currentText) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法预览此版本');
    } finally {
      setPreviewLoadingId(null);
    }
  };

  return (
    <div className="revision-panel">
      <section className="revision-create">
        <strong>保存当前版本</strong>
        <p>版本会保存完整正文，不会把每次按键展示成历史记录。</p>
        <input
          value={label}
          maxLength={100}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveVersion();
          }}
          placeholder="版本名称（可选）"
          aria-label="版本名称"
        />
        <button
          type="button"
          onClick={() => void saveVersion()}
          disabled={creating || !!restoringId}
        >
          {creating ? <span className="mini-spinner" /> : <Save size={14} />}
          {creating ? '正在保存…' : '创建版本'}
        </button>
      </section>

      {error ? (
        <div className="revision-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      <div className="revision-heading">
        <span>版本记录</span>
        <b>{revisions.length}</b>
      </div>
      {preview ? (
        <section className="revision-preview">
          <header>
            <div>
              <strong>{preview.revision.label || revisionKindLabels[preview.revision.kind]}</strong>
              <span>与当前内容对比</span>
            </div>
            <button type="button" onClick={() => setPreview(null)} aria-label="关闭预览">
              <X size={14} />
            </button>
          </header>
          <div className="revision-diff" aria-label="版本差异">
            {preview.diff.length ? (
              preview.diff.map((line, index) => (
                <div className={line.kind} key={`${index}-${line.text}`}>
                  <span>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
                  <code>{line.text || ' '}</code>
                </div>
              ))
            ) : (
              <p>此版本与当前内容相同。</p>
            )}
          </div>
          <details>
            <summary>查看该版本纯文本</summary>
            <pre>{preview.text || '（空文档）'}</pre>
          </details>
        </section>
      ) : null}
      {loading ? (
        <div className="revision-state">
          <span className="mini-spinner" /> 正在读取版本…
        </div>
      ) : revisions.length === 0 ? (
        <div className="revision-state">还没有版本，先保存一个当前版本。</div>
      ) : (
        <ol className="revision-list">
          {revisions.map((revision) => (
            <li key={revision.id}>
              <div className="revision-dot" />
              <div className="revision-item-main">
                <strong>{revision.label || revisionKindLabels[revision.kind]}</strong>
                <span>{revisionDateFormatter.format(new Date(revision.createdAt))}</span>
                <small>
                  Generation {revision.generation} · Seq {revision.collabSeq}
                </small>
                {revision.description ? <p>{revision.description}</p> : null}
              </div>
              <button
                type="button"
                className="revision-preview-button"
                aria-label={`预览版本“${revision.label || revisionKindLabels[revision.kind]}”`}
                title="预览与当前内容的差异"
                disabled={creating || !!restoringId || !!previewLoadingId}
                onClick={() => void showPreview(revision)}
              >
                {previewLoadingId === revision.id ? (
                  <span className="mini-spinner" />
                ) : (
                  <Eye size={14} />
                )}
              </button>
              <button
                type="button"
                className="revision-restore"
                aria-label={`恢复版本“${revision.label || revisionKindLabels[revision.kind]}”`}
                title="恢复此版本"
                disabled={creating || !!restoringId}
                onClick={() => void restore(revision)}
              >
                {restoringId === revision.id ? (
                  <span className="mini-spinner" />
                ) : (
                  <RotateCcw size={14} />
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
