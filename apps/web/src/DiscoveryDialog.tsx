import {
  Activity,
  Clock3,
  Command,
  FilePlus2,
  FileText,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  FavoritePageResult,
  OrganizationMemberSummary,
  PageSearchResult,
  PageSearchSort,
  PageSummary,
  PageUpdateSummary,
  RecentPageResult,
  SpaceSummary,
} from '@rdocs/shared';

import {
  listFavoritePages,
  listOrganizationMembers,
  listPageUpdates,
  listRecentPages,
  searchPages,
  setPageFavorite,
} from './api';

type DiscoveryTab = 'favorites' | 'recent' | 'search' | 'updates';
type DatePreset = '30d' | '7d' | 'all' | 'today';

function updateText(update: PageUpdateSummary): string {
  const actor = update.actor?.displayName ?? '系统';
  const labels: Record<string, string> = {
    'page.content_updated': '编辑了页面',
    'page.created': '创建了页面',
    'page.moved': '移动了页面',
    'page.title.updated': '修改了页面标题',
    'page.deleted': '将页面移入回收站',
    'page.restored': '恢复了页面',
    'synced_block.created': '创建了同步块',
    'synced_block.deleted_all': '删除了原始同步块及副本',
    'synced_block.unsynced_all': '取消了全部同步',
  };
  return `${actor} ${labels[update.eventType] ?? '更新了页面'}`;
}

