import { Clock3, FileText, Search, Star, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { FavoritePageResult, PageSearchResult, RecentPageResult } from '@rdocs/shared';

import { listFavoritePages, listRecentPages, searchPages, setPageFavorite } from './api';

type DiscoveryTab = 'search' | 'favorites' | 'recent';

export function DiscoveryDialog({
  organizationId,
  initialTab,
  onClose,
}: {
  organizationId: string;
  initialTab: DiscoveryTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DiscoveryTab>(initialTab);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PageSearchResult[]>([]);
  const [favorites, setFavorites] = useState<FavoritePageResult[]>([]);
  const [recent, setRecent] = useState<RecentPageResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    if (tab !== 'search') return;
    if (!query.trim()) {
      setSearchResults([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchPages(organizationId, query)
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
  }, [organizationId, query, tab]);

  useEffect(() => {
    if (tab === 'search') return;
    let active = true;
    setLoading(true);
    setError(null);
    const request =
      tab === 'favorites' ? listFavoritePages(organizationId) : listRecentPages(organizationId);
    request
      .then((result) => {
        if (!active) return;
        if (tab === 'favorites') setFavorites(result.pages as FavoritePageResult[]);
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
          <div className="discovery-search">
            <Search size={18} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题和正文…"
              maxLength={100}
            />
            <kbd>⌘ K</kbd>
          </div>
        ) : null}
        <div className="discovery-results">
          {loading ? (
            <div className="discovery-state">
              <div className="loading-mark" /> 正在查找…
            </div>
          ) : tab === 'search' ? (
            searchResults.length ? (
              searchResults.map((result) => (
                <div className="discovery-result" key={result.page.id}>
                  <a href={`/p/${encodeURIComponent(result.page.id)}`}>
                    <span>
                      <FileText size={15} />
                    </span>
                    <div>
                      <strong>{result.page.title}</strong>
                      <p>{result.snippet}</p>
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
              <div className="discovery-state">
                {query.trim() ? '没有找到可访问的页面' : '输入关键词搜索当前组织'}
              </div>
            )
          ) : pageRows.length ? (
            pageRows.map((result) => (
              <div className="discovery-result" key={result.page.id}>
                <a href={`/p/${encodeURIComponent(result.page.id)}`}>
                  <span>
                    <FileText size={15} />
                  </span>
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
