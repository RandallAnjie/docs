import { ArchiveRestore, CheckSquare, FileText, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { SpaceSummary, TrashedPageSummary } from '@rdocs/shared';

import { listTrash, restorePage } from './api';
import { selectedPageRootIds, unavailableBatchMoveTargetIds } from './page-batch';

export function SpaceTrashDialog({ space, onClose }: { space: SpaceSummary; onClose: () => void }) {
  const [pages, setPages] = useState<TrashedPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPages((await listTrash(space.id)).pages);
      setSelectedIds(new Set());
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
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(page.id);
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复页面');
    } finally {
      setBusyId(null);
    }
  };

  const restoreSelected = async () => {
    if (!selectedIds.size || busyId) return;
    setBusyId('batch');
    setError(null);
    const targetIds = selectedPageRootIds(pages, selectedIds);
    const failures = new Set<string>();
    const restoredIds = new Set<string>();
    for (const pageId of targetIds) {
      try {
        await restorePage(pageId);
        for (const restoredId of unavailableBatchMoveTargetIds(pages, new Set([pageId]))) {
          restoredIds.add(restoredId);
        }
      } catch {
        failures.add(pageId);
      }
    }
    setPages((current) => current.filter((page) => !restoredIds.has(page.id)));
    setSelectedIds(failures);
    if (failures.size) {
      setError(`已恢复 ${targetIds.length - failures.size} 个页面子树，${failures.size} 个失败`);
    }
    setBusyId(null);
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
          <>
            <div className="trash-batch-toolbar">
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.size === pages.length}
                  onChange={(event) =>
                    setSelectedIds(
                      event.target.checked ? new Set(pages.map((page) => page.id)) : new Set(),
                    )
                  }
                />
                {selectedIds.size ? `已选择 ${selectedIds.size} 项` : `共 ${pages.length} 项`}
              </label>
              <button
                type="button"
                disabled={!selectedIds.size || Boolean(busyId)}
                onClick={() => void restoreSelected()}
              >
                <ArchiveRestore size={15} /> 批量恢复
              </button>
            </div>
            <div className="trash-list">
              {pages.map((page) => (
                <div key={page.id}>
                  <button
                    className={selectedIds.has(page.id) ? 'trash-select active' : 'trash-select'}
                    type="button"
                    aria-label={
                      selectedIds.has(page.id) ? `取消选择 ${page.title}` : `选择 ${page.title}`
                    }
                    onClick={() =>
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (next.has(page.id)) next.delete(page.id);
                        else next.add(page.id);
                        return next;
                      })
                    }
                  >
                    {selectedIds.has(page.id) ? <CheckSquare size={15} /> : <Square size={15} />}
                  </button>
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
                    disabled={Boolean(busyId)}
                  >
                    <ArchiveRestore size={15} /> {busyId === page.id ? '恢复中…' : '恢复'}
                  </button>
                </div>
              ))}
            </div>
          </>
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