export function DiscoveryDialog({
  organizationId,
  initialTab,
  onClose,
  onCreatePage,
  pages = [],
  spaces = [],
}: {
  organizationId: string;
  initialTab: DiscoveryTab;
  onClose: () => void;
  onCreatePage?: () => void;
  pages?: PageSummary[];
  spaces?: SpaceSummary[];
}) {
  const [tab, setTab] = useState<DiscoveryTab>(initialTab);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PageSearchResult[]>([]);
  const [favorites, setFavorites] = useState<FavoritePageResult[]>([]);
  const [recent, setRecent] = useState<RecentPageResult[]>([]);
  const [updates, setUpdates] = useState<PageUpdateSummary[]>([]);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<PageSearchSort>('best');
  const [titleOnly, setTitleOnly] = useState(false);
  const [spaceId, setSpaceId] = useState('');
  const [inPageId, setInPageId] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [commandIndex, setCommandIndex] = useState(0);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    listOrganizationMembers(organizationId)
      .then((result) => {
        if (active) setMembers(result.members.filter((member) => member.status === 'active'));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [organizationId]);

  useEffect(() => {
    if (tab !== 'search') return;
    if (!query.trim()) {
      setSearchResults([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dateFrom =
      datePreset === 'today'
        ? startOfToday
        : datePreset === '7d'
          ? now.getTime() - 7 * 24 * 60 * 60 * 1000
          : datePreset === '30d'
            ? now.getTime() - 30 * 24 * 60 * 60 * 1000
            : undefined;
    const timer = window.setTimeout(() => {
      searchPages(organizationId, query, {
        createdBy: createdBy || undefined,
        dateFrom,
        inPageId: inPageId || undefined,
        sort,
        spaceId: spaceId || undefined,
        titleOnly,
      })
        .then((result) => active && setSearchResults(result.results))
        .catch(
          (reason) => active && setError(reason instanceof Error ? reason.message : '搜索失败'),
        )
        .finally(() => active && setLoading(false));
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [createdBy, datePreset, inPageId, organizationId, query, sort, spaceId, tab, titleOnly]);

  useEffect(() => {
    if (tab === 'search') return;
    let active = true;
    setLoading(true);
    setError(null);
    const request =
      tab === 'favorites'
        ? listFavoritePages(organizationId)
        : tab === 'recent'
          ? listRecentPages(organizationId)
          : listPageUpdates(organizationId);
    request
      .then((result) => {
        if (!active) return;
        if ('updates' in result) setUpdates(result.updates);
        else if (tab === 'favorites') setFavorites(result.pages as FavoritePageResult[]);
        else setRecent(result.pages as RecentPageResult[]);
      })
      .catch(
        (reason) => active && setError(reason instanceof Error ? reason.message : '无法加载页面'),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [organizationId, tab]);

  const favoriteSearchResult = async (result: PageSearchResult) => {
    try {
      await setPageFavorite(result.page.id, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法收藏页面');
    }
  };

  const removeFavorite = async (result: FavoritePageResult) => {
    try {
      await setPageFavorite(result.page.id, false);
      setFavorites((current) =>
        current.filter((candidate) => candidate.page.id !== result.page.id),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法取消收藏');
    }
  };

  const commands = [
    ...(onCreatePage
      ? [
          {
            description: '在当前空间根目录创建页面',
            icon: <FilePlus2 size={15} />,
            label: '新建页面',
            run: () => {
              onClose();
              onCreatePage();
            },
          },
        ]
      : []),
    {
      description: '返回工作区主页',
      icon: <FileText size={15} />,
      label: '打开主页',
      run: () => window.location.assign('/'),
    },
    {
      description: '查看最近访问的页面',
      icon: <Clock3 size={15} />,
      label: '最近访问',
      run: () => setTab('recent'),
    },
    {
      description: '查看收藏的页面',
      icon: <Star size={15} />,
      label: '收藏',
      run: () => setTab('favorites'),
    },
    {
      description: '查看有权限页面的活动',
      icon: <Activity size={15} />,
      label: '所有更新',
      run: () => setTab('updates'),
    },
    {
      description: '管理当前工作区',
      icon: <Command size={15} />,
      label: '工作区设置',
      run: () => window.location.assign('/?settings=1'),
    },
  ];

  const pageRows = tab === 'favorites' ? favorites : recent;
  return (
    <div className="dialog-backdrop discovery-backdrop" role="presentation">
      <section className="discovery-dialog" role="dialog" aria-modal="true">
        <header>
          <div className="discovery-tabs">
            <button
              className={tab === 'search' ? 'active' : ''}
              type="button"
              onClick={() => setTab('search')}
            >
              <Search size={14} /> 搜索
            </button>
            <button
              className={tab === 'updates' ? 'active' : ''}
              type="button"
              onClick={() => setTab('updates')}
            >
              <Activity size={14} /> 更新
            </button>
            <button
              className={tab === 'favorites' ? 'active' : ''}
              type="button"
              onClick={() => setTab('favorites')}
            >
              <Star size={14} /> 收藏
            </button>
            <button
              className={tab === 'recent' ? 'active' : ''}
              type="button"
              onClick={() => setTab('recent')}
            >
              <Clock3 size={14} /> 最近
            </button>
          </div>
          <button className="discovery-close" type="button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        {tab === 'search' ? (
          <>
            <div className="discovery-search">
              <Search size={18} />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (query.trim() || !commands.length) return;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const delta = event.key === 'ArrowDown' ? 1 : -1;
                    setCommandIndex(
                      (current) => (current + delta + commands.length) % commands.length,
                    );
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commands[commandIndex % commands.length]?.run();
                  }
                }}
                placeholder='搜索标题和正文；使用 "引号" 查找完整短语…'
                maxLength={102}
              />
              <button
                className={filtersOpen ? 'active' : ''}
                type="button"
                aria-label="搜索筛选"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((current) => !current)}
              >
                <SlidersHorizontal size={15} />
              </button>
              <kbd>⌘ K</kbd>
            </div>
            {filtersOpen ? (
              <div className="discovery-filters">
                <label>
                  排序
                  <select
                    value={sort}
                    onChange={(event) => setSort(event.target.value as PageSearchSort)}
                  >
                    <option value="best">最佳匹配</option>
                    <option value="updated_desc">最后编辑：最新</option>
                    <option value="updated_asc">最后编辑：最早</option>
                    <option value="created_desc">创建时间：最新</option>
                    <option value="created_asc">创建时间：最早</option>
                  </select>
                </label>
                <label>
                  团队空间
                  <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
                    <option value="">全部空间</option>
                    {spaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  位于
                  <select value={inPageId} onChange={(event) => setInPageId(event.target.value)}>
                    <option value="">任意页面</option>
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  创建者
                  <select value={createdBy} onChange={(event) => setCreatedBy(event.target.value)}>
                    <option value="">任何人</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  日期
                  <select
                    value={datePreset}
                    onChange={(event) => setDatePreset(event.target.value as DatePreset)}
                  >
                    <option value="all">不限</option>
                    <option value="today">今天</option>
                    <option value="7d">过去 7 天</option>
                    <option value="30d">过去 30 天</option>
                  </select>
                </label>
                <label className="discovery-title-only">
                  <input
                    type="checkbox"
                    checked={titleOnly}
                    onChange={(event) => setTitleOnly(event.target.checked)}
                  />
                  只搜索标题
                </label>
              </div>
            ) : null}
          </>
        ) : null}
        <div className="discovery-results">
          {loading ? (
            <div className="discovery-state">
              <div className="loading-mark" /> 正在查找…
            </div>
          ) : tab === 'search' ? (
            query.trim() ? (
              searchResults.length ? (
                searchResults.map((result) => (
                  <div className="discovery-result" key={result.page.id}>
                    <a href={`/p/${encodeURIComponent(result.page.id)}`}>
                      <span>{result.page.icon || <FileText size={15} />}</span>
                      <div>
                        <strong>{result.page.title}</strong>
                        <p>{result.snippet}</p>
                        <small>
                          {result.createdBy.displayName} ·{' '}
                          {new Date(result.page.updatedAt).toLocaleString()}
                        </small>
                      </div>
                    </a>
                    <button
                      type="button"
                      title="收藏"
                      onClick={() => void favoriteSearchResult(result)}
                    >
                      <Star size={15} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="discovery-state">没有找到可访问的页面</div>
              )
            ) : (
              <div className="discovery-commands">
                <div className="discovery-command-heading">
                  <Command size={14} /> 快捷命令
                </div>
                {commands.map((command, index) => (
                  <button
                    className={index === commandIndex ? 'active' : ''}
                    key={command.label}
                    type="button"
                    onMouseEnter={() => setCommandIndex(index)}
                    onClick={command.run}
                  >
                    <span>{command.icon}</span>
                    <span>
                      <strong>{command.label}</strong>
                      <small>{command.description}</small>
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : tab === 'updates' ? (
            updates.length ? (
              updates.map((update) => (
                <a
                  className="discovery-update"
                  key={update.id}
                  href={`/p/${encodeURIComponent(update.page.id)}`}
                >
                  <span className="discovery-update-avatar">
                    {[...(update.actor?.displayName ?? '系')][0]}
                  </span>
                  <span>
                    <strong>{updateText(update)}</strong>
                    <span>{update.page.title}</span>
                    <small>{new Date(update.createdAt).toLocaleString()}</small>
                  </span>
                </a>
              ))
            ) : (
              <div className="discovery-state">还没有可见的页面更新</div>
            )
          ) : pageRows.length ? (
            pageRows.map((result) => (
              <div className="discovery-result" key={result.page.id}>
                <a href={`/p/${encodeURIComponent(result.page.id)}`}>
                  <span>{result.page.icon || <FileText size={15} />}</span>
                  <div>
                    <strong>{result.page.title}</strong>
                    <p>
                      {new Date(
                        tab === 'favorites'
                          ? (result as FavoritePageResult).favoritedAt
                          : (result as RecentPageResult).visitedAt,
                      ).toLocaleString()}
                    </p>
                  </div>
                </a>
                {tab === 'favorites' ? (
                  <button
                    className="active"
                    type="button"
                    title="取消收藏"
                    onClick={() => void removeFavorite(result as FavoritePageResult)}
                  >
                    <Star size={15} fill="currentColor" />
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <div className="discovery-state">
              {tab === 'favorites' ? '还没有收藏页面' : '还没有最近访问记录'}
            </div>
          )}
        </div>
        {error ? (
          <p className="discovery-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
