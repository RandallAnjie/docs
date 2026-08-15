import type {
  AuthUserSummary,
  PageSummary,
  PublishedSiteDatabaseView,
  SiteAnalyticsDay,
  SiteDomainSummary,
  SitePageSummary,
  SiteSearchResult,
  SiteSummary,
  SiteTheme,
} from '@rdocs/shared';

import { requirePageAction } from './access';
import type { Env } from './env';
import { signCollabTicket } from './tickets';

const MAX_SITE_PAGES = 500;
const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const GOOGLE_ANALYTICS_PATTERN = /^G-[A-Z0-9]{4,20}$/;

interface SiteRow {
  id: string;
  organization_id: string;
  root_page_id: string;
  slug: string;
  name: string;
  theme: SiteTheme;
  favicon_attachment_id: string | null;
  share_image_attachment_id: string | null;
  seo_title: string | null;
  seo_description: string | null;
  search_enabled: number;
  breadcrumbs_enabled: number;
  watermark_enabled: number;
  search_engine_indexing: number;
  google_analytics_id: string | null;
  published_at: number;
  unpublished_at: number | null;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface SitePageRow {
  site_id: string;
  page_id: string;
  slug: string;
  is_home: number;
  is_visible: number;
  navigation_label: string | null;
  navigation_order: number | null;
  created_at: number;
  updated_at: number;
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  cover_attachment_id: string | null;
  font_style: 'sans' | 'serif' | 'mono';
  is_full_width: number;
  is_small_text: number;
  is_locked: number;
  current_generation: number;
  editor_schema_version: number;
  updated_at_page: number;
  collaboration_enabled: number;
  acl_version: number;
}

interface EligiblePageRow {
  id: string;
  title: string;
}

interface SyncedBlockRow {
  id: string;
  organization_id: string;
  source_page_id: string;
  current_generation: number;
  acl_version: number;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number): Response {
  return json({ error: message }, { status });
}

function pageFromRow(row: SitePageRow): PageSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    icon: row.icon,
    coverAttachmentId: row.cover_attachment_id,
    fontStyle: row.font_style,
    isFullWidth: Boolean(row.is_full_width),
    isSmallText: Boolean(row.is_small_text),
    isLocked: Boolean(row.is_locked),
    currentGeneration: Number(row.current_generation),
    editorSchemaVersion: Number(row.editor_schema_version),
    updatedAt: Number(row.updated_at_page),
    collaborationEnabled: Boolean(row.collaboration_enabled),
    aclVersion: Number(row.acl_version),
    role: 'viewer',
  };
}

function sitePageFromRow(row: SitePageRow): SitePageSummary {
  return {
    page: pageFromRow(row),
    slug: row.slug,
    isHome: Boolean(row.is_home),
    isVisible: Boolean(row.is_visible),
    navigationLabel: row.navigation_label,
    navigationOrder: row.navigation_order === null ? null : Number(row.navigation_order),
  };
}

function siteFromRow(
  row: SiteRow,
  pages: SitePageSummary[],
  extras: {
    domains?: SiteDomainSummary[];
    publishedDatabaseViews?: PublishedSiteDatabaseView[];
  } = {},
): SiteSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    rootPageId: row.root_page_id,
    slug: row.slug,
    name: row.name,
    theme: row.theme,
    faviconAttachmentId: row.favicon_attachment_id,
    shareImageAttachmentId: row.share_image_attachment_id,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    searchEnabled: Boolean(row.search_enabled),
    breadcrumbsEnabled: Boolean(row.breadcrumbs_enabled),
    watermarkEnabled: Boolean(row.watermark_enabled),
    searchEngineIndexing: Boolean(row.search_engine_indexing),
    googleAnalyticsId: row.google_analytics_id,
    publishedAt: Number(row.published_at),
    unpublishedAt: row.unpublished_at === null ? null : Number(row.unpublished_at),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    pages,
    domains: extras.domains ?? [],
    publishedDatabaseViews: extras.publishedDatabaseViews ?? [],
  };
}

function normalizeSiteSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return SITE_SLUG_PATTERN.test(slug) ? slug : null;
}

function normalizePageSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return PAGE_SLUG_PATTERN.test(slug) ? slug : null;
}

