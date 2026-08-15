import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { SitePageSummary, SiteSearchResult, SiteSummary } from '@rdocs/shared';

import { recordPublicSiteEvent, searchPublicSite } from './api';

function pageHref(site: SiteSummary, page: SitePageSummary): string {
  return `/site/${encodeURIComponent(site.slug)}${
    page.isHome ? '' : `/${encodeURIComponent(page.slug)}`
  }`;
}

export function PublicSiteHeader({
  currentPageId,
  onSearch,
  site,
}: {
  currentPageId: string;
  onSearch: () => void;
  site: SiteSummary;
}) {
  const navigation = useMemo(
    () =>
      site.pages
        .filter((page) => page.isVisible && page.navigationOrder !== null && !page.isHome)
        .sort(
          (left, right) =>
            (left.navigationOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.navigationOrder ?? Number.MAX_SAFE_INTEGER),
        ),
    [site.pages],
  );
  const home = site.pages.find((page) => page.isHome);
  return (
    <header className="public-site-header">
      <a className="public-site-brand" href={home ? pageHref(site, home) : `/site/${site.slug}`}>
        <span>{home?.page.icon || site.name.slice(0, 1).toUpperCase()}</span>
        <strong>{site.name}</strong>
      </a>
      <nav aria-label="站点导航">
        {navigation.map((page) => (
          <a
            key={page.page.id}
            href={pageHref(site, page)}
            aria-current={page.page.id === currentPageId ? 'page' : undefined}
          >
            {page.navigationLabel || page.page.title}
          </a>
        ))}
      </nav>
      <div>
        {site.searchEnabled ? (
          <button type="button" aria-label="搜索站点" onClick={onSearch}>
            <Search size={16} /> <span>搜索</span>
          </button>
        ) : null}
        {site.watermarkEnabled ? (
          <a className="public-site-watermark" href="/" title="使用 Rdocs 创建">
            Rdocs
          </a>
        ) : null}
      </div>
    </header>
  );
}

export function PublicSiteBreadcrumbs({
  currentPageId,
  site,
}: {
  currentPageId: string;
  site: SiteSummary;
}) {
  if (!site.breadcrumbsEnabled) return null;
  const byId = new Map(site.pages.map((page) => [page.page.id, page]));
  const path: SitePageSummary[] = [];
  let current = byId.get(currentPageId);
  const seen = new Set<string>();
  while (current && !seen.has(current.page.id)) {
    seen.add(current.page.id);
    path.unshift(current);
    current = current.page.parentId ? byId.get(current.page.parentId) : undefined;
  }
  return (
    <nav className="public-site-breadcrumbs" aria-label="面包屑">
      {path.map((page, index) => (
        <span key={page.page.id}>
          {index ? <i>/</i> : null}
          {index === path.length - 1 ? (
            <b>{page.page.title}</b>
          ) : (
            <a href={pageHref(site, page)}>{page.page.title}</a>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PublicSiteSearchDialog({
  sessionId,
  site,
  onClose,
}: {
  sessionId: string;
  site: SiteSummary;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SiteSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      Promise.all([
        searchPublicSite(site.slug, normalized),
        recordPublicSiteEvent(site.slug, { type: 'search', sessionId }).catch(() => undefined),
      ])
        .then(([result]) => {
          if (!active) return;
          setResults(result.results);
          setError(null);
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : '站点搜索失败');
        })
        .finally(() => active && setLoading(false));
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, sessionId, site.slug]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <div className="public-site-search-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="public-site-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`搜索 ${site.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Search size={18} />
          <input
            autoFocus
            value={query}
            placeholder={`搜索 ${site.name}…`}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" aria-label="关闭搜索" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="public-site-search-results">
          {loading ? <p>正在搜索…</p> : null}
          {!loading && query.trim().length < 2 ? <p>输入至少两个字符。</p> : null}
          {!loading && query.trim().length >= 2 && !results.length && !error ? (
            <p>没有找到公开页面。</p>
          ) : null}
          {results.map((result) => (
            <a
              key={result.pageId}
              href={`/site/${encodeURIComponent(site.slug)}${
                result.slug ? `/${encodeURIComponent(result.slug)}` : ''
              }`}
            >
              <span>{result.icon || '◇'}</span>
              <div>
                <strong>{result.title}</strong>
                <small>{result.excerpt || '公开页面'}</small>
              </div>
            </a>
          ))}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      </section>
    </div>
  );
}
