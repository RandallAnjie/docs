import { Database, ExternalLink, FileText, Link2, Search, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { SpaceSummary } from '@rdocs/shared';

import {
  connectNotion,
  disconnectNotion,
  getNotionConnection,
  importFromNotion,
  listSpaces,
  searchNotion,
  type NotionConnection,
  type NotionSearchResult,
} from './api';
import { confirmDialog } from './dialogs';

function fail(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function NotionSettings({ organizationId }: { organizationId: string }) {
  const [connection, setConnection] = useState<NotionConnection | null>(null);
  const [token, setToken] = useState('');
  const [kind, setKind] = useState<'database' | 'page'>('database');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NotionSearchResult[] | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; pageId?: string } | null>(null);

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
        setSpaceId((current) => current || writable[0]?.id || '');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [organizationId]);

  const search = useCallback(
    async (nextKind = kind) => {
      setBusy('search');
      setError(null);
      try {
        setResults((await searchNotion(organizationId, query, nextKind)).results);
      } catch (reason) {
        setError(fail(reason, '无法搜索 Notion'));
      } finally {
        setBusy(null);
      }
    },
    [kind, organizationId, query],
  );

  useEffect(() => {
    if (connection?.connected) void search();
    // Search once when the connection becomes available.
  }, [connection?.connected]);

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
      setResults(null);
    } catch (reason) {
      setError(fail(reason, '无法断开 Notion'));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (item: NotionSearchResult) => {
    if (!spaceId) {
      setError('请先选择导入到哪个空间');
      return;
    }
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      const result = await importFromNotion(organizationId, {
        notionId: item.id,
        kind: item.kind,
        spaceId,
      });
      const parts = [`已导入「${result.page.title}」`];
      if (result.kind === 'database') parts.push(`${result.imported ?? 0} 条记录`);
      if (result.truncated) parts.push('内容较多，只导入了前一部分');
      if (result.skippedProperties?.length)
        parts.push(`跳过字段：${result.skippedProperties.join('、')}`);
      setNotice({ text: parts.join('，'), pageId: result.page.id });
    } catch (reason) {
      setError(fail(reason, '导入失败'));
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
        <>
          <h3>从 Notion 导入</h3>
          <div className="notion-import-bar">
            <span className="notion-kind" role="tablist">
              {(['database', 'page'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={kind === value}
                  className={kind === value ? 'active' : ''}
                  onClick={() => {
                    setKind(value);
                    void search(value);
                  }}
                >
                  {value === 'database' ? <Database size={14} /> : <FileText size={14} />}
                  {value === 'database' ? '数据库' : '页面'}
                </button>
              ))}
            </span>
            <form
              className="notion-search"
              onSubmit={(event) => {
                event.preventDefault();
                void search();
              }}
            >
              <Search size={14} />
              <input
                className="settings-search"
                type="search"
                value={query}
                aria-label="搜索 Notion"
                placeholder="搜索已分享给集成的内容"
                onChange={(event) => setQuery(event.target.value)}
              />
            </form>
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
          </div>
          {busy === 'search' ? <p className="tenant-panel-note">正在搜索…</p> : null}
          {results && !results.length && busy !== 'search' ? (
            <p className="tenant-panel-note">
              没有找到内容。请确认已在 Notion 中把页面或数据库「连接」到这个集成。
            </p>
          ) : null}
          {results?.map((item) => (
            <div key={item.id} className="member-row">
              <div>
                <strong>
                  {item.icon ? `${item.icon} ` : ''}
                  {item.title}
                </strong>
                <small>{item.kind === 'database' ? 'Notion 数据库' : 'Notion 页面'}</small>
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void runImport(item)}>
                {busy === item.id ? '导入中…' : '导入'}
              </button>
            </div>
          ))}
        </>
      ) : null}

      {notice ? (
        <p className="notion-notice">
          {notice.text}
          {notice.pageId ? (
            <>
              {' '}
              <a href={`/p/${encodeURIComponent(notice.pageId)}`}>打开</a>
            </>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p className="tenant-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