function boundedString(
  value: unknown,
  maxLength: number,
  allowNull = true,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function titleSlug(title: string, pageId: string): string {
  const normalized = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return normalized || `page-${pageId.slice(0, 8).toLowerCase()}`;
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function publicSiteIds(request: Request): string[] {
  const value = cookieValue(request, 'rdocs_public_sites');
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length <= 100).slice(-5)
      : [];
  } catch {
    return [];
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function findSiteById(env: Env, siteId: string): Promise<SiteRow | null> {
  return env.DB.prepare(
    `SELECT id, organization_id, root_page_id, slug, name, theme,
            favicon_attachment_id, share_image_attachment_id, seo_title,
            seo_description, search_enabled, breadcrumbs_enabled,
            watermark_enabled, search_engine_indexing, google_analytics_id,
            published_at, unpublished_at, created_by, updated_by, created_at, updated_at
       FROM sites WHERE id = ?`,
  )
    .bind(siteId)
    .first<SiteRow>();
}

async function findSiteByRootPage(env: Env, pageId: string): Promise<SiteRow | null> {
  return env.DB.prepare(
    `SELECT id, organization_id, root_page_id, slug, name, theme,
            favicon_attachment_id, share_image_attachment_id, seo_title,
            seo_description, search_enabled, breadcrumbs_enabled,
            watermark_enabled, search_engine_indexing, google_analytics_id,
            published_at, unpublished_at, created_by, updated_by, created_at, updated_at
       FROM sites WHERE root_page_id = ?`,
  )
    .bind(pageId)
    .first<SiteRow>();
}

async function findLiveSiteBySlug(env: Env, slug: string): Promise<SiteRow | null> {
  return env.DB.prepare(
    `SELECT id, organization_id, root_page_id, slug, name, theme,
            favicon_attachment_id, share_image_attachment_id, seo_title,
            seo_description, search_enabled, breadcrumbs_enabled,
            watermark_enabled, search_engine_indexing, google_analytics_id,
            published_at, unpublished_at, created_by, updated_by, created_at, updated_at
       FROM sites WHERE slug = ? COLLATE NOCASE AND unpublished_at IS NULL`,
  )
    .bind(slug)
    .first<SiteRow>();
}

async function sitePages(env: Env, siteId: string): Promise<SitePageSummary[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT sp.site_id, sp.page_id, sp.slug, sp.is_home, sp.is_visible,
              sp.navigation_label, sp.navigation_order, sp.created_at, sp.updated_at,
              p.id, p.organization_id, p.space_id, p.parent_id, p.title, p.icon,
              p.cover_attachment_id, p.font_style, p.is_full_width, p.is_small_text,
              p.is_locked, p.current_generation, p.editor_schema_version,
              p.updated_at AS updated_at_page,
              a.collaboration_enabled, a.acl_version
         FROM site_pages sp
         JOIN pages p ON p.id = sp.page_id AND p.deleted_at IS NULL
         JOIN page_access_state a ON a.page_id = p.id
        WHERE sp.site_id = ?
        ORDER BY sp.is_home DESC, sp.navigation_order IS NULL, sp.navigation_order,
                 p.sort_key, p.id
        LIMIT ?`,
    )
      .bind(siteId, MAX_SITE_PAGES)
      .all<SitePageRow>()
  ).results;
  return rows.map(sitePageFromRow);
}

function publiclyVisiblePages(site: SiteRow, pages: readonly SitePageSummary[]): SitePageSummary[] {
  const byId = new Map(pages.map((candidate) => [candidate.page.id, candidate]));
  const visible = new Set<string>();
  const visiting = new Set<string>();
  const isVisible = (candidate: SitePageSummary): boolean => {
    if (visible.has(candidate.page.id)) return true;
    if (!candidate.isVisible || visiting.has(candidate.page.id)) return false;
    if (candidate.page.id === site.root_page_id) {
      visible.add(candidate.page.id);
      return true;
    }
    visiting.add(candidate.page.id);
    const parent = candidate.page.parentId ? byId.get(candidate.page.parentId) : undefined;
    const allowed = Boolean(parent && isVisible(parent));
    visiting.delete(candidate.page.id);
    if (allowed) visible.add(candidate.page.id);
    return allowed;
  };
  return pages.filter(isVisible);
}

async function siteDomains(env: Env, siteId: string): Promise<SiteDomainSummary[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, site_id, hostname, verification_token, status, last_checked_at, error_message,
              created_at, updated_at
         FROM site_domains WHERE site_id = ? ORDER BY created_at DESC`,
    )
      .bind(siteId)
      .all<{
        id: string;
        site_id: string;
        hostname: string;
        verification_token: string;
        status: SiteDomainSummary['status'];
        last_checked_at: number | null;
        error_message: string | null;
        created_at: number;
        updated_at: number;
      }>()
  ).results;
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    hostname: row.hostname,
    verificationToken: row.verification_token,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

async function publishedDatabaseViews(
  env: Env,
  siteId: string,
): Promise<PublishedSiteDatabaseView[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT site_id, database_id, view_id, published
         FROM site_database_views WHERE site_id = ?`,
    )
      .bind(siteId)
      .all<{ site_id: string; database_id: string; view_id: string; published: number }>()
  ).results;
  return rows.map((row) => ({
    siteId: row.site_id,
    databaseId: row.database_id,
    viewId: row.view_id,
    published: Boolean(row.published),
  }));
}

async function siteSummary(env: Env, row: SiteRow): Promise<SiteSummary> {
  const [pages, domains, views] = await Promise.all([
    sitePages(env, row.id),
    siteDomains(env, row.id),
    publishedDatabaseViews(env, row.id),
  ]);
  return siteFromRow(row, pages, { domains, publishedDatabaseViews: views });
}

async function audit(
  env: Env,
  site: SiteRow,
  actorId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events(
       id, organization_id, actor_id, event_type, target_type, target_id,
       request_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, 'site', ?, NULL, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      site.organization_id,
      actorId,
      eventType,
      site.id,
      JSON.stringify(metadata),
      Date.now(),
    )
    .run();
}

async function refreshSitePages(env: Env, site: SiteRow): Promise<void> {
  const eligible = (
    await env.DB.prepare(
      `WITH RECURSIVE tree(id, blocked, depth) AS (
         SELECT p.id, 0, 0
           FROM pages p
          WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
         UNION ALL
         SELECT child.id,
                CASE
                  WHEN tree.blocked = 1
                    OR COALESCE(state.access_mode, 'inherit') = 'restricted'
                    OR structured.id IS NOT NULL
                    OR template.id IS NOT NULL
                    THEN 1 ELSE 0
                END,
                tree.depth + 1
           FROM tree
           JOIN pages child ON child.parent_id = tree.id
           LEFT JOIN page_access_state state ON state.page_id = child.id
           LEFT JOIN databases structured ON structured.page_id = child.id
           LEFT JOIN database_templates template ON template.page_id = child.id
          WHERE child.organization_id = ? AND child.deleted_at IS NULL AND tree.depth < 100
       )
       SELECT p.id, p.title
         FROM tree
         JOIN pages p ON p.id = tree.id
        WHERE tree.blocked = 0
        ORDER BY tree.depth, p.sort_key, p.id
        LIMIT ?`,
    )
      .bind(site.root_page_id, site.organization_id, site.organization_id, MAX_SITE_PAGES)
      .all<EligiblePageRow>()
  ).results;
  if (!eligible.some((page) => page.id === site.root_page_id)) {
    throw new Error('site_root_page_missing');
  }
  const existing = (
    await env.DB.prepare('SELECT page_id, slug FROM site_pages WHERE site_id = ?')
      .bind(site.id)
      .all<{ page_id: string; slug: string }>()
  ).results;
  const existingByPage = new Map(existing.map((row) => [row.page_id, row.slug]));
  const usedSlugs = new Set(existing.map((row) => row.slug.toLowerCase()));
  const eligibleIds = new Set(eligible.map((page) => page.id));
  const now = Date.now();
  const statements: D1PreparedStatement[] = existing
    .filter((row) => !eligibleIds.has(row.page_id))
    .map((row) =>
      env.DB.prepare(
        'UPDATE site_pages SET is_visible = 0, updated_at = ? WHERE site_id = ? AND page_id = ?',
      ).bind(now, site.id, row.page_id),
    );
  for (const page of eligible) {
    const existingSlug = existingByPage.get(page.id);
    let slug =
      page.id === site.root_page_id ? 'home' : (existingSlug ?? titleSlug(page.title, page.id));
    if (!existingSlug && usedSlugs.has(slug.toLowerCase())) {
      slug = `${slug.slice(0, 48)}-${page.id.slice(0, 8).toLowerCase()}`;
    }
    usedSlugs.add(slug.toLowerCase());
    statements.push(
      env.DB.prepare(
        `INSERT INTO site_pages(
           site_id, page_id, slug, is_home, is_visible, navigation_label,
           navigation_order, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, ?)
         ON CONFLICT(site_id, page_id) DO UPDATE SET
           is_home = excluded.is_home,
           updated_at = excluded.updated_at`,
      ).bind(site.id, page.id, slug, page.id === site.root_page_id ? 1 : 0, now, now),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.batch(statements.slice(offset, offset + 50));
  }
  if (eligibleIds.size !== eligible.length) throw new Error('site_page_duplicate');
}

async function validSiteImageAttachment(
  env: Env,
  site: SiteRow,
  attachmentId: string | null,
): Promise<boolean> {
  if (attachmentId === null) return true;
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 AS found
         FROM attachments attachment
         JOIN site_pages page ON page.page_id = attachment.page_id AND page.site_id = ?
        WHERE attachment.id = ? AND attachment.status = 'ready'
          AND attachment.deleted_at IS NULL AND attachment.mime_type LIKE 'image/%'
        LIMIT 1`,
    )
      .bind(site.id, attachmentId)
      .first<{ found: number }>(),
  );
}

