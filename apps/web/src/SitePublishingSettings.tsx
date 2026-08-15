import {
  BarChart3,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  ExternalLink,
  Globe2,
  RefreshCw,
  Search,
  Unplug,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type { AttachmentSummary, SiteAnalyticsDay, SiteSummary } from '@rdocs/shared';

import {
  addSiteDomain,
  getPageSite,
  getSiteAnalytics,
  listAttachments,
  publishPageSite,
  syncSitePages,
  unpublishSite,
  updateSite,
  updateSitePage,
  verifySiteDomain,
} from './api';
import { confirmDialog } from './dialogs';

function defaultSlug(title: string, pageId: string): string {
  const normalized = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return normalized.length >= 3 ? normalized : `site-${pageId.slice(0, 8).toLowerCase()}`;
}

function siteUrl(site: SiteSummary, pageSlug?: string): string {
  return `${window.location.origin}/site/${encodeURIComponent(site.slug)}${
    pageSlug ? `/${encodeURIComponent(pageSlug)}` : ''
  }`;
}

function failure(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function SitePublishingSettings({
  pageId,
  pageTitle,
}: {
  pageId: string;
  pageTitle: string;
}) {
  const [site, setSite] = useState<SiteSummary | null>(null);
  const [analytics, setAnalytics] = useState<SiteAnalyticsDay[]>([]);
  const [images, setImages] = useState<AttachmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pageBusy, setPageBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishName, setPublishName] = useState(pageTitle);
  const [publishSlug, setPublishSlug] = useState(() => defaultSlug(pageTitle, pageId));
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [theme, setTheme] = useState<SiteSummary['theme']>('system');
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');
  const [faviconAttachmentId, setFaviconAttachmentId] = useState('');
  const [shareImageAttachmentId, setShareImageAttachmentId] = useState('');
  const [googleAnalyticsId, setGoogleAnalyticsId] = useState('');
  const [searchEnabled, setSearchEnabled] = useState(true);
  const [breadcrumbsEnabled, setBreadcrumbsEnabled] = useState(true);
  const [watermarkEnabled, setWatermarkEnabled] = useState(true);
  const [searchEngineIndexing, setSearchEngineIndexing] = useState(false);
  const [domainHostname, setDomainHostname] = useState('');

  const populate = (next: SiteSummary | null) => {
    setSite(next);
    if (!next) return;
    setName(next.name);
    setSlug(next.slug);
    setTheme(next.theme);
    setSeoTitle(next.seoTitle ?? '');
    setSeoDescription(next.seoDescription ?? '');
    setFaviconAttachmentId(next.faviconAttachmentId ?? '');
    setShareImageAttachmentId(next.shareImageAttachmentId ?? '');
    setGoogleAnalyticsId(next.googleAnalyticsId ?? '');
    setSearchEnabled(next.searchEnabled);
    setBreadcrumbsEnabled(next.breadcrumbsEnabled);
    setWatermarkEnabled(next.watermarkEnabled);
    setSearchEngineIndexing(next.searchEngineIndexing);
    setPublishName(next.name);
    setPublishSlug(next.slug);
  };

  useEffect(() => {
    let active = true;
    Promise.all([getPageSite(pageId), listAttachments(pageId)])
      .then(async ([siteResult, attachmentResult]) => {
        if (!active) return;
        populate(siteResult.site);
        setImages(
          attachmentResult.attachments.filter(
            (attachment) =>
              attachment.status === 'ready' && attachment.mimeType.startsWith('image/'),
          ),
        );
        if (siteResult.site) {
          const result = await getSiteAnalytics(siteResult.site.id);
          if (active) setAnalytics(result.days);
        }
      })
      .catch((reason) => active && setError(failure(reason, '无法读取站点设置')))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [pageId]);

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await publishPageSite(pageId, {
        name: publishName.trim(),
        slug: publishSlug.trim(),
      });
      populate(result.site);
      setAnalytics((await getSiteAnalytics(result.site.id)).days);
    } catch (reason) {
      setError(failure(reason, '无法发布站点'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!site || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await updateSite(site.id, {
        name: name.trim(),
        slug: slug.trim(),
        theme,
        seoTitle: seoTitle.trim() || null,
        seoDescription: seoDescription.trim() || null,
        faviconAttachmentId: faviconAttachmentId || null,
        shareImageAttachmentId: shareImageAttachmentId || null,
        googleAnalyticsId: googleAnalyticsId.trim().toUpperCase() || null,
        searchEnabled,
        breadcrumbsEnabled,
        watermarkEnabled,
        searchEngineIndexing,
      });
      populate(result.site);
    } catch (reason) {
      setError(failure(reason, '无法保存站点设置'));
    } finally {
      setBusy(false);
    }
  };

  const syncPages = async () => {
    if (!site || busy) return;
    setBusy(true);
    setError(null);
    try {
      populate((await syncSitePages(site.id)).site);
    } catch (reason) {
      setError(failure(reason, '无法同步站点页面'));
    } finally {
      setBusy(false);
    }
  };

  const changePage = async (
    publishedPage: SiteSummary['pages'][number],
    input: Parameters<typeof updateSitePage>[2],
  ) => {
    if (!site || pageBusy) return;
    setPageBusy(publishedPage.page.id);
    setError(null);
    try {
      populate((await updateSitePage(site.id, publishedPage.page.id, input)).site);
    } catch (reason) {
      setError(failure(reason, '无法更新站点页面'));
    } finally {
      setPageBusy(null);
    }
  };

  const takeOffline = async () => {
    if (!site || busy) return;
    if (
      !(await confirmDialog({
        title: '取消发布',
        message: '取消发布后，所有站点页面会立即返回 404。继续吗？',
        confirmLabel: '取消发布',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      populate((await unpublishSite(site.id)).site);
    } catch (reason) {
      setError(failure(reason, '无法取消发布'));
    } finally {
      setBusy(false);
    }
  };

  const navigation = useMemo(
    () =>
      (site?.pages ?? [])
        .filter((page) => page.navigationOrder !== null)
        .sort(
          (left, right) =>
            (left.navigationOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.navigationOrder ?? Number.MAX_SAFE_INTEGER),
        ),
    [site?.pages],
  );
  const totals = analytics.reduce(
    (result, day) => ({
      views: result.views + day.pageViews,
      searches: result.searches + day.searches,
      visitors: result.visitors + day.uniqueVisitors,
    }),
    { views: 0, searches: 0, visitors: 0 },
  );
  const maxViews = Math.max(1, ...analytics.map((day) => day.pageViews));

  if (loading) {
    return (
      <section className="site-publishing-settings loading">
        <div className="loading-mark" /> 正在读取 Sites…
      </section>
    );
  }

  if (!site || site.unpublishedAt !== null) {
    return (
      <section className="site-publishing-settings">
        <header>
          <div>
            <Globe2 size={17} />
            <span>
              <strong>发布为站点</strong>
              <small>匿名只读；受限子树默认不会公开</small>
            </span>
          </div>
        </header>
        <form className="site-publish-form" onSubmit={(event) => void publish(event)}>
          <label>
            站点名称
            <input
              value={publishName}
              maxLength={100}
              required
              onChange={(event) => setPublishName(event.target.value)}
            />
          </label>
          <label>
            公开路径
            <span className="site-slug-input">
              <code>/site/</code>
              <input
                value={publishSlug}
                minLength={1}
                maxLength={60}
                pattern="[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?"
                required
                onChange={(event) => setPublishSlug(event.target.value.toLowerCase())}
              />
            </span>
          </label>
          <button type="submit" disabled={busy}>
            <Globe2 size={14} /> {busy ? '发布中…' : site ? '重新发布' : '发布站点'}
          </button>
        </form>
        {error ? <p role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="site-publishing-settings">
      <header>
        <div>
          <Globe2 size={17} />
          <span>
            <strong>Rdocs Sites</strong>
            <small>已发布 · 内容更新自动上线</small>
          </span>
        </div>
        <a href={siteUrl(site)} target="_blank" rel="noreferrer">
          查看站点 <ExternalLink size={13} />
        </a>
      </header>
      <div className="site-live-url">
        <code>{siteUrl(site)}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(siteUrl(site));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          }}
        >
          {copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? '已复制' : '复制'}
        </button>
      </div>

      <form className="site-customization-form" onSubmit={(event) => void save(event)}>
        <div className="site-settings-grid">
          <label>
            站点名称
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            公开路径
            <input
              value={slug}
              minLength={1}
              maxLength={60}
              pattern="[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?"
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
            />
          </label>
          <label>
            主题
            <select
              value={theme}
              onChange={(event) => setTheme(event.target.value as SiteSummary['theme'])}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label>
            Google Analytics
            <input
              value={googleAnalyticsId}
              maxLength={32}
              placeholder="G-XXXXXXXXXX"
              onChange={(event) => setGoogleAnalyticsId(event.target.value)}
            />
          </label>
          <label>
            Favicon
            <select
              value={faviconAttachmentId}
              onChange={(event) => setFaviconAttachmentId(event.target.value)}
            >
              <option value="">使用页面图标</option>
              {images.map((image) => (
                <option key={image.id} value={image.id}>
                  {image.originalName}
                </option>
              ))}
            </select>
          </label>
          <label>
            分享预览图
            <select
              value={shareImageAttachmentId}
              onChange={(event) => setShareImageAttachmentId(event.target.value)}
            >
              <option value="">使用默认预览</option>
              {images.map((image) => (
                <option key={image.id} value={image.id}>
                  {image.originalName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          SEO 标题
          <input
            value={seoTitle}
            maxLength={70}
            placeholder={`${pageTitle} · ${name || site.name}`}
            onChange={(event) => setSeoTitle(event.target.value)}
          />
        </label>
        <label>
          SEO 描述
          <textarea
            value={seoDescription}
            maxLength={200}
            rows={3}
            onChange={(event) => setSeoDescription(event.target.value)}
          />
        </label>
        <div className="site-toggle-grid">
          <label>
            <Search size={14} /> 站内搜索
            <input
              type="checkbox"
              checked={searchEnabled}
              onChange={(event) => setSearchEnabled(event.target.checked)}
            />
          </label>
          <label>
            <Globe2 size={14} /> 页面面包屑
            <input
              type="checkbox"
              checked={breadcrumbsEnabled}
              onChange={(event) => setBreadcrumbsEnabled(event.target.checked)}
            />
          </label>
          <label>
            <Globe2 size={14} /> Rdocs 标识
            <input
              type="checkbox"
              checked={watermarkEnabled}
              onChange={(event) => setWatermarkEnabled(event.target.checked)}
            />
          </label>
          <label>
            <Search size={14} /> 允许搜索引擎收录
            <input
              type="checkbox"
              checked={searchEngineIndexing}
              onChange={(event) => setSearchEngineIndexing(event.target.checked)}
            />
          </label>
        </div>
        <button type="submit" disabled={busy || !name.trim() || !slug.trim()}>
          {busy ? '保存中…' : '保存站点设置'}
        </button>
      </form>

      <div className="site-pages-heading">
        <span>
          <strong>页面与导航</strong>
          <small>{site.pages.filter((page) => page.isVisible).length} 个公开页面</small>
        </span>
        <button type="button" disabled={busy} onClick={() => void syncPages()}>
          <RefreshCw size={13} /> 同步子页面
        </button>
      </div>
      <div className="site-pages-list">
        {site.pages.map((publishedPage) => {
          const navigationIndex = navigation.findIndex(
            (candidate) => candidate.page.id === publishedPage.page.id,
          );
          return (
            <article
              key={publishedPage.page.id}
              className={!publishedPage.isVisible ? 'hidden' : ''}
            >
              <span className="site-page-icon">{publishedPage.page.icon || '◇'}</span>
              <div>
                <strong>{publishedPage.page.title}</strong>
                <small>{publishedPage.isHome ? '/' : `/${publishedPage.slug}`}</small>
              </div>
              {!publishedPage.isHome ? (
                <input
                  key={publishedPage.slug}
                  aria-label={`${publishedPage.page.title}路径`}
                  defaultValue={publishedPage.slug}
                  maxLength={60}
                  pattern="[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?"
                  disabled={pageBusy === publishedPage.page.id}
                  onBlur={(event) => {
                    const next = event.target.value.trim().toLowerCase();
                    event.target.value = next;
                    if (next && next !== publishedPage.slug) {
                      void changePage(publishedPage, { slug: next });
                    }
                  }}
                />
              ) : null}
              <label title="公开页面">
                <input
                  type="checkbox"
                  checked={publishedPage.isVisible}
                  disabled={publishedPage.isHome || pageBusy === publishedPage.page.id}
                  onChange={(event) =>
                    void changePage(publishedPage, { isVisible: event.target.checked })
                  }
                />
                公开
              </label>
              <label title="显示在导航栏">
                <input
                  type="checkbox"
                  checked={publishedPage.navigationOrder !== null}
                  disabled={!publishedPage.isVisible || pageBusy === publishedPage.page.id}
                  onChange={(event) =>
                    void changePage(publishedPage, { inNavigation: event.target.checked })
                  }
                />
                导航
              </label>
              {navigationIndex >= 0 ? (
                <span className="site-page-order">
                  <button
                    type="button"
                    aria-label="导航上移"
                    disabled={navigationIndex === 0 || pageBusy === publishedPage.page.id}
                    onClick={() =>
                      void changePage(publishedPage, { navigationOrder: navigationIndex - 1 })
                    }
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="导航下移"
                    disabled={
                      navigationIndex === navigation.length - 1 ||
                      pageBusy === publishedPage.page.id
                    }
                    onClick={() =>
                      void changePage(publishedPage, { navigationOrder: navigationIndex + 1 })
                    }
                  >
                    <ChevronDown size={12} />
                  </button>
                </span>
              ) : null}
            </article>
          );
        })}
      </div>

      <div className="site-analytics">
        <header>
          <span>
            <BarChart3 size={15} /> 最近 30 天
          </span>
          <small>
            {totals.views} 浏览 · {totals.visitors} 访客日 · {totals.searches} 搜索
          </small>
        </header>
        <div className="site-analytics-bars" aria-label="站点浏览趋势">
          {analytics.length ? (
            analytics.map((day) => (
              <span key={day.date} title={`${day.date} · ${day.pageViews} 浏览`}>
                <i style={{ height: `${Math.max(4, (day.pageViews / maxViews) * 100)}%` }} />
              </span>
            ))
          ) : (
            <p>发布后会在这里显示匿名聚合趋势。</p>
          )}
        </div>
      </div>

      <div className="site-analytics">
        <header>
          <span>
            <Globe2 size={15} /> 自定义域名
          </span>
        </header>
        <p>
          添加域名后，把 <code>/.well-known/rdocs-site-verify</code>{' '}
          配成验证串，再点验证。证书绑定仍需 RandallFlare 已提供的自定义主机名接口。
        </p>
        <form
          className="member-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!site || !domainHostname.trim()) return;
            setBusy(true);
            void addSiteDomain(site.id, domainHostname.trim())
              .then(async () => populate((await getPageSite(pageId)).site))
              .catch((reason) => setError(failure(reason, '无法添加域名')))
              .finally(() => setBusy(false));
          }}
        >
          <input
            value={domainHostname}
            onChange={(event) => setDomainHostname(event.target.value)}
            placeholder="docs.example.com"
          />
          <button className="primary-button" type="submit" disabled={busy}>
            添加域名
          </button>
        </form>
        {(site.domains ?? []).map((domain) => (
          <div key={domain.id} className="invite-link-result">
            <strong>{domain.hostname}</strong>
            <small>
              {domain.status} · {domain.verificationToken}
            </small>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void verifySiteDomain(site.id, domain.id)
                  .then(async () => populate((await getPageSite(pageId)).site))
                  .catch((reason) => setError(failure(reason, '验证失败')))
                  .finally(() => setBusy(false));
              }}
            >
              验证
            </button>
          </div>
        ))}
      </div>

      <button
        className="site-unpublish"
        type="button"
        disabled={busy}
        onClick={() => void takeOffline()}
      >
        <Unplug size={14} /> 取消发布
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
