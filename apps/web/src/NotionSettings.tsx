import { Database, ExternalLink, FileText, Link2, RefreshCw, Unplug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { SpaceSummary } from '@rdocs/shared';

import {
  connectNotion,
  disconnectNotion,
  getNotionConnection,
  getNotionTree,
  latestNotionImport,
  listSpaces,
  startNotionImport,
  stepNotionImport,
  type NotionConnection,
  type NotionImportJob,
  type NotionTreeEntry,
} from './api';
import { confirmDialog } from './dialogs';

function fail(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function NotionSettings({ organizationId }: { organizationId: string }) {
  const [connection, setConnection] = useState<NotionConnection | null>(null);
  const [token, setToken] = useState('');
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getNotionConnection(organizationId)
      .then((result) => active && setConnection(result))
      .catch((reason: unknown) => active && setError(fail(reason, '无法读取 Notion 连接')));
    void listSpaces(organizationId)
      .then((result) => {
        if (!active) return;
        const writable = result.spaces.filter(
          (space) => !space.archivedAt && (space.role === 'space_admin' || space.role === 'editor'),
        );
        setSpaces(writable);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [organizationId]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('connect');
    setError(null);
    try {
      setConnection(await connectNotion(organizationId, token.trim()));
      setToken('');
    } catch (reason) {
      setError(fail(reason, '无法连接 Notion'));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (
      !(await confirmDialog({
        title: '断开 Notion',
        message: '断开后，写入 Notion 的自动化会失败，已导入的内容不受影响。',
        confirmLabel: '断开',
        danger: true,
      }))
    ) {
      return;
    }
    setBusy('connect');
    try {
      setConnection(await disconnectNotion(organizationId));
    } catch (reason) {
      setError(fail(reason, '无法断开 Notion'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="tenant-panel organization-settings notion-settings">
      <div className="tenant-panel-heading">
        <div>
          <span>Notion</span>
          <small>连接 Notion 工作区，导入页面和数据库，或让自动化把记录写入 Notion。</small>
        </div>
      </div>

      {!connection ? (
        <p className="tenant-panel-note">正在读取连接状态…</p>
      ) : connection.connected ? (
        <div className="notion-connected">
          <Link2 size={16} />
          <div>
            <strong>
              已连接{connection.workspaceName ? `「${connection.workspaceName}」` : ''}
            </strong>
            <small>
              集成 {connection.botName ?? 'Notion'} ·{' '}
              {connection.connectedAt ? new Date(connection.connectedAt).toLocaleString() : ''}
            </small>
          </div>
          {connection.canManage ? (
            <button type="button" disabled={busy !== null} onClick={() => void disconnect()}>
              <Unplug size={14} /> 断开
            </button>
          ) : null}
        </div>
      ) : connection.canManage ? (
        <form className="settings-form" onSubmit={(event) => void connect(event)}>
          <ol className="notion-steps">
            <li>
              在 Notion 打开{' '}
              <a
                href="https://www.notion.so/profile/integrations"
                target="_blank"
                rel="noopener noreferrer"
              >
                集成管理 <ExternalLink size={12} />
              </a>
              ，新建一个「内部」集成，复制它的密钥。
            </li>
            <li>在要导入或写入的 Notion 页面、数据库右上角「···」→「连接」中选择这个集成。</li>
            <li>把密钥粘贴到下面。Rdocs 加密保存，不会再显示。</li>
          </ol>
          <label>
            <span>Notion 集成密钥</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              placeholder="ntn_…"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={busy !== null || !token.trim()}
          >
            {busy === 'connect' ? '正在验证…' : '连接 Notion'}
          </button>
        </form>
      ) : (
        <p className="tenant-panel-note">还没有连接 Notion，请联系工作区所有者或管理员。</p>
      )}

      {connection?.connected ? (
        <NotionTreeImport organizationId={organizationId} spaces={spaces} />
      ) : null}

      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Import Notion the way it is organized: pick top-level pages and databases;
 * each comes with all its sub-pages, databases, rows and row bodies, in
 * Notion's order. Runs as a resumable job, a batch at a time.
 */
function NotionTreeImport({
  organizationId,
  spaces,
}: {
  organizationId: string;
  spaces: SpaceSummary[];
}) {
  const [roots, setRoots] = useState<NotionTreeEntry[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [spaceId, setSpaceId] = useState('');
  const [job, setJob] = useState<NotionImportJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    setSpaceId((current) => current || spaces[0]?.id || '');
  }, [spaces]);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getNotionTree(organizationId);
      setRoots(result.roots);
      setSelected(new Set(result.roots.map((root) => root.id)));
    } catch (reason) {
      setError(fail(reason, '无法读取 Notion 目录'));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  // Keep stepping a running job until it finishes (also after a reload).
  const drive = useCallback(
    async (current: NotionImportJob) => {
      if (running.current) return;
      running.current = true;
      let next: NotionImportJob | null = current;
      try {
        while (next && next.status === 'running') {
          // Everything left is waiting out a Notion rate limit: wait, then go on.
          if (next.retryInMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(next!.retryInMs, 30_000)));
          }
          const result = await stepNotionImport(organizationId, next.id);
          next = result.job;
          setJob(next);
        }
      } catch (reason) {
        setError(fail(reason, '导入中断，可以点「继续导入」接着进行'));
      } finally {
        running.current = false;
      }
    },
    [organizationId],
  );

  useEffect(() => {
    void loadTree();
    void latestNotionImport(organizationId)
      .then((result) => {
        setJob(result.job);
        if (result.job?.status === 'running') void drive(result.job);
      })
      .catch(() => undefined);
  }, [drive, loadTree, organizationId]);

  const start = async () => {
    if (!roots || !spaceId) return;
    setError(null);
    try {
      const result = await startNotionImport(organizationId, {
        spaceId,
        roots: roots.filter((root) => selected.has(root.id)),
      });
      setJob(result.job);
      if (result.job) void drive(result.job);
    } catch (reason) {
      setError(fail(reason, '无法开始导入'));
    }
  };

  const retryFailed = async () => {
    if (!job) return;
    setError(null);
    try {
      const result = await stepNotionImport(organizationId, job.id, 'retry');
      setJob(result.job);
      if (result.job?.status === 'running') void drive(result.job);
    } catch (reason) {
      setError(fail(reason, '无法重试'));
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      setJob((await stepNotionImport(organizationId, job.id, 'cancel')).job);
    } catch (reason) {
      setError(fail(reason, '无法取消导入'));
    }
  };

  const active = job?.status === 'running';
  const processed = job ? job.done + job.failed : 0;
  const percent = job && job.total ? Math.min(100, Math.round((processed / job.total) * 100)) : 0;
  const allSelected = Boolean(roots?.length) && roots!.every((root) => selected.has(root.id));

  return (
    <div className="notion-tree-import">
      <h3>按目录导入</h3>
      <p className="tenant-panel-note">
        勾选的页面和数据库会连同所有子页面、子数据库、每条记录的正文一起导入，保持 Notion
        里的层级和顺序；Notion 托管的图片和文件会复制到 Rdocs。
      </p>

      {job ? (
        <div className={`notion-import-progress is-${job.status}`} aria-live="polite">
          <div className="notion-import-progress-head">
            <strong>
              {job.status === 'running'
                ? '正在导入…'
                : job.status === 'completed'
                  ? job.failed
                    ? `导入完成，${job.failed} 项失败`
                    : '导入完成'
                  : '导入已取消'}
            </strong>
            <span>
              {processed} / {job.total}
            </span>
          </div>
          <div className="notion-import-bar" role="progressbar" aria-valuenow={percent}>
            <i style={{ width: `${percent}%` }} />
          </div>
          {active && job.retryInMs > 0 ? (
            <small>
              Notion 限流，{Math.ceil(job.retryInMs / 1000)} 秒后自动继续（{job.delayed}{' '}
              项等待重试）
            </small>
          ) : active && job.current ? (
            <small>正在处理：{job.current}</small>
          ) : active && job.delayed ? (
            <small>{job.delayed} 项遇到限流，稍后自动重试</small>
          ) : null}
          {job.imported.length ? (
            <div className="notion-import-links">
              {job.imported.map((item) => (
                <a key={item.pageId} href={`/p/${encodeURIComponent(item.pageId)}`}>
                  {item.kind === 'database' ? <Database size={13} /> : <FileText size={13} />}
                  {item.title}
                </a>
              ))}
            </div>
          ) : null}
          {job.failures.length ? (
            <details className="notion-import-failures">
              <summary>查看失败的 {job.failed} 项</summary>
              <ul>
                {job.failures.map((failure, index) => (
                  <li key={`${failure.title}-${index}`}>
                    <strong>{failure.title}</strong>
                    <span>{failure.error}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="notion-import-actions">
            {!active && job.failed > 0 && job.status !== 'cancelled' ? (
              <button type="button" onClick={() => void retryFailed()}>
                重试失败的 {job.failed} 项
              </button>
            ) : null}
            {active ? (
              <>
                {!running.current ? (
                  <button type="button" onClick={() => void drive(job)}>
                    继续导入
                  </button>
                ) : null}
                <button type="button" onClick={() => void cancel()}>
                  取消
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {!active ? (
        <>
          <div className="notion-tree-toolbar">
            <label className="notion-tree-all">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!roots?.length}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set((roots ?? []).map((root) => root.id)),
                  )
                }
              />
              全选{roots ? `（${roots.length} 项）` : ''}
            </label>
            <label className="notion-space">
              导入到
              <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={loading} onClick={() => void loadTree()}>
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
          {loading && !roots ? <p className="tenant-panel-note">正在读取 Notion 目录…</p> : null}
          {roots && !roots.length ? (
            <p className="tenant-panel-note">
              没有可导入的内容。请在 Notion 中把页面或数据库「连接」到这个集成。
            </p>
          ) : null}
          <ul className="notion-tree-list">
            {roots?.map((root) => (
              <li key={root.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(root.id)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(root.id)) next.delete(root.id);
                        else next.add(root.id);
                        return next;
                      })
                    }
                  />
                  <span className="notion-tree-icon">
                    {root.icon ??
                      (root.kind === 'database' ? <Database size={14} /> : <FileText size={14} />)}
                  </span>
                  <span className="notion-tree-title">{root.title}</span>
                  <small>{root.kind === 'database' ? '数据库' : '页面'}</small>
                </label>
              </li>
            ))}
          </ul>
          <button
            className="primary-button"
            type="button"
            disabled={!selected.size || !spaceId}
            onClick={() => void start()}
          >
            导入所选（{selected.size} 项及其全部内容）
          </button>
        </>
      ) : null}
      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