async function publishSite(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  pageId: string,
): Promise<Response> {
  const access = await requirePageAction(env, pageId, actor.id, 'manage_access');
  if (!access) return error('页面不存在或无权发布站点', 404);
  if (
    await env.DB.prepare('SELECT 1 AS found FROM databases WHERE page_id = ? LIMIT 1')
      .bind(pageId)
      .first<{ found: number }>()
  ) {
    return error('数据库公开站点视图尚未启用，请先选择普通页面作为站点首页', 400);
  }
  const input = (await request.json().catch(() => null)) as {
    slug?: unknown;
    name?: unknown;
  } | null;
  const slug = normalizeSiteSlug(input?.slug);
  const name = boundedString(input?.name, 100, false);
  if (!slug || !name) return error('站点名称或路径无效', 400);
  const existing = await findSiteByRootPage(env, pageId);
  const now = Date.now();
  if (existing) {
    try {
      await env.DB.prepare(
        `UPDATE sites
            SET slug = ?, name = ?, unpublished_at = NULL, published_at = ?,
                updated_by = ?, updated_at = ?
          WHERE id = ?`,
      )
        .bind(slug, name, now, actor.id, now, existing.id)
        .run();
    } catch {
      return error('站点路径已被占用', 409);
    }
    const updated = await findSiteById(env, existing.id);
    if (!updated) return error('站点发布结果丢失', 500);
    await refreshSitePages(env, updated);
    await audit(env, updated, actor.id, 'site.published');
    return json({ site: await siteSummary(env, updated) });
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO sites(
         id, organization_id, root_page_id, slug, name, theme,
         favicon_attachment_id, share_image_attachment_id, seo_title, seo_description,
         search_enabled, breadcrumbs_enabled, watermark_enabled, search_engine_indexing,
         google_analytics_id, published_at, unpublished_at, created_by, updated_by,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'system', NULL, NULL, NULL, NULL,
                 1, 1, 1, 0, NULL, ?, NULL, ?, ?, ?, ?)`,
    )
      .bind(id, access.organizationId, pageId, slug, name, now, actor.id, actor.id, now, now)
      .run();
  } catch {
    return error('站点路径已被占用，或页面已经发布', 409);
  }
  const site = await findSiteById(env, id);
  if (!site) return error('站点发布结果丢失', 500);
  await refreshSitePages(env, site);
  await audit(env, site, actor.id, 'site.created', { rootPageId: pageId, slug });
  return json({ site: await siteSummary(env, site) }, { status: 201 });
}

async function updateSite(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  site: SiteRow,
): Promise<Response> {
  if (!(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
    return error('站点不存在或无权管理', 404);
  }
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input) return error('请求格式无效', 400);
  const current = await siteSummary(env, site);
  const slug = input.slug === undefined ? current.slug : normalizeSiteSlug(input.slug);
  const name = input.name === undefined ? current.name : boundedString(input.name, 100, false);
  const theme = input.theme === undefined ? current.theme : input.theme;
  const seoTitle =
    input.seoTitle === undefined ? current.seoTitle : boundedString(input.seoTitle, 70);
  const seoDescription =
    input.seoDescription === undefined
      ? current.seoDescription
      : boundedString(input.seoDescription, 200);
  const faviconAttachmentId =
    input.faviconAttachmentId === undefined
      ? current.faviconAttachmentId
      : boundedString(input.faviconAttachmentId, 100);
  const shareImageAttachmentId =
    input.shareImageAttachmentId === undefined
      ? current.shareImageAttachmentId
      : boundedString(input.shareImageAttachmentId, 100);
  const googleAnalyticsId =
    input.googleAnalyticsId === undefined
      ? current.googleAnalyticsId
      : boundedString(input.googleAnalyticsId, 32);
  const booleanValue = (key: keyof SiteSummary): boolean | null => {
    const value = input[key];
    if (value === undefined) return current[key] as boolean;
    return typeof value === 'boolean' ? value : null;
  };
  const searchEnabled = booleanValue('searchEnabled');
  const breadcrumbsEnabled = booleanValue('breadcrumbsEnabled');
  const watermarkEnabled = booleanValue('watermarkEnabled');
  const searchEngineIndexing = booleanValue('searchEngineIndexing');
  if (
    !slug ||
    !name ||
    (theme !== 'system' && theme !== 'light' && theme !== 'dark') ||
    seoTitle === undefined ||
    seoDescription === undefined ||
    faviconAttachmentId === undefined ||
    shareImageAttachmentId === undefined ||
    googleAnalyticsId === undefined ||
    searchEnabled === null ||
    breadcrumbsEnabled === null ||
    watermarkEnabled === null ||
    searchEngineIndexing === null ||
    (googleAnalyticsId !== null && !GOOGLE_ANALYTICS_PATTERN.test(googleAnalyticsId))
  ) {
    return error('站点设置无效', 400);
  }
  if (
    !(await validSiteImageAttachment(env, site, faviconAttachmentId)) ||
    !(await validSiteImageAttachment(env, site, shareImageAttachmentId))
  ) {
    return error('站点图片必须来自已发布页面的有效图片附件', 400);
  }
  const now = Date.now();
  try {
    await env.DB.prepare(
      `UPDATE sites
          SET slug = ?, name = ?, theme = ?, favicon_attachment_id = ?,
              share_image_attachment_id = ?, seo_title = ?, seo_description = ?,
              search_enabled = ?, breadcrumbs_enabled = ?, watermark_enabled = ?,
              search_engine_indexing = ?, google_analytics_id = ?,
              updated_by = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        slug,
        name,
        theme,
        faviconAttachmentId,
        shareImageAttachmentId,
        seoTitle,
        seoDescription,
        searchEnabled ? 1 : 0,
        breadcrumbsEnabled ? 1 : 0,
        watermarkEnabled ? 1 : 0,
        searchEngineIndexing ? 1 : 0,
        googleAnalyticsId,
        actor.id,
        now,
        site.id,
      )
      .run();
  } catch {
    return error('站点路径已被占用', 409);
  }
  const updated = await findSiteById(env, site.id);
  if (!updated) return error('站点更新结果丢失', 500);
  await audit(env, updated, actor.id, 'site.updated');
  return json({ site: await siteSummary(env, updated) });
}

