import { ArchiveRestore, FileText, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { SpaceSummary, TrashedPageSummary } from '@rdocs/shared';

import { listTrash, restorePage } from './api';

export function SpaceTrashDialog({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  const [pages, setPages] = useState<TrashedPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPages((await listTrash(space.id)).pages);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法加载回收站');
    } finally {
      setLoading(false);
    }
  }, [space.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (page: TrashedPageSummary) => {
    setBusyId(page.id);
    setError(null);
    try {
      await restorePage(page.id);
      setPages((current) => current.filter((candidate) => candidate.id !== page.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复页面');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="rdocs-dialog trash-dialog" role="dialog" aria-modal="true">
        <button className="dialog-close" type="button" onClick={onClose} aria-label="关闭">
          <X size={17} />
        </button>
        <div className="dialog-icon">
          <Trash2 size={19} />
        </div>
        <h2>{space.name} · 回收站</h2>
        <p>删除的页面子树会保留在这里，恢复时会尽量回到原父页面。</p>
        {loading ? (
          <div className="settings-loading">
            <div className="loading-mark" /> 正在加载…
          </div>
        ) : pages.length ? (
          <div className="trash-list">
            {pages.map((page) => (
              <div key={page.id}>
                <span>
                  <FileText size={16} />
                </span>
                <div>
                  <strong>{page.title}</strong>
                  <small>{new Date(page.deletedAt).toLocaleString()} 删除</small>
                </div>
                <button
                  type="button"
                  onClick={() => void restore(page)}
                  disabled={busyId === page.id}
                >
                  <ArchiveRestore size={15} /> {busyId === page.id ? '恢复中…' : '恢复'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="trash-empty">
            <Trash2 size={22} />
            <strong>回收站是空的</strong>
            <span>这个空间没有已删除页面。</span>
          </div>
        )}
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
