PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  root_page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  favicon_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  share_image_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  seo_title TEXT,
  seo_description TEXT,
  search_enabled INTEGER NOT NULL DEFAULT 1 CHECK (search_enabled IN (0, 1)),
  breadcrumbs_enabled INTEGER NOT NULL DEFAULT 1 CHECK (breadcrumbs_enabled IN (0, 1)),
  watermark_enabled INTEGER NOT NULL DEFAULT 1 CHECK (watermark_enabled IN (0, 1)),
  search_engine_indexing INTEGER NOT NULL DEFAULT 0 CHECK (search_engine_indexing IN (0, 1)),
  google_analytics_id TEXT,
  published_at INTEGER,
  unpublished_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (published_at IS NOT NULL AND unpublished_at IS NULL)
    OR (published_at IS NOT NULL AND unpublished_at IS NOT NULL)
  )
);
CREATE INDEX idx_sites_organization ON sites(organization_id, updated_at DESC);
CREATE INDEX idx_sites_live_slug ON sites(slug, unpublished_at);

CREATE TABLE site_pages (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,
  is_home INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0, 1)),
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  navigation_label TEXT,
  navigation_order INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, page_id),
  UNIQUE(site_id, slug)
);
CREATE UNIQUE INDEX idx_site_pages_home
  ON site_pages(site_id) WHERE is_home = 1;
CREATE INDEX idx_site_pages_navigation
  ON site_pages(site_id, navigation_order, page_id)
  WHERE is_visible = 1 AND navigation_order IS NOT NULL;

CREATE TABLE site_analytics_daily (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL DEFAULT '',
  metric_date TEXT NOT NULL,
  page_views INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, page_id, metric_date)
);
CREATE INDEX idx_site_analytics_daily_site
  ON site_analytics_daily(site_id, metric_date DESC);

CREATE TABLE site_analytics_visitors (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY(site_id, session_hash, metric_date)
);
CREATE INDEX idx_site_analytics_visitors_site
  ON site_analytics_visitors(site_id, metric_date DESC);