async function updateSitePage(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  site: SiteRow,
  pageId: string,
): Promise<Response> {
  if (!(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
    return error('站点不存在或无权管理', 404);
  }
  const page = await env.DB.prepare(
    'SELECT is_home, slug, is_visible, navigation_label, navigation_order FROM site_pages WHERE site_id = ? AND page_id = ?',
  )
    .bind(site.id, pageId)
    .first<{
      is_home: number;
      slug: string;
      is_visible: number;
      navigation_label: string | null;
      navigation_order: number | null;
    }>();
  if (!page) return error('站点页面不存在', 404);
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input) return error('请求格式无效', 400);
  const slug = page.is_home
    ? 'home'
    : input.slug === undefined
      ? page.slug
      : normalizePageSlug(input.slug);
  const isVisible =
    input.isVisible === undefined
      ? Boolean(page.is_visible)
      : typeof input.isVisible === 'boolean'
        ? input.isVisible
        : null;
  const inNavigation =
    input.inNavigation === undefined
      ? page.navigation_order !== null
      : typeof input.inNavigation === 'boolean'
        ? input.inNavigation
        : null;
  const navigationLabel =
    input.navigationLabel === undefined
      ? page.navigation_label
      : boundedString(input.navigationLabel, 60);
  const requestedNavigationOrder =
    input.navigationOrder === undefined
      ? null
      : typeof input.navigationOrder === 'number' &&
          Number.isInteger(input.navigationOrder) &&
          input.navigationOrder >= 0 &&
          input.navigationOrder < MAX_SITE_PAGES
        ? input.navigationOrder
        : undefined;
  if (
    !slug ||
    isVisible === null ||
    inNavigation === null ||
    navigationLabel === undefined ||
    requestedNavigationOrder === undefined
  ) {
    return error('页面路径或导航设置无效', 400);
  }
  if (isVisible && !(await requirePageAction(env, pageId, actor.id, 'manage_access'))) {
    return error('无权公开此页面', 404);
  }
  let navigationOrder: number | null = page.navigation_order;
  if (inNavigation && navigationOrder === null) {
    const last = await env.DB.prepare(
      'SELECT COALESCE(MAX(navigation_order), -1) AS position FROM site_pages WHERE site_id = ?',
    )
      .bind(site.id)
      .first<{ position: number }>();
    navigationOrder = Number(last?.position ?? -1) + 1;
  } else if (!inNavigation) {
    navigationOrder = null;
  }
  const now = Date.now();
  try {
    await env.DB.prepare(
      `UPDATE site_pages
          SET slug = ?, is_visible = ?, navigation_label = ?, navigation_order = ?, updated_at = ?
        WHERE site_id = ? AND page_id = ?`,
    )
      .bind(slug, isVisible ? 1 : 0, navigationLabel, navigationOrder, now, site.id, pageId)
      .run();
  } catch {
    return error('页面路径已被当前站点占用', 409);
  }
  if (inNavigation && requestedNavigationOrder !== null) {
    const navigationIds = (
      await env.DB.prepare(
        `SELECT page_id FROM site_pages
          WHERE site_id = ? AND is_visible = 1 AND navigation_order IS NOT NULL
          ORDER BY navigation_order, page_id`,
      )
        .bind(site.id)
        .all<{ page_id: string }>()
    ).results.map((row) => row.page_id);
    const reordered = navigationIds.filter((candidate) => candidate !== pageId);
    reordered.splice(Math.min(requestedNavigationOrder, reordered.length), 0, pageId);
    if (reordered.length) {
      const statements = reordered.map((candidate, index) =>
        env.DB.prepare(
          'UPDATE site_pages SET navigation_order = ?, updated_at = ? WHERE site_id = ? AND page_id = ?',
        ).bind(index, now, site.id, candidate),
      );
      for (let offset = 0; offset < statements.length; offset += 50) {
        await env.DB.batch(statements.slice(offset, offset + 50));
      }
    }
  }
  await audit(env, site, actor.id, 'site.page.updated', { pageId, isVisible, inNavigation });
  const updated = await findSiteById(env, site.id);
  return updated ? json({ site: await siteSummary(env, updated) }) : error('站点更新结果丢失', 500);
}

async function siteAnalytics(env: Env, site: SiteRow): Promise<SiteAnalyticsDay[]> {
  const rows = (
    await env.DB.prepare(
      `SELECT metric.metric_date,
              SUM(metric.page_views) AS page_views,
              SUM(metric.searches) AS searches,
              (SELECT COUNT(*) FROM site_analytics_visitors visitor
                WHERE visitor.site_id = ? AND visitor.metric_date = metric.metric_date
              ) AS unique_visitors
         FROM site_analytics_daily metric
        WHERE metric.site_id = ? AND metric.metric_date >= date('now', '-29 days')
        GROUP BY metric.metric_date
        ORDER BY metric.metric_date ASC`,
    )
      .bind(site.id, site.id)
      .all<{
        metric_date: string;
        page_views: number;
        searches: number;
        unique_visitors: number;
      }>()
  ).results;
  return rows.map((row) => ({
    date: row.metric_date,
    pageViews: Number(row.page_views),
    searches: Number(row.searches),
    uniqueVisitors: Number(row.unique_visitors),
  }));
}

export async function handleSitesApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pageSiteMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/site$/);
  if (pageSiteMatch?.[1]) {
    const pageId = decodeURIComponent(pageSiteMatch[1]);
    if (!(await requirePageAction(env, pageId, actor.id, 'manage_access'))) {
      return error('页面不存在或无权管理站点', 404);
    }
    if (request.method === 'GET') {
      const site = await findSiteByRootPage(env, pageId);
      return json({ site: site ? await siteSummary(env, site) : null });
    }
    if (request.method === 'POST') return publishSite(request, env, actor, pageId);
  }

  const syncMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/sync-pages$/);
  if (syncMatch?.[1] && request.method === 'POST') {
    const site = await findSiteById(env, decodeURIComponent(syncMatch[1]));
    if (!site || !(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
      return error('站点不存在或无权管理', 404);
    }
    await refreshSitePages(env, site);
    const updated = await findSiteById(env, site.id);
    await audit(env, site, actor.id, 'site.pages.synced');
    return updated
      ? json({ site: await siteSummary(env, updated) })
      : error('站点同步结果丢失', 500);
  }

  const analyticsMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/analytics$/);
  if (analyticsMatch?.[1] && request.method === 'GET') {
    const site = await findSiteById(env, decodeURIComponent(analyticsMatch[1]));
    if (!site || !(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
      return error('站点不存在或无权查看分析', 404);
    }
    return json({ days: await siteAnalytics(env, site) });
  }

  const sitePageMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/pages\/([^/]+)$/);
  if (sitePageMatch?.[1] && sitePageMatch[2] && request.method === 'PATCH') {
    const site = await findSiteById(env, decodeURIComponent(sitePageMatch[1]));
    return site
      ? updateSitePage(request, env, actor, site, decodeURIComponent(sitePageMatch[2]))
      : error('站点不存在', 404);
  }

  const siteMatch = url.pathname.match(/^\/api\/sites\/([^/]+)$/);
  if (siteMatch?.[1]) {
    const site = await findSiteById(env, decodeURIComponent(siteMatch[1]));
    if (!site) return error('站点不存在', 404);
    if (request.method === 'PATCH') return updateSite(request, env, actor, site);
    if (request.method === 'DELETE') {
      if (!(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
        return error('站点不存在或无权取消发布', 404);
      }
      const now = Date.now();
      await env.DB.prepare(
        'UPDATE sites SET unpublished_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND unpublished_at IS NULL',
      )
        .bind(now, actor.id, now, site.id)
        .run();
      await audit(env, site, actor.id, 'site.unpublished');
      const updated = await findSiteById(env, site.id);
      return updated
        ? json({ site: await siteSummary(env, updated) })
        : error('站点取消发布结果丢失', 500);
    }
  }

  const domainVerifyMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/domains\/([^/]+)\/verify$/);
  if (domainVerifyMatch?.[1] && domainVerifyMatch[2] && request.method === 'POST') {
    const site = await findSiteById(env, decodeURIComponent(domainVerifyMatch[1]));
    if (!site || !(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
      return error('站点不存在或无权管理域名', 404);
    }
    return verifySiteDomain(env, site, decodeURIComponent(domainVerifyMatch[2]));
  }

  const domainsMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/domains$/);
  if (domainsMatch?.[1]) {
    const site = await findSiteById(env, decodeURIComponent(domainsMatch[1]));
    if (!site || !(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
      return error('站点不存在或无权管理域名', 404);
    }
    if (request.method === 'GET') return json({ domains: await siteDomains(env, site.id) });
    if (request.method === 'POST') {
      const input = (await request.json().catch(() => null)) as { hostname?: unknown } | null;
      const hostname =
        typeof input?.hostname === 'string' ? input.hostname.trim().toLowerCase() : '';
      if (
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          hostname,
        )
      ) {
        return error('域名无效', 400);
      }
      const id = crypto.randomUUID();
      const token = `rdocs-site=${crypto.randomUUID().replace(/-/g, '')}`;
      const now = Date.now();
      try {
        await env.DB.prepare(
          `INSERT INTO site_domains(id, site_id, hostname, verification_token, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
          .bind(id, site.id, hostname, token, now, now)
          .run();
      } catch {
        return error('该域名已被占用', 409);
      }
      await audit(env, site, actor.id, 'site.domain.created', { hostname });
      return json(
        { domain: (await siteDomains(env, site.id)).find((item) => item.id === id) },
        { status: 201 },
      );
    }
  }

  const domainMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/domains\/([^/]+)$/);
  if (domainMatch?.[1] && domainMatch[2] && request.method === 'DELETE') {
    const site = await findSiteById(env, decodeURIComponent(domainMatch[1]));
    if (!site || !(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
      return error('站点不存在或无权管理域名', 404);
    }
    const result = await env.DB.prepare('DELETE FROM site_domains WHERE id = ? AND site_id = ?')
      .bind(decodeURIComponent(domainMatch[2]), site.id)
      .run();
    if (!result.meta.changes) return error('域名不存在', 404);
    return json({ ok: true });
  }

  const databaseViewsMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/database-views$/);
  if (databaseViewsMatch?.[1] && request.method === 'PUT') {
    const site = await findSiteById(env, decodeURIComponent(databaseViewsMatch[1]));
    if (!site || !(await requirePageAction(env, site.root_page_id, actor.id, 'manage_access'))) {
      return error('站点不存在或无权发布数据库视图', 404);
    }
    const input = (await request.json().catch(() => null)) as {
      databaseId?: unknown;
      viewId?: unknown;
      published?: unknown;
    } | null;
    const databaseId = typeof input?.databaseId === 'string' ? input.databaseId : '';
    const viewId = typeof input?.viewId === 'string' ? input.viewId : '';
    if (!databaseId || !viewId) return error('数据库或视图无效', 400);
    const view = await env.DB.prepare(
      `SELECT v.id, v.database_id, d.organization_id
         FROM database_views v JOIN databases d ON d.id = v.database_id
        WHERE v.id = ? AND v.database_id = ? AND d.organization_id = ?`,
    )
      .bind(viewId, databaseId, site.organization_id)
      .first<{ id: string }>();
    if (!view) return error('数据库视图不存在或不属于当前组织', 404);
    if (input?.published === false) {
      await env.DB.prepare('DELETE FROM site_database_views WHERE site_id = ? AND view_id = ?')
        .bind(site.id, viewId)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO site_database_views(site_id, database_id, view_id, published, created_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(site_id, view_id) DO UPDATE SET published = 1, database_id = excluded.database_id`,
      )
        .bind(site.id, databaseId, viewId, Date.now())
        .run();
    }
    return json({ site: await siteSummary(env, site) });
  }

  return null;
}

async function verifySiteDomain(env: Env, site: SiteRow, domainId: string): Promise<Response> {
  const domain = await env.DB.prepare(
    `SELECT id, hostname, verification_token FROM site_domains WHERE id = ? AND site_id = ?`,
  )
    .bind(domainId, site.id)
    .first<{ id: string; hostname: string; verification_token: string }>();
  if (!domain) return error('域名不存在', 404);
  const wellKnown = `https://${domain.hostname}/.well-known/rdocs-site-verify`;
  let status: SiteDomainSummary['status'] = 'failed';
  let message = '未读取到验证文件';
  try {
    const response = await fetch(wellKnown, { method: 'GET', redirect: 'manual' });
    const body = response.ok ? (await response.text()).trim() : '';
    if (body.includes(domain.verification_token)) {
      status = 'verified';
      message = '';
    } else {
      message = `验证文件内容不匹配（HTTP ${response.status}）`;
    }
  } catch (reason) {
    message = reason instanceof Error ? reason.message : '无法访问自定义域名';
  }
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE site_domains SET status = ?, last_checked_at = ?, error_message = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(status, now, message || null, now, domain.id)
    .run();
  return json({ domains: await siteDomains(env, site.id) });
}

async function publicSitePageResponse(
  request: Request,
  env: Env,
  site: SiteRow,
  requestedSlug: string | null,
): Promise<Response> {
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) {
    return error('协作服务尚未配置', 503);
  }
  const pages = await sitePages(env, site.id);
  const visible = publiclyVisiblePages(site, pages);
  const selected = requestedSlug
    ? visible.find((candidate) => !candidate.isHome && candidate.slug === requestedSlug)
    : visible.find((candidate) => candidate.isHome);
  if (!selected || !selected.page.collaborationEnabled) return error('站点页面不存在', 404);
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;
  const ticket = await signCollabTicket(
    {
      version: 1,
      pageId: selected.page.id,
      generation: selected.page.currentGeneration,
      actorId: `site_${site.id}`,
      displayName: '站点访客',
      role: 'viewer',
      aclVersion: selected.page.aclVersion,
      issuedAt: now,
      expiresAt,
    },
    env.COLLAB_TICKET_SECRET,
  );
  const remembered = [...publicSiteIds(request).filter((id) => id !== site.id), site.id].slice(-5);
  return json(
    {
      site: siteFromRow(site, visible),
      currentPage: selected,
      ticket,
      expiresAt,
    },
    {
      headers: {
        'set-cookie': `rdocs_public_sites=${encodeURIComponent(JSON.stringify(remembered))}; Path=/api/attachments/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`,
      },
    },
  );
}

async function searchPublicSite(env: Env, site: SiteRow, rawQuery: string): Promise<Response> {
  if (!site.search_enabled) return error('站点搜索未启用', 404);
  const query = rawQuery.trim().toLowerCase().slice(0, 100);
  if (!query) return json({ results: [] });
  const pages = publiclyVisiblePages(site, await sitePages(env, site.id));
  if (!pages.length) return json({ results: [] });
  const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
  const rows = (
    await env.DB.prepare(
      `SELECT p.id, p.title, p.icon, p.updated_at, projection.normalized_body
         FROM pages p
         JOIN site_pages published
           ON published.page_id = p.id AND published.site_id = ? AND published.is_visible = 1
         JOIN page_search_projection projection ON projection.page_id = p.id
        WHERE (LOWER(p.title) LIKE ? ESCAPE '\\'
            OR projection.normalized_body LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN LOWER(p.title) = ? THEN 0 ELSE 1 END, p.updated_at DESC
        LIMIT ?`,
    )
      .bind(site.id, `%${escaped}%`, `%${escaped}%`, query, MAX_SITE_PAGES)
      .all<{
        id: string;
        title: string;
        icon: string | null;
        updated_at: number;
        normalized_body: string;
      }>()
  ).results;
  const byId = new Map(pages.map((page) => [page.page.id, page]));
  const results: SiteSearchResult[] = rows.flatMap((row) => {
    const published = byId.get(row.id);
    if (!published) return [];
    const index = row.normalized_body.toLowerCase().indexOf(query);
    const start = Math.max(0, index < 0 ? 0 : index - 60);
    return [
      {
        pageId: row.id,
        title: row.title,
        icon: row.icon,
        slug: published.isHome ? '' : published.slug,
        excerpt: row.normalized_body.slice(start, start + 180),
        updatedAt: Number(row.updated_at),
      },
    ];
  });
  return json({ results: results.slice(0, 30) });
}

async function recordPublicSiteEvent(request: Request, env: Env, site: SiteRow): Promise<Response> {
  const requestOrigin = request.headers.get('origin');
  if (!requestOrigin || requestOrigin !== new URL(request.url).origin) {
    return error('请求来源不允许', 403);
  }
  const input = (await request.json().catch(() => null)) as {
    type?: unknown;
    pageId?: unknown;
    sessionId?: unknown;
  } | null;
  const type = input?.type;
  const pageId = typeof input?.pageId === 'string' ? input.pageId : '';
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
  if ((type !== 'page_view' && type !== 'search') || !/^[a-zA-Z0-9_-]{16,100}$/.test(sessionId)) {
    return error('分析事件无效', 400);
  }
  const pages = publiclyVisiblePages(site, await sitePages(env, site.id));
  if (pageId && !pages.some((candidate) => candidate.page.id === pageId)) {
    return error('站点页面不存在', 404);
  }
  const date = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const sessionHash = await sha256Hex(`${site.id}:${date}:${sessionId}`);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO site_analytics_daily(
         site_id, page_id, metric_date, page_views, searches, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, page_id, metric_date) DO UPDATE SET
         page_views = page_views + excluded.page_views,
         searches = searches + excluded.searches,
         updated_at = excluded.updated_at`,
    ).bind(site.id, pageId, date, type === 'page_view' ? 1 : 0, type === 'search' ? 1 : 0, now),
    env.DB.prepare(
      `INSERT INTO site_analytics_visitors(site_id, session_hash, metric_date, first_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(site_id, session_hash, metric_date) DO NOTHING`,
    ).bind(site.id, sessionHash, date, now),
  ]);
  return json({ ok: true });
}

async function issuePublicSiteSyncedBlockTicket(
  env: Env,
  site: SiteRow,
  containerPageId: string,
  blockId: string,
): Promise<Response> {
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) {
    return error('协作服务尚未配置', 503);
  }
  const pages = publiclyVisiblePages(site, await sitePages(env, site.id));
  const publicIds = new Set(pages.map((page) => page.page.id));
  if (!publicIds.has(containerPageId)) return error('站点页面不存在', 404);
  const block = await env.DB.prepare(
    `SELECT id, organization_id, source_page_id, current_generation, acl_version
       FROM synced_blocks
      WHERE id = ? AND deleted_at IS NULL AND lifecycle_state = 'active'
        AND deletion_operation_id IS NULL`,
  )
    .bind(blockId)
    .first<SyncedBlockRow>();
  if (
    !block ||
    block.organization_id !== site.organization_id ||
    !publicIds.has(block.source_page_id)
  ) {
    return error('同步块不存在或来源页面未发布', 404);
  }
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;
  const ticket = await signCollabTicket(
    {
      version: 1,
      pageId: block.id,
      generation: Number(block.current_generation),
      actorId: `site_${site.id}`,
      displayName: '站点访客',
      role: 'viewer',
      aclVersion: Number(block.acl_version),
      issuedAt: now,
      expiresAt,
      resourceKind: 'synced_block',
    },
    env.COLLAB_TICKET_SECRET,
  );
  return json({
    ticket,
    expiresAt,
    generation: Number(block.current_generation),
    role: 'viewer',
    sourcePageId: block.source_page_id,
  });
}

export async function handlePublicSitesApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const databaseViewMatch = url.pathname.match(
    /^\/api\/public\/sites\/([^/]+)\/database-views\/([^/]+)$/,
  );
  if (databaseViewMatch?.[1] && databaseViewMatch[2] && request.method === 'GET') {
    const site = await findLiveSiteBySlug(env, decodeURIComponent(databaseViewMatch[1]));
    return site
      ? publicDatabaseView(env, site, decodeURIComponent(databaseViewMatch[2]))
      : error('站点不存在', 404);
  }
  const searchMatch = url.pathname.match(/^\/api\/public\/sites\/([^/]+)\/search$/);
  if (searchMatch?.[1] && request.method === 'GET') {
    const site = await findLiveSiteBySlug(env, decodeURIComponent(searchMatch[1]));
    return site
      ? searchPublicSite(env, site, url.searchParams.get('q') ?? '')
      : error('站点不存在', 404);
  }
  const eventMatch = url.pathname.match(/^\/api\/public\/sites\/([^/]+)\/events$/);
  if (eventMatch?.[1] && request.method === 'POST') {
    const site = await findLiveSiteBySlug(env, decodeURIComponent(eventMatch[1]));
    return site ? recordPublicSiteEvent(request, env, site) : error('站点不存在', 404);
  }
  const syncedBlockMatch = url.pathname.match(
    /^\/api\/public\/sites\/([^/]+)\/pages\/([^/]+)\/synced-blocks\/([^/]+)\/ticket$/,
  );
  if (
    syncedBlockMatch?.[1] &&
    syncedBlockMatch[2] &&
    syncedBlockMatch[3] &&
    request.method === 'POST'
  ) {
    const site = await findLiveSiteBySlug(env, decodeURIComponent(syncedBlockMatch[1]));
    return site
      ? issuePublicSiteSyncedBlockTicket(
          env,
          site,
          decodeURIComponent(syncedBlockMatch[2]),
          decodeURIComponent(syncedBlockMatch[3]),
        )
      : error('站点不存在', 404);
  }
  const pageMatch = url.pathname.match(/^\/api\/public\/sites\/([^/]+)\/pages\/([^/]+)$/);
  if (pageMatch?.[1] && pageMatch[2] && request.method === 'GET') {
    const site = await findLiveSiteBySlug(env, decodeURIComponent(pageMatch[1]));
    return site
      ? publicSitePageResponse(request, env, site, decodeURIComponent(pageMatch[2]))
      : error('站点不存在', 404);
  }
  const rootMatch = url.pathname.match(/^\/api\/public\/sites\/([^/]+)$/);
  if (rootMatch?.[1] && request.method === 'GET') {
    const site = await findLiveSiteBySlug(env, decodeURIComponent(rootMatch[1]));
    return site ? publicSitePageResponse(request, env, site, null) : error('站点不存在', 404);
  }
  return null;
}

export async function canPubliclyDownloadSiteAttachment(
  request: Request,
  env: Env,
  pageId: string,
): Promise<boolean> {
  const requestedSlug = new URL(request.url).searchParams.get('site');
  const candidates: SiteRow[] = [];
  if (requestedSlug && SITE_SLUG_PATTERN.test(requestedSlug)) {
    const site = await findLiveSiteBySlug(env, requestedSlug);
    if (site) candidates.push(site);
  }
  const remembered = publicSiteIds(request);
  if (remembered.length) {
    const placeholders = remembered.map(() => '?').join(', ');
    candidates.push(
      ...(
        await env.DB.prepare(
          `SELECT id, organization_id, root_page_id, slug, name, theme,
                  favicon_attachment_id, share_image_attachment_id, seo_title,
                  seo_description, search_enabled, breadcrumbs_enabled,
                  watermark_enabled, search_engine_indexing, google_analytics_id,
                  published_at, unpublished_at, created_by, updated_by, created_at, updated_at
             FROM sites WHERE id IN (${placeholders}) AND unpublished_at IS NULL`,
        )
          .bind(...remembered)
          .all<SiteRow>()
      ).results,
    );
  }
  for (const site of candidates) {
    const pages = publiclyVisiblePages(site, await sitePages(env, site.id));
    if (pages.some((page) => page.page.id === pageId)) return true;
  }
  return false;
}

export interface SiteHtmlMetadata {
  site: SiteRow;
  page: SitePageSummary;
  excerpt: string;
}

export async function siteHtmlMetadata(
  env: Env,
  siteSlug: string,
  pageSlug: string | null,
): Promise<SiteHtmlMetadata | null> {
  const site = await findLiveSiteBySlug(env, siteSlug);
  if (!site) return null;
  const visible = publiclyVisiblePages(site, await sitePages(env, site.id));
  const page = pageSlug
    ? visible.find((candidate) => !candidate.isHome && candidate.slug === pageSlug)
    : visible.find((candidate) => candidate.isHome);
  if (!page) return null;
  const projection = await env.DB.prepare(
    'SELECT normalized_body FROM page_search_projection WHERE page_id = ?',
  )
    .bind(page.page.id)
    .first<{ normalized_body: string }>();
  const excerpt = (projection?.normalized_body ?? '').slice(0, 1200);
  await env.DB.prepare(
    `INSERT INTO site_prerender(site_id, page_id, excerpt, generated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(site_id, page_id) DO UPDATE SET excerpt = excluded.excerpt, generated_at = excluded.generated_at`,
  )
    .bind(site.id, page.page.id, excerpt, Date.now())
    .run()
    .catch(() => undefined);
  return { site, page, excerpt };
}

export async function findLiveSiteByHostname(env: Env, hostname: string): Promise<SiteRow | null> {
  const row = await env.DB.prepare(
    `SELECT s.id, s.organization_id, s.root_page_id, s.slug, s.name, s.theme,
            s.favicon_attachment_id, s.share_image_attachment_id, s.seo_title,
            s.seo_description, s.search_enabled, s.breadcrumbs_enabled,
            s.watermark_enabled, s.search_engine_indexing, s.google_analytics_id,
            s.published_at, s.unpublished_at, s.created_by, s.updated_by, s.created_at, s.updated_at
       FROM site_domains d
       JOIN sites s ON s.id = d.site_id
      WHERE d.hostname = ? COLLATE NOCASE AND d.status = 'verified' AND s.unpublished_at IS NULL`,
  )
    .bind(hostname)
    .first<SiteRow>();
  return row;
}

async function publicDatabaseView(env: Env, site: SiteRow, viewId: string): Promise<Response> {
  const published = await env.DB.prepare(
    `SELECT database_id, view_id FROM site_database_views
      WHERE site_id = ? AND view_id = ? AND published = 1`,
  )
    .bind(site.id, viewId)
    .first<{ database_id: string; view_id: string }>();
  if (!published) return error('数据库视图未发布', 404);
  const view = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json FROM database_views WHERE id = ? AND database_id = ?`,
  )
    .bind(published.view_id, published.database_id)
    .first<{ id: string; database_id: string; name: string; type: string; config_json: string }>();
  const properties = (
    await env.DB.prepare(
      `SELECT id, name, type, config_json, sort_order
         FROM database_properties WHERE database_id = ? ORDER BY sort_order`,
    )
      .bind(published.database_id)
      .all<{ id: string; name: string; type: string; config_json: string; sort_order: number }>()
  ).results;
  const rows = (
    await env.DB.prepare(
      `SELECT r.id, r.page_id, r.sort_key
         FROM database_rows r
         JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL
         JOIN page_access_state a ON a.page_id = p.id
        WHERE r.database_id = ? AND r.archived_at IS NULL
          AND COALESCE(a.access_mode, 'inherit') != 'restricted'
        ORDER BY r.sort_key LIMIT 200`,
    )
      .bind(published.database_id)
      .all<{ id: string; page_id: string; sort_key: string }>()
  ).results;
  const cells = (
    await env.DB.prepare(
      `SELECT row_id, property_id, value_json FROM database_cells WHERE database_id = ?`,
    )
      .bind(published.database_id)
      .all<{ row_id: string; property_id: string; value_json: string }>()
  ).results;
  const values = new Map<string, Record<string, unknown>>();
  for (const cell of cells) {
    const current = values.get(cell.row_id) ?? {};
    try {
      current[cell.property_id] = JSON.parse(cell.value_json) as unknown;
    } catch {
      current[cell.property_id] = null;
    }
    values.set(cell.row_id, current);
  }
  return json({
    view: view
      ? {
          id: view.id,
          databaseId: view.database_id,
          name: view.name,
          type: view.type,
          config: JSON.parse(view.config_json) as Record<string, unknown>,
        }
      : null,
    properties: properties.map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
      config: JSON.parse(property.config_json) as Record<string, unknown>,
    })),
    rows: rows.map((row) => ({
      id: row.id,
      pageId: row.page_id,
      values: values.get(row.id) ?? {},
    })),
  });
}

function escapedXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function publicSiteDiscoveryResponse(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.pathname === '/.well-known/rdocs-site-verify') {
    const domain = await env.DB.prepare(
      'SELECT verification_token FROM site_domains WHERE hostname = ? COLLATE NOCASE',
    )
      .bind(url.hostname)
      .first<{ verification_token: string }>();
    if (!domain) return null;
    return new Response(request.method === 'HEAD' ? null : domain.verification_token, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const match = url.pathname.match(/^\/site\/([^/]+)\/(sitemap\.xml|robots\.txt)$/);
  if (!match?.[1] || !match[2]) return null;
  const site = await findLiveSiteBySlug(env, decodeURIComponent(match[1]));
  if (!site) {
    return new Response(request.method === 'HEAD' ? null : 'Site not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const baseUrl = `${url.origin}/site/${encodeURIComponent(site.slug)}`;
  if (match[2] === 'robots.txt') {
    const body = site.search_engine_indexing
      ? `User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`
      : 'User-agent: *\nDisallow: /\n';
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  }
  const pages = site.search_engine_indexing
    ? publiclyVisiblePages(site, await sitePages(env, site.id))
    : [];
  const entries = pages
    .map((page) => {
      const location = page.isHome ? baseUrl : `${baseUrl}/${encodeURIComponent(page.slug)}`;
      return `<url><loc>${escapedXml(location)}</loc><lastmod>${new Date(page.page.updatedAt).toISOString()}</lastmod></url>`;
    })
    .join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
