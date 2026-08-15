import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { AuthUserSummary } from '@rdocs/shared';

import type { Env } from '../apps/worker/src/env';
import {
  requirePageAction,
  resolvePageAccess,
  resolveSpaceAccess,
} from '../apps/worker/src/access';
import { listPages } from '../apps/worker/src/page-tree';
import { pageAccessSnapshot } from '../apps/worker/src/page-access';
import { handleTenancyApi, provisionPersonalWorkspace } from '../apps/worker/src/tenancy';
import {
  deliverDueReminders,
  deliverPageUpdateNotifications,
  handleCommentsAndNotificationsApi,
} from '../apps/worker/src/comments';
import { handleDatabasesApi, handlePublicDatabaseFormsApi } from '../apps/worker/src/databases';
import { handlePlatformApi, handlePublicApi, pagesOnLegalHold } from '../apps/worker/src/platform';
import {
  handlePublicSitesApi,
  handleSitesApi,
  publicSiteDiscoveryResponse,
} from '../apps/worker/src/sites';

class TestStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.statement, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return {
      results: this.statement.all(...this.values) as T[],
      success: true,
      meta: {},
    };
  }

  async run(): Promise<{ success: true; meta: { changes: number }; results: never[] }> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

class TestD1 {
  prepareCalls = 0;

  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): TestStatement {
    this.prepareCalls += 1;
    return new TestStatement(this.sqlite.prepare(sql));
  }

  async batch(statements: TestStatement[]): Promise<unknown[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (reason) {
      this.sqlite.exec('ROLLBACK');
      throw reason;
    }
  }
}

const MIGRATIONS = [
  '0001_initial.sql',
  '0002_revision_restore_operations.sql',
  '0003_passkey_authentication.sql',
  '0004_invitation_passkey_registration.sql',
  '0005_page_permissions.sql',
  '0006_notifications.sql',
  '0007_editor_blocks.sql',
  '0008_page_acl_roles.sql',
  '0009_complete_permissions.sql',
  '0010_databases.sql',
  '0011_database_relations_and_sequences.sql',
  '0012_database_sequence_rollout_guards.sql',
  '0013_public_database_forms.sql',
  '0014_database_templates.sql',
  '0015_database_automations.sql',
  '0016_page_appearance_and_lock.sql',
  '0017_editor_core_blocks.sql',
  '0018_editor_block_controls_and_columns.sql',
  '0019_editor_attachment_and_media_blocks.sql',
  '0020_editor_page_button_and_breadcrumb.sql',
  '0021_cross_page_synced_blocks.sql',
  '0022_synced_block_lifecycle.sql',
  '0023_page_discovery_and_links.sql',
  '0024_page_notifications_and_inbox.sql',
  '0025_synced_block_delete_undo.sql',
  '0026_page_reminders_and_inbox_groups.sql',
  '0027_reminder_sources.sql',
  '0028_sites.sql',
  '0029_notion_parity_platform.sql',
  '0030_notion_completion.sql',
  '0031_rf_email_inbound.sql',
] as const;

function migratedDatabase(migrations: ReadonlyArray<string> = MIGRATIONS): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrations) {
    database.exec(readFileSync(join(process.cwd(), 'migrations', migration), 'utf8'));
  }
  return database;
}

function seedTenant(database: DatabaseSync, suffix: string): AuthUserSummary {
  const now = Date.now();
  const user: AuthUserSummary = {
    id: `usr_${suffix}`,
    email: `${suffix}@rdocs.test`,
    displayName: `User ${suffix}`,
    avatarUrl: null,
  };
  database
    .prepare(
      `INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
    )
    .run(user.id, user.email, user.displayName, now, now);
  database
    .prepare(
      `INSERT INTO organizations(id, name, slug, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`org_${suffix}`, `Org ${suffix}`, `org-${suffix}`, user.id, now, now);
  database
    .prepare(
      `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
       VALUES (?, ?, 'owner', 'active', ?, ?)`,
    )
    .run(`org_${suffix}`, user.id, now, now);
  database
    .prepare(
      `INSERT INTO spaces(
         id, organization_id, name, slug, visibility, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'private', 'restricted', ?, ?, ?)`,
    )
    .run(`spc_${suffix}`, `org_${suffix}`, `Space ${suffix}`, user.id, now, now);
  return user;
}

function testEnv(database: DatabaseSync, d1 = new TestD1(database)): Env {
  return {
    DB: d1,
    COLLAB_TICKET_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    DocumentRoom: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
  } as unknown as Env;
}

function testContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

describe('database migrations', () => {
  it('applies the full chain and binds passkey registration to invitations', () => {
    const database = migratedDatabase();
    const columns = database.prepare(`PRAGMA table_info('auth_challenges')`).all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain('invitation_id');
    const notificationColumns = database
      .prepare(`PRAGMA table_info('notifications')`)
      .all() as Array<{
      name: string;
    }>;
    expect(notificationColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['event_key', 'archived_at']),
    );
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'page_notification_subscriptions'",
        )
        .get(),
    ).toEqual({ total: 1 });
    expect(
      readFileSync(join(process.cwd(), 'migrations', '0007_editor_blocks.sql'), 'utf8'),
    ).toContain('editor_schema_version = 2');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS total FROM organization_members
            WHERE organization_id = 'org_phase0' AND user_id = 'usr_phase0_system'`,
        )
        .get(),
    ).toMatchObject({ total: 0 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name LIKE 'database_%'",
        )
        .get(),
    ).toMatchObject({ total: 13 });
    const rolloutOwner = seedTenant(database, 'rollout-guard');
    const seed = {
      id: 'page_rollout_parent',
      organization_id: 'org_rollout-guard',
      space_id: 'spc_rollout-guard',
      created_by: rolloutOwner.id,
    };
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 'Rollout database', 'rollout-parent', ?, ?, ?, ?)`,
      )
      .run(
        seed.id,
        seed.organization_id,
        seed.space_id,
        seed.created_by,
        seed.created_by,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO databases(
           id, organization_id, page_id, created_by, updated_by, created_at, updated_at
         ) VALUES ('db_rollout_guard', ?, ?, ?, ?, ?, ?)`,
      )
      .run(seed.organization_id, seed.id, seed.created_by, seed.created_by, now, now);
    expect(
      database
        .prepare(
          "SELECT next_row_sequence FROM database_counters WHERE database_id = 'db_rollout_guard'",
        )
        .get(),
    ).toMatchObject({ next_row_sequence: 1 });
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES ('page_rollout_guard', ?, ?, ?, 'Rollout row', 'rollout', ?, ?, ?, ?)`,
      )
      .run(
        seed.organization_id,
        seed.space_id,
        seed.id,
        seed.created_by,
        seed.created_by,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO database_rows(
           id, organization_id, database_id, page_id, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES ('row_rollout_guard', ?, 'db_rollout_guard', 'page_rollout_guard',
                   'rollout', ?, ?, ?, ?)`,
      )
      .run(seed.organization_id, seed.created_by, seed.created_by, now, now);
    expect(
      database
        .prepare("SELECT sequence_number FROM database_rows WHERE id = 'row_rollout_guard'")
        .get(),
    ).toMatchObject({ sequence_number: 1 });
    expect(
      database
        .prepare(
          "SELECT next_row_sequence FROM database_counters WHERE database_id = 'db_rollout_guard'",
        )
        .get(),
    ).toMatchObject({ next_row_sequence: 2 });
    database.close();
  });

  it('preserves existing notification rows while adding inbox state', () => {
    const database = migratedDatabase(
      MIGRATIONS.slice(0, MIGRATIONS.indexOf('0024_page_notifications_and_inbox.sql')),
    );
    const owner = seedTenant(database, 'notification-migration');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO notifications(
           id, organization_id, user_id, actor_id, type, page_id, thread_id,
           comment_id, metadata_json, created_at, read_at
         ) VALUES ('notification_before_0024', 'org_notification-migration', ?, NULL,
                   'page_shared', NULL, NULL, NULL, '{"source":"legacy"}', ?, ?)`,
      )
      .run(owner.id, now, now);
    database.exec(
      readFileSync(
        join(process.cwd(), 'migrations', '0024_page_notifications_and_inbox.sql'),
        'utf8',
      ),
    );
    expect(
      database
        .prepare(
          `SELECT type, metadata_json, created_at, read_at, archived_at, event_key
             FROM notifications WHERE id = 'notification_before_0024'`,
        )
        .get(),
    ).toEqual({
      type: 'page_shared',
      metadata_json: '{"source":"legacy"}',
      created_at: now,
      read_at: now,
      archived_at: null,
      event_key: null,
    });
    database.close();
  });

  it('stores page appearance and makes locked pages read-only at the shared ACL boundary', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'appearance');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           icon, font_style, is_full_width, is_small_text,
           created_by, updated_by, created_at, updated_at
         ) VALUES ('page_appearance', 'org_appearance', 'spc_appearance', NULL,
                   'Appearance', '1', '📘', 'serif', 1, 1, ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(
           page_id, collaboration_enabled, acl_version, access_mode, updated_at
         ) VALUES ('page_appearance', 1, 1, 'inherit', ?)`,
      )
      .run(now);
    const env = testEnv(database);
    await expect(
      requirePageAction(env, 'page_appearance', owner.id, 'edit_content'),
    ).resolves.not.toBeNull();
    database
      .prepare(
        "UPDATE pages SET font_style = 'mono', is_full_width = 0, is_locked = 1 WHERE id = 'page_appearance'",
      )
      .run();
    database
      .prepare("UPDATE page_access_state SET acl_version = 2 WHERE page_id = 'page_appearance'")
      .run();
    expect(
      database
        .prepare("SELECT acl_version FROM page_access_state WHERE page_id = 'page_appearance'")
        .get(),
    ).toMatchObject({ acl_version: 2 });
    await expect(
      requirePageAction(env, 'page_appearance', owner.id, 'view'),
    ).resolves.not.toBeNull();
    await expect(
      requirePageAction(env, 'page_appearance', owner.id, 'manage_access'),
    ).resolves.not.toBeNull();
    await expect(
      requirePageAction(env, 'page_appearance', owner.id, 'edit_content'),
    ).resolves.toBeNull();
    const treeResponse = await listPages(env, 'spc_appearance', owner.id);
    await expect(treeResponse.json()).resolves.toMatchObject({
      pages: [
        expect.objectContaining({
          id: 'page_appearance',
          icon: '📘',
          fontStyle: 'mono',
          isFullWidth: false,
          isSmallText: true,
          isLocked: true,
        }),
      ],
    });
    database.prepare("UPDATE pages SET is_locked = 0 WHERE id = 'page_appearance'").run();
    await expect(
      requirePageAction(env, 'page_appearance', owner.id, 'edit_content'),
    ).resolves.not.toBeNull();
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
  });
});

describe('public Sites integration', () => {
  it('publishes only safe descendants and supports navigation, search, analytics, and unpublish', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'sites');
    const outsider = seedTenant(database, 'sites-outsider');
    const now = Date.now();
    const pages = [
      { id: 'site_root', parentId: null, title: 'Rdocs Handbook', sort: '1', mode: 'inherit' },
      {
        id: 'site_public',
        parentId: 'site_root',
        title: 'Getting Started',
        sort: '2',
        mode: 'inherit',
      },
      {
        id: 'site_private',
        parentId: 'site_root',
        title: 'Private Notes',
        sort: '3',
        mode: 'restricted',
      },
      {
        id: 'site_private_child',
        parentId: 'site_private',
        title: 'Private Child',
        sort: '4',
        mode: 'inherit',
      },
      {
        id: 'site_database',
        parentId: 'site_root',
        title: 'Structured Data',
        sort: '5',
        mode: 'inherit',
      },
    ];
    for (const page of pages) {
      database
        .prepare(
          `INSERT INTO pages(
             id, organization_id, space_id, parent_id, title, sort_key,
             created_by, updated_by, created_at, updated_at
           ) VALUES (?, 'org_sites', 'spc_sites', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(page.id, page.parentId, page.title, page.sort, owner.id, owner.id, now, now);
      database
        .prepare(
          `INSERT INTO page_access_state(
             page_id, collaboration_enabled, acl_version, access_mode, updated_at
           ) VALUES (?, 1, 1, ?, ?)`,
        )
        .run(page.id, page.mode, now);
      database
        .prepare(
          `INSERT INTO page_search_projection(
             page_id, organization_id, space_id, generation, collab_seq,
             title, normalized_body, updated_at
           ) VALUES (?, 'org_sites', 'spc_sites', 1, 0, ?, ?, ?)`,
        )
        .run(page.id, page.title, `${page.title.toLowerCase()} documentation`, now);
    }
    database
      .prepare(
        `INSERT INTO databases(
           id, organization_id, page_id, is_locked, created_by, updated_by, created_at, updated_at
         ) VALUES ('database_site', 'org_sites', 'site_database', 0, ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    const env = testEnv(database);
    const databaseSiteResponse = await handleSitesApi(
      new Request('https://docs.test/api/pages/site_database/site', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Structured Data', slug: 'structured-data' }),
      }),
      env,
      owner,
    );
    expect(databaseSiteResponse?.status).toBe(400);
    const publishedResponse = await handleSitesApi(
      new Request('https://docs.test/api/pages/site_root/site', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rdocs Handbook', slug: 'rdocs-handbook' }),
      }),
      env,
      owner,
    );
    expect(publishedResponse?.status).toBe(201);
    const published = (await publishedResponse?.json()) as {
      site: { id: string; pages: Array<{ page: { id: string }; slug: string }> };
    };
    expect(published.site.pages.map((page) => page.page.id)).toEqual(['site_root', 'site_public']);
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM site_pages WHERE site_id = ?')
        .get(published.site.id),
    ).toEqual({ count: 2 });

    const forbidden = await handleSitesApi(
      new Request('https://docs.test/api/pages/site_root/site'),
      env,
      outsider,
    );
    expect(forbidden?.status).toBe(404);

    const rootResponse = await handlePublicSitesApi(
      new Request('https://docs.test/api/public/sites/rdocs-handbook'),
      env,
    );
    expect(rootResponse?.status).toBe(200);
    await expect(rootResponse?.json()).resolves.toMatchObject({
      currentPage: { page: { id: 'site_root' }, isHome: true },
      site: {
        searchEnabled: true,
        pages: [{ page: { id: 'site_root' } }, { page: { id: 'site_public' } }],
      },
    });

    const publicPage = published.site.pages.find((page) => page.page.id === 'site_public')!;
    const pageUpdate = await handleSitesApi(
      new Request(`https://docs.test/api/sites/${published.site.id}/pages/site_public`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'start-here', inNavigation: true, navigationLabel: 'Start' }),
      }),
      env,
      owner,
    );
    expect(pageUpdate?.status).toBe(200);
    const childResponse = await handlePublicSitesApi(
      new Request('https://docs.test/api/public/sites/rdocs-handbook/pages/start-here'),
      env,
    );
    expect(childResponse?.status).toBe(200);
    await expect(childResponse?.json()).resolves.toMatchObject({
      currentPage: { page: { id: 'site_public' }, slug: 'start-here' },
    });
    expect(publicPage.slug).not.toBe('start-here');

    const privateRobotsResponse = await publicSiteDiscoveryResponse(
      new Request('https://docs.test/site/rdocs-handbook/robots.txt'),
      env,
    );
    await expect(privateRobotsResponse?.text()).resolves.toContain('Disallow: /');
    const indexingResponse = await handleSitesApi(
      new Request(`https://docs.test/api/sites/${published.site.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchEngineIndexing: true }),
      }),
      env,
      owner,
    );
    expect(indexingResponse?.status).toBe(200);
    const sitemapResponse = await publicSiteDiscoveryResponse(
      new Request('https://docs.test/site/rdocs-handbook/sitemap.xml'),
      env,
    );
    expect(sitemapResponse?.headers.get('content-type')).toContain('application/xml');
    const sitemap = await sitemapResponse?.text();
    expect(sitemap).toContain('<loc>https://docs.test/site/rdocs-handbook</loc>');
    expect(sitemap).toContain('<loc>https://docs.test/site/rdocs-handbook/start-here</loc>');
    expect(sitemap).not.toContain('site_private');
    const robotsResponse = await publicSiteDiscoveryResponse(
      new Request('https://docs.test/site/rdocs-handbook/robots.txt'),
      env,
    );
    await expect(robotsResponse?.text()).resolves.toContain(
      'Sitemap: https://docs.test/site/rdocs-handbook/sitemap.xml',
    );

    const hideParentResponse = await handleSitesApi(
      new Request(`https://docs.test/api/sites/${published.site.id}/pages/site_public`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isVisible: false }),
      }),
      env,
      owner,
    );
    expect(hideParentResponse?.status).toBe(200);
    const hiddenChildResponse = await handlePublicSitesApi(
      new Request('https://docs.test/api/public/sites/rdocs-handbook/pages/start-here'),
      env,
    );
    expect(hiddenChildResponse?.status).toBe(404);
    await handleSitesApi(
      new Request(`https://docs.test/api/sites/${published.site.id}/pages/site_public`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isVisible: true }),
      }),
      env,
      owner,
    );

    const searchResponse = await handlePublicSitesApi(
      new Request('https://docs.test/api/public/sites/rdocs-handbook/search?q=getting'),
      env,
    );
    await expect(searchResponse?.json()).resolves.toMatchObject({
      results: [expect.objectContaining({ pageId: 'site_public', slug: 'start-here' })],
    });

    const eventResponse = await handlePublicSitesApi(
      new Request('https://docs.test/api/public/sites/rdocs-handbook/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://docs.test' },
        body: JSON.stringify({
          type: 'page_view',
          pageId: 'site_public',
          sessionId: 'siteintegrationvisitor123',
        }),
      }),
      env,
    );
    expect(eventResponse?.status).toBe(200);
    const analyticsResponse = await handleSitesApi(
      new Request(`https://docs.test/api/sites/${published.site.id}/analytics`),
      env,
      owner,
    );
    await expect(analyticsResponse?.json()).resolves.toMatchObject({
      days: [expect.objectContaining({ pageViews: 1, uniqueVisitors: 1 })],
    });

    const unpublishedResponse = await handleSitesApi(
      new Request(`https://docs.test/api/sites/${published.site.id}`, { method: 'DELETE' }),
      env,
      owner,
    );
    expect(unpublishedResponse?.status).toBe(200);
    const unavailable = await handlePublicSitesApi(
      new Request('https://docs.test/api/public/sites/rdocs-handbook'),
      env,
    );
    expect(unavailable?.status).toBe(404);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
  });
});

describe('structured database integration', () => {
  it('creates a database, properties and page-backed rows without crossing tenants', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'database-owner');
    const outsider = seedTenant(database, 'database-outsider');
    const pageId = '11111111-1111-4111-8111-111111111111';
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'org_database-owner', 'spc_database-owner', NULL, 'Tasks', '1', ?, ?, ?, ?)`,
      )
      .run(pageId, owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, access_mode, updated_at)
         VALUES (?, 1, 1, 'inherit', ?)`,
      )
      .run(pageId, now);
    database
      .prepare(
        `INSERT INTO page_search_projection(
           page_id, organization_id, space_id, generation, collab_seq,
           title, normalized_body, updated_at
         ) VALUES (?, 'org_database-owner', 'spc_database-owner', 1, 0, 'Tasks', '', ?)`,
      )
      .run(pageId, now);
    const env = testEnv(database);

    const createdResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/pages/${pageId}/database`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titlePropertyName: '任务' }),
      }),
      env,
      owner,
    );
    expect(createdResponse?.status).toBe(201);
    const created = (await createdResponse?.json()) as {
      database: { id: string };
      properties: Array<{ id: string; type: string }>;
    };
    const databaseId = created.database.id;
    const titlePropertyId = created.properties.find((property) => property.type === 'title')?.id;
    expect(titlePropertyId).toBeTruthy();

    const listed = await handleDatabasesApi(
      new Request('https://docs.test/api/organizations/org_database-owner/databases'),
      env,
      owner,
    );
    expect(listed?.status).toBe(200);
    await expect(listed?.json()).resolves.toMatchObject({
      databases: [expect.objectContaining({ id: databaseId, title: 'Tasks' })],
    });

    const numberResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '工时', type: 'number' }),
      }),
      env,
      owner,
    );
    const numberProperty = (await numberResponse?.json()) as { property: { id: string } };
    expect(numberResponse?.status).toBe(201);

    const dateResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '截止日期', type: 'date' }),
      }),
      env,
      owner,
    );
    const dateProperty = (await dateResponse?.json()) as { property: { id: string } };
    expect(dateResponse?.status).toBe(201);

    const formulaResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '计费工时',
          type: 'formula',
          config: { expression: 'prop("工时") * 2' },
        }),
      }),
      env,
      owner,
    );
    const formulaProperty = (await formulaResponse?.json()) as { property: { id: string } };
    expect(formulaResponse?.status).toBe(201);

    const uniqueIdResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '任务 ID', type: 'unique_id', config: { prefix: 'TASK-' } }),
      }),
      env,
      owner,
    );
    const uniqueIdProperty = (await uniqueIdResponse?.json()) as { property: { id: string } };
    expect(uniqueIdResponse?.status).toBe(201);

    const rowResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: {
            [titlePropertyId!]: '发布 Rdocs',
            [numberProperty.property.id]: 3,
            [dateProperty.property.id]: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
          },
        }),
      }),
      env,
      owner,
    );
    expect(rowResponse?.status).toBe(201);
    const rowResult = (await rowResponse?.json()) as {
      row: { id: string; pageId: string; values: Record<string, unknown> };
    };
    expect(rowResult.row.values[formulaProperty.property.id]).toBe(6);
    expect(rowResult.row.values[uniqueIdProperty.property.id]).toBe('TASK-1');
    expect(
      database.prepare('SELECT title, parent_id FROM pages WHERE id = ?').get(rowResult.row.pageId),
    ).toMatchObject({ title: '发布 Rdocs', parent_id: pageId });

    const databaseReminderSource = `${databaseId}:${rowResult.row.id}:${dateProperty.property.id}`;
    const databaseReminderResponse = await handleCommentsAndNotificationsApi(
      new Request(`https://docs.test/api/pages/${rowResult.row.pageId}/reminders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipientId: owner.id,
          message: '截止日期提醒',
          dueAt: now + 7 * 24 * 60 * 60_000,
          remindAt: now + 6 * 24 * 60 * 60_000,
          timezone: 'UTC',
          sourceType: 'database_date',
          sourceId: databaseReminderSource,
        }),
      }),
      env,
      owner,
    );
    expect(databaseReminderResponse?.status).toBe(200);
    const clearDateResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [dateProperty.property.id]: null } }),
      }),
      env,
      owner,
    );
    expect(clearDateResponse?.status).toBe(200);
    expect(
      database
        .prepare('SELECT status FROM page_reminders WHERE source_id = ?')
        .get(databaseReminderSource),
    ).toEqual({ status: 'cancelled' });

    const automationResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/automations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '工时变更后再加一小时',
          triggerType: 'property_changed',
          triggerConfig: { propertyId: numberProperty.property.id },
          actionType: 'increment_number',
          actionConfig: { targetPropertyId: numberProperty.property.id, increment: 1 },
        }),
      }),
      env,
      owner,
    );
    expect(automationResponse?.status).toBe(201);

    const buttonPropertyResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '增加工时',
          type: 'button',
          config: {
            label: '+2',
            action: 'increment_number',
            targetPropertyId: numberProperty.property.id,
            increment: 2,
          },
        }),
      }),
      env,
      owner,
    );
    const buttonProperty = (await buttonPropertyResponse?.json()) as {
      property: { id: string };
    };
    const buttonResponse = await handleDatabasesApi(
      new Request(
        `https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}/buttons/${buttonProperty.property.id}`,
        { method: 'POST' },
      ),
      env,
      owner,
    );
    const buttonResult = (await buttonResponse?.json()) as {
      row: { values: Record<string, unknown> };
    };
    expect(buttonResponse?.status).toBe(200);
    expect(buttonResult.row.values[numberProperty.property.id]).toBe(6);
    expect(buttonResult.row.values[formulaProperty.property.id]).toBe(12);
    const automationListResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/automations`),
      env,
      owner,
    );
    const automationList = (await automationListResponse?.json()) as {
      automations: Array<{ name: string }>;
      runs: Array<{ status: string; rowId: string }>;
    };
    expect(automationList.automations).toEqual([
      expect.objectContaining({ name: '工时变更后再加一小时' }),
    ]);
    expect(automationList.runs).toEqual([
      expect.objectContaining({ status: 'succeeded', rowId: rowResult.row.id }),
    ]);

    for (const expectedSequence of [2, 3]) {
      const temporaryResponse = await handleDatabasesApi(
        new Request(`https://docs.test/api/databases/${databaseId}/rows`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: { [titlePropertyId!]: `临时任务 ${expectedSequence}` } }),
        }),
        env,
        owner,
      );
      const temporary = (await temporaryResponse?.json()) as {
        row: { id: string; sequenceNumber: number; values: Record<string, unknown> };
      };
      expect(temporary.row.sequenceNumber).toBe(expectedSequence);
      expect(temporary.row.values[uniqueIdProperty.property.id]).toBe(`TASK-${expectedSequence}`);
      await handleDatabasesApi(
        new Request(`https://docs.test/api/databases/${databaseId}/rows/${temporary.row.id}`, {
          method: 'DELETE',
        }),
        env,
        owner,
      );
    }

    const duplicateResponse = await handleDatabasesApi(
      new Request(
        `https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}/duplicate`,
        {
          method: 'POST',
        },
      ),
      env,
      owner,
    );
    const duplicate = (await duplicateResponse?.json()) as {
      row: { id: string; sequenceNumber: number; values: Record<string, unknown> };
    };
    expect(duplicateResponse?.status).toBe(201);
    expect(duplicate.row.sequenceNumber).toBe(4);
    expect(duplicate.row.values[titlePropertyId!]).toBe('发布 Rdocs 副本');
    const templateResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '标准任务',
          description: '默认任务结构',
          sourceRowId: rowResult.row.id,
        }),
      }),
      env,
      owner,
    );
    const templateResult = (await templateResponse?.json()) as {
      template: { id: string; pageId: string; isDefault: boolean; values: Record<string, unknown> };
    };
    expect(templateResponse?.status).toBe(201);
    expect(templateResult.template.isDefault).toBe(true);
    expect(templateResult.template.values[titlePropertyId!]).toBe('发布 Rdocs');
    const templateSnapshotResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      env,
      owner,
    );
    const templateSnapshot = (await templateSnapshotResponse?.json()) as {
      templates: Array<{ id: string; values: Record<string, unknown> }>;
    };
    expect(templateSnapshot.templates).toEqual([
      expect.objectContaining({ id: templateResult.template.id, values: {} }),
    ]);
    const treeWithTemplate = (await (
      await listPages(env, 'spc_database-owner', owner.id)
    ).json()) as { pages: Array<{ id: string }> };
    expect(treeWithTemplate.pages.map((page) => page.id)).not.toContain(
      templateResult.template.pageId,
    );
    const templatedRowResponse = await handleDatabasesApi(
      new Request(
        `https://docs.test/api/databases/${databaseId}/templates/${templateResult.template.id}/rows`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      ),
      env,
      owner,
    );
    const templatedRow = (await templatedRowResponse?.json()) as {
      row: { id: string; sequenceNumber: number; values: Record<string, unknown> };
    };
    expect(templatedRowResponse?.status).toBe(201);
    expect(templatedRow.row.sequenceNumber).toBe(5);
    expect(templatedRow.row.values[titlePropertyId!]).toBe('发布 Rdocs');
    await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${templatedRow.row.id}`, {
        method: 'DELETE',
      }),
      env,
      owner,
    );
    await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${duplicate.row.id}`, {
        method: 'DELETE',
      }),
      env,
      owner,
    );
    const deleteTemplateResponse = await handleDatabasesApi(
      new Request(
        `https://docs.test/api/databases/${databaseId}/templates/${templateResult.template.id}`,
        { method: 'DELETE' },
      ),
      env,
      owner,
    );
    expect(deleteTemplateResponse?.status).toBe(200);
    const archivedResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}?archived=true`),
      env,
      owner,
    );
    const archived = (await archivedResponse?.json()) as { rows: Array<{ id: string }> };
    expect(archived.rows.map((row) => row.id)).toContain(duplicate.row.id);
    const restoredResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${duplicate.row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: {}, archived: false }),
      }),
      env,
      owner,
    );
    expect(restoredResponse?.status).toBe(200);
    await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${duplicate.row.id}`, {
        method: 'DELETE',
      }),
      env,
      owner,
    );

    const triagedPropertyResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '已分流', type: 'checkbox' }),
      }),
      env,
      owner,
    );
    const triagedProperty = (await triagedPropertyResponse?.json()) as {
      property: { id: string };
    };
    const formAutomationResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/automations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '表单提交后自动分流',
          triggerType: 'form_submitted',
          actionType: 'set_property',
          actionConfig: { targetPropertyId: triagedProperty.property.id, value: true },
        }),
      }),
      env,
      owner,
    );
    expect(formAutomationResponse?.status).toBe(201);

    const formViewResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/views`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '需求收集',
          type: 'form',
          config: {
            formTitle: '提交需求',
            formDescription: '无需登录，只能提交公开字段。',
            requiredPropertyIds: [titlePropertyId],
            successMessage: '已经收到。',
          },
        }),
      }),
      env,
      owner,
    );
    const formView = (await formViewResponse?.json()) as { view: { id: string } };
    const formLinkResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/forms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewId: formView.view.id, expiresInDays: 30 }),
      }),
      env,
      owner,
    );
    const formLink = (await formLinkResponse?.json()) as { token: string };
    expect(formLinkResponse?.status).toBe(201);
    const publicDefinition = await handlePublicDatabaseFormsApi(
      new Request(`https://docs.test/api/public/forms/${formLink.token}`),
      env,
    );
    await expect(publicDefinition?.json()).resolves.toMatchObject({
      form: {
        title: '提交需求',
        successMessage: '已经收到。',
        fields: expect.arrayContaining([
          expect.objectContaining({ id: titlePropertyId, required: true }),
        ]),
      },
    });
    const missingRequired = await handlePublicDatabaseFormsApi(
      new Request(`https://docs.test/api/public/forms/${formLink.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: {} }),
      }),
      env,
    );
    expect(missingRequired?.status).toBe(400);
    const publicSubmission = await handlePublicDatabaseFormsApi(
      new Request(`https://docs.test/api/public/forms/${formLink.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [titlePropertyId!]: '匿名提交的需求' } }),
      }),
      env,
    );
    const submission = (await publicSubmission?.json()) as {
      submissionId: string;
      message: string;
    };
    expect(publicSubmission?.status).toBe(201);
    expect(submission.message).toBe('已经收到。');
    expect(
      database
        .prepare('SELECT created_by FROM database_rows WHERE id = ?')
        .get(submission.submissionId),
    ).toMatchObject({ created_by: 'usr_rdocs_forms' });
    expect(
      database
        .prepare(
          'SELECT value_json, updated_by FROM database_cells WHERE row_id = ? AND property_id = ?',
        )
        .get(submission.submissionId, triagedProperty.property.id),
    ).toMatchObject({ value_json: 'true', updated_by: owner.id });
    expect(
      database
        .prepare(
          `SELECT status, trigger_type FROM database_automation_runs
            WHERE database_id = ? AND row_id = ?`,
        )
        .get(databaseId, submission.submissionId),
    ).toMatchObject({ status: 'succeeded', trigger_type: 'form_submitted' });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM organization_members
            WHERE user_id = 'usr_rdocs_forms'`,
        )
        .get(),
    ).toMatchObject({ count: 0 });
    await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${submission.submissionId}`, {
        method: 'DELETE',
      }),
      env,
      owner,
    );

    const hidden = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      env,
      outsider,
    );
    expect(hidden?.status).toBe(404);
    const hiddenList = await handleDatabasesApi(
      new Request('https://docs.test/api/organizations/org_database-owner/databases'),
      env,
      outsider,
    );
    expect(hiddenList?.status).toBe(404);
    const hiddenAutomations = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/automations`),
      env,
      outsider,
    );
    expect(hiddenAutomations?.status).toBe(404);

    database
      .prepare(
        `INSERT INTO organization_members(
           organization_id, user_id, role, status, joined_at, updated_at
         ) VALUES ('org_database-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(outsider.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id,
           role, created_by, created_at
         ) VALUES ('grant_database_editor', 'org_database-owner', 'spc_database-owner',
                   'user', ?, 'editor', ?, ?)`,
      )
      .run(outsider.id, owner.id, now);
    const visibleRowsResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      env,
      outsider,
    );
    await expect(visibleRowsResponse?.json()).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: rowResult.row.id })],
    });

    database
      .prepare("UPDATE page_access_state SET access_mode = 'restricted' WHERE page_id = ?")
      .run(rowResult.row.pageId);
    const restrictedRowsResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      env,
      outsider,
    );
    await expect(restrictedRowsResponse?.json()).resolves.toMatchObject({ rows: [] });
    const forbiddenRowUpdate = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [titlePropertyId!]: '越权修改' } }),
      }),
      env,
      outsider,
    );
    expect(forbiddenRowUpdate?.status).toBe(404);

    database
      .prepare("UPDATE page_access_state SET access_mode = 'inherit' WHERE page_id = ?")
      .run(rowResult.row.pageId);
    const targetPageId = '22222222-2222-4222-8222-222222222222';
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'org_database-owner', 'spc_database-owner', NULL,
                   'Private targets', '2', ?, ?, ?, ?)`,
      )
      .run(targetPageId, owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, access_mode, updated_at)
         VALUES (?, 1, 1, 'inherit', ?)`,
      )
      .run(targetPageId, now);
    database
      .prepare(
        `INSERT INTO page_search_projection(
           page_id, organization_id, space_id, generation, collab_seq,
           title, normalized_body, updated_at
         ) VALUES (?, 'org_database-owner', 'spc_database-owner', 1, 0,
                   'Private targets', '', ?)`,
      )
      .run(targetPageId, now);
    const targetDatabaseResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/pages/${targetPageId}/database`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titlePropertyName: '名称' }),
      }),
      env,
      owner,
    );
    const targetDatabase = (await targetDatabaseResponse?.json()) as {
      database: { id: string };
      properties: Array<{ id: string; type: string }>;
    };
    const targetTitleId = targetDatabase.properties.find(
      (property) => property.type === 'title',
    )!.id;
    const targetRowResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${targetDatabase.database.id}/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [targetTitleId]: '机密目标' } }),
      }),
      env,
      owner,
    );
    const targetRow = (await targetRowResponse?.json()) as {
      row: { id: string; pageId: string };
    };
    const relationResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '关联目标',
          type: 'relation',
          config: {
            targetDatabaseId: targetDatabase.database.id,
            reciprocalName: '来源任务',
          },
        }),
      }),
      env,
      owner,
    );
    const relation = (await relationResponse?.json()) as {
      property: { id: string };
      reciprocalProperty: { id: string };
    };
    expect(relationResponse?.status).toBe(201);
    const rollupResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '目标名称',
          type: 'rollup',
          config: {
            relationPropertyId: relation.property.id,
            targetDatabaseId: targetDatabase.database.id,
            targetPropertyId: targetTitleId,
            calculation: 'show_original',
          },
        }),
      }),
      env,
      owner,
    );
    const rollupProperty = (await rollupResponse?.json()) as { property: { id: string } };
    await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [relation.property.id]: [targetRow.row.id] } }),
      }),
      env,
      owner,
    );
    const mirroredResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${targetDatabase.database.id}`),
      env,
      owner,
    );
    const mirrored = (await mirroredResponse?.json()) as {
      rows: Array<{ values: Record<string, unknown> }>;
    };
    expect(mirrored.rows[0]?.values[relation.reciprocalProperty.id]).toEqual([rowResult.row.id]);

    await handleDatabasesApi(
      new Request(
        `https://docs.test/api/databases/${targetDatabase.database.id}/rows/${targetRow.row.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: { [relation.reciprocalProperty.id]: [] } }),
        },
      ),
      env,
      owner,
    );
    const clearedResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      env,
      owner,
    );
    const cleared = (await clearedResponse?.json()) as {
      rows: Array<{ values: Record<string, unknown> }>;
    };
    expect(cleared.rows[0]?.values[relation.property.id]).toEqual([]);
    await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [relation.property.id]: [targetRow.row.id] } }),
      }),
      env,
      owner,
    );
    database
      .prepare("UPDATE page_access_state SET access_mode = 'restricted' WHERE page_id = ?")
      .run(targetRow.row.pageId);
    const hiddenRelationWrite = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}/rows/${rowResult.row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [relation.property.id]: [targetRow.row.id] } }),
      }),
      env,
      outsider,
    );
    expect(hiddenRelationWrite?.status).toBe(400);
    const censoredRelationResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      env,
      outsider,
    );
    const censoredRelation = (await censoredRelationResponse?.json()) as {
      rows: Array<{ values: Record<string, unknown> }>;
    };
    expect(censoredRelation.rows[0]?.values[relation.property.id]).toEqual([]);
    expect(censoredRelation.rows[0]?.values[rollupProperty.property.id]).toEqual([]);

    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
  });

  it('creates an atomic project, task and Sprint workspace with live progress rollups', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'projects');
    const outsider = seedTenant(database, 'projects-outsider');
    const env = testEnv(database);
    const denied = await handleDatabasesApi(
      new Request('https://docs.test/api/spaces/spc_projects/project-workspaces', {
        method: 'POST',
      }),
      env,
      outsider,
    );
    expect(denied?.status).toBe(404);
    const response = await handleDatabasesApi(
      new Request('https://docs.test/api/spaces/spc_projects/project-workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '研发项目中心' }),
      }),
      env,
      owner,
    );
    expect(response?.status).toBe(201);
    const result = (await response?.json()) as {
      workspace: {
        hubPageId: string;
        projectsPageId: string;
        tasksPageId: string;
        sprintsPageId: string;
        projectsDatabaseId: string;
        tasksDatabaseId: string;
        sprintsDatabaseId: string;
      };
    };
    expect(
      database
        .prepare('SELECT title, parent_id FROM pages WHERE id IN (?, ?, ?, ?) ORDER BY title')
        .all(
          result.workspace.hubPageId,
          result.workspace.projectsPageId,
          result.workspace.tasksPageId,
          result.workspace.sprintsPageId,
        ),
    ).toEqual([
      expect.objectContaining({ title: 'Sprint', parent_id: result.workspace.hubPageId }),
      expect.objectContaining({ title: '任务', parent_id: result.workspace.hubPageId }),
      expect.objectContaining({ title: '研发项目中心', parent_id: null }),
      expect.objectContaining({ title: '项目', parent_id: result.workspace.hubPageId }),
    ]);
    expect(
      database
        .prepare(
          `SELECT database_id, COUNT(*) AS total FROM database_views
            WHERE database_id IN (?, ?, ?) GROUP BY database_id ORDER BY total`,
        )
        .all(
          result.workspace.projectsDatabaseId,
          result.workspace.tasksDatabaseId,
          result.workspace.sprintsDatabaseId,
        ),
    ).toEqual([
      expect.objectContaining({ total: 3 }),
      expect.objectContaining({ total: 3 }),
      expect.objectContaining({ total: 4 }),
    ]);
    const projectProperties = database
      .prepare('SELECT id, name FROM database_properties WHERE database_id = ?')
      .all(result.workspace.projectsDatabaseId) as Array<{ id: string; name: string }>;
    const taskProperties = database
      .prepare('SELECT id, name FROM database_properties WHERE database_id = ?')
      .all(result.workspace.tasksDatabaseId) as Array<{ id: string; name: string }>;
    const propertyId = (properties: Array<{ id: string; name: string }>, name: string) =>
      properties.find((property) => property.name === name)?.id ?? '';
    const projectRowResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${result.workspace.projectsDatabaseId}/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: { [propertyId(projectProperties, '项目名称')]: 'Rdocs 2.0' },
        }),
      }),
      env,
      owner,
    );
    const projectRow = (await projectRowResponse?.json()) as { row: { id: string } };
    const taskRowResponse = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${result.workspace.tasksDatabaseId}/rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: {
            [propertyId(taskProperties, '任务名称')]: '项目模板',
            [propertyId(taskProperties, '完成')]: true,
            [propertyId(taskProperties, '所属项目')]: [projectRow.row.id],
          },
        }),
      }),
      env,
      owner,
    );
    expect(taskRowResponse?.status).toBe(201);
    const taskRow = (await taskRowResponse?.json()) as { row: { id: string } };
    expect(
      database
        .prepare('SELECT value_json FROM database_cells WHERE row_id = ? AND property_id = ?')
        .get(projectRow.row.id, propertyId(projectProperties, '任务')),
    ).toMatchObject({ value_json: JSON.stringify([taskRow.row.id]) });
    expect(propertyId(projectProperties, '完成度')).not.toBe('');
    const projectsSnapshot = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${result.workspace.projectsDatabaseId}`),
      env,
      owner,
    );
    const projects = (await projectsSnapshot?.json()) as {
      rows: Array<{ values: Record<string, unknown> }>;
    };
    expect(projects.rows[0]?.values[propertyId(projectProperties, '完成度')]).toBe(100);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
  });
});

describe('tenant boundary integration', () => {
  it('caps historical external members at read-only on spaces and restricted pages', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'guest-owner');
    const guest = seedTenant(database, 'legacy-guest');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_guest-owner', ?, 'guest', 'active', ?, ?)`,
      )
      .run(guest.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_legacy_guest', 'org_guest-owner', 'spc_guest-owner',
                   'user', ?, 'space_admin', ?, ?)`,
      )
      .run(guest.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_legacy_guest', 'org_guest-owner', 'spc_guest-owner',
                   'External read only', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, access_mode, updated_at)
         VALUES ('page_legacy_guest', 1, 1, 'restricted', ?)`,
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO page_grants(
           id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('page_grant_legacy_guest', 'org_guest-owner', 'page_legacy_guest',
                   'user', ?, 'space_admin', ?, ?)`,
      )
      .run(guest.id, owner.id, now);
    const env = testEnv(database);

    await expect(resolveSpaceAccess(env, 'spc_guest-owner', guest.id)).resolves.toMatchObject({
      spaceRole: 'viewer',
    });
    await expect(resolvePageAccess(env, 'page_legacy_guest', guest.id)).resolves.toMatchObject({
      spaceRole: 'viewer',
    });
    await expect(
      requirePageAction(env, 'page_legacy_guest', guest.id, 'view'),
    ).resolves.not.toBeNull();
    await expect(
      requirePageAction(env, 'page_legacy_guest', guest.id, 'comment'),
    ).resolves.toBeNull();
    await expect(
      requirePageAction(env, 'page_legacy_guest', guest.id, 'edit_content'),
    ).resolves.toBeNull();
    await expect(
      requirePageAction(env, 'page_legacy_guest', guest.id, 'manage_access'),
    ).resolves.toBeNull();
    database.close();
  });

  it('rejects new guest identities, guest elevation, and guest group membership', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'guest-policy-owner');
    const guest = seedTenant(database, 'guest-policy-user');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_guest-policy-owner', ?, 'guest', 'active', ?, ?)`,
      )
      .run(guest.id, now, now);
    database
      .prepare(
        `INSERT INTO groups(id, organization_id, name, created_by, created_at)
         VALUES ('grp_guest_policy', 'org_guest-policy-owner', 'Editors', ?, ?)`,
      )
      .run(owner.id, now);
    const env = testEnv(database);
    const context = testContext();

    const invitation = await handleTenancyApi(
      new Request('https://docs.test/api/organizations/org_guest-policy-owner/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'external@example.com', role: 'guest' }),
      }),
      env,
      owner,
      context,
    );
    expect(invitation?.status).toBe(400);
    await expect(invitation?.json()).resolves.toMatchObject({ code: 'guest_role_disabled' });

    const elevated = await handleTenancyApi(
      new Request(`https://docs.test/api/spaces/spc_guest-policy-owner/grants/user/${guest.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'editor' }),
      }),
      env,
      owner,
      context,
    );
    expect(elevated?.status).toBe(400);
    await expect(elevated?.json()).resolves.toMatchObject({ code: 'guest_read_only' });

    const grouped = await handleTenancyApi(
      new Request(
        `https://docs.test/api/organizations/org_guest-policy-owner/groups/grp_guest_policy/members/${guest.id}`,
        { method: 'PUT' },
      ),
      env,
      owner,
      context,
    );
    expect(grouped?.status).toBe(400);
    await expect(grouped?.json()).resolves.toMatchObject({ code: 'guest_group_disabled' });
    database.close();
  });

  it('lets an explicit user deny override organization-visible space access', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'space-deny-owner');
    const member = seedTenant(database, 'space-deny-member');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_space-deny-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database
      .prepare("UPDATE spaces SET visibility = 'organization' WHERE id = 'spc_space-deny-owner'")
      .run();
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_space_deny', 'org_space-deny-owner', 'spc_space-deny-owner',
                   'user', ?, 'none', ?, ?)`,
      )
      .run(member.id, owner.id, now);

    await expect(
      resolveSpaceAccess(testEnv(database), 'spc_space-deny-owner', member.id),
    ).resolves.toBeNull();
    database.close();
  });

  it('hides another tenant and rejects a cross-tenant grant', async () => {
    const database = migratedDatabase();
    const ownerA = seedTenant(database, 'alpha');
    const ownerB = seedTenant(database, 'beta');
    const env = testEnv(database);
    const context = testContext();

    const hidden = await handleTenancyApi(
      new Request('https://docs.test/api/spaces/spc_beta'),
      env,
      ownerA,
      context,
    );
    expect(hidden?.status).toBe(404);

    const mismatchedGrant = await handleTenancyApi(
      new Request('https://docs.test/api/spaces/spc_alpha/grants/user/usr_beta', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      }),
      env,
      ownerA,
      context,
    );
    expect(mismatchedGrant?.status).toBe(400);
    await expect(mismatchedGrant?.json()).resolves.toMatchObject({
      code: 'principal_tenant_mismatch',
    });

    const inverseHidden = await handleTenancyApi(
      new Request('https://docs.test/api/spaces/spc_alpha'),
      env,
      ownerB,
      context,
    );
    expect(inverseHidden?.status).toBe(404);
    database.close();
  });

  it('returns the archived space instead of a misleading 404', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'archive');
    const response = await handleTenancyApi(
      new Request('https://docs.test/api/spaces/spc_archive', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
      testEnv(database),
      owner,
      testContext(),
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      space: { id: 'spc_archive', archivedAt: expect.any(Number) },
    });
    const listed = await handleTenancyApi(
      new Request('https://docs.test/api/organizations/org_archive/spaces?includeArchived=1'),
      testEnv(database),
      owner,
      testContext(),
    );
    await expect(listed?.json()).resolves.toMatchObject({
      spaces: [expect.objectContaining({ id: 'spc_archive', archivedAt: expect.any(Number) })],
    });

    const restored = await handleTenancyApi(
      new Request('https://docs.test/api/spaces/spc_archive', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      }),
      testEnv(database),
      owner,
      testContext(),
    );
    await expect(restored?.json()).resolves.toMatchObject({
      space: { id: 'spc_archive', archivedAt: null },
    });
    database.close();
  });

  it('removes the automatic organization grant when a space becomes restricted', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'visibility');
    database
      .prepare("UPDATE spaces SET visibility = 'organization' WHERE id = 'spc_visibility'")
      .run();
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_visibility_org', 'org_visibility', 'spc_visibility', 'organization',
                   'org_visibility', 'viewer', ?, ?)`,
      )
      .run(owner.id, Date.now());
    const response = await handleTenancyApi(
      new Request('https://docs.test/api/spaces/spc_visibility', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'restricted' }),
      }),
      testEnv(database),
      owner,
      testContext(),
    );
    expect(response?.status).toBe(200);
    expect(
      database
        .prepare("SELECT COUNT(*) AS total FROM space_grants WHERE id = 'grant_visibility_org'")
        .get(),
    ).toMatchObject({ total: 0 });
    database.close();
  });

  it('inherits space access, then only narrows it at a restricted page boundary', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'pages');
    const member = seedTenant(database, 'member');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_pages', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_pages_member', 'org_pages', 'spc_pages', 'user', ?, 'editor', ?, ?)`,
      )
      .run(member.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key, created_by, updated_by,
           created_at, updated_at
         ) VALUES ('page_restricted', 'org_pages', 'spc_pages', NULL, 'Restricted', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES ('page_restricted', 1, 1, ?)`,
      )
      .run(now);
    const env = testEnv(database);

    await expect(resolvePageAccess(env, 'page_restricted', member.id)).resolves.toMatchObject({
      spaceRole: 'editor',
    });
    database
      .prepare(
        `UPDATE page_access_state SET access_mode = 'restricted' WHERE page_id = 'page_restricted'`,
      )
      .run();
    await expect(resolvePageAccess(env, 'page_restricted', member.id)).resolves.toBeNull();
    database
      .prepare(
        `INSERT INTO page_grants(
           id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('page_grant_member', 'org_pages', 'page_restricted', 'user', ?, 'viewer', ?, ?)`,
      )
      .run(member.id, owner.id, now);
    await expect(resolvePageAccess(env, 'page_restricted', member.id)).resolves.toMatchObject({
      spaceRole: 'viewer',
    });
    database
      .prepare(
        `UPDATE page_grants SET role = 'space_admin'
          WHERE page_id = 'page_restricted' AND principal_type = 'user' AND principal_id = ?`,
      )
      .run(member.id);
    await expect(resolvePageAccess(env, 'page_restricted', member.id)).resolves.toMatchObject({
      spaceRole: 'space_admin',
    });
    database
      .prepare(
        `UPDATE page_grants SET role = 'none'
          WHERE page_id = 'page_restricted' AND principal_type = 'user' AND principal_id = ?`,
      )
      .run(member.id);
    await expect(resolvePageAccess(env, 'page_restricted', member.id)).resolves.toBeNull();
    await expect(resolvePageAccess(env, 'page_restricted', owner.id)).resolves.toMatchObject({
      spaceRole: 'space_admin',
    });
    database.close();
  });

  it('returns a successful snapshot when a page administrator demotes themself', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'self-demote-owner');
    const administrator = seedTenant(database, 'self-demote-admin');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_self-demote-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(administrator.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_self_demote', 'org_self-demote-owner', 'spc_self-demote-owner',
                   'user', ?, 'viewer', ?, ?)`,
      )
      .run(administrator.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_self_demote', 'org_self-demote-owner', 'spc_self-demote-owner',
                   'Self demote', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, access_mode, updated_at)
         VALUES ('page_self_demote', 1, 1, 'restricted', ?)`,
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO page_grants(
           id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('page_grant_self_demote', 'org_self-demote-owner', 'page_self_demote',
                   'user', ?, 'space_admin', ?, ?)`,
      )
      .run(administrator.id, owner.id, now);

    database
      .prepare(
        `UPDATE page_grants SET role = 'viewer'
          WHERE page_id = 'page_self_demote' AND principal_type = 'user' AND principal_id = ?`,
      )
      .run(administrator.id);
    const env = testEnv(database);
    const response = await pageAccessSnapshot(env, 'page_self_demote');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'restricted',
      grants: [{ principalId: administrator.id, role: 'viewer' }],
    });
    await expect(
      resolvePageAccess(env, 'page_self_demote', administrator.id),
    ).resolves.toMatchObject({ spaceRole: 'viewer' });
    database.close();
  });

  it('lists a large page tree with a fixed number of permission queries', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'tree-owner');
    const member = seedTenant(database, 'tree-member');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_tree-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_tree_member', 'org_tree-owner', 'spc_tree-owner', 'user', ?, 'editor', ?, ?)`,
      )
      .run(member.id, owner.id, now);

    const insertPage = database.prepare(
      `INSERT INTO pages(
         id, organization_id, space_id, parent_id, title, sort_key,
         created_by, updated_by, created_at, updated_at
       ) VALUES (?, 'org_tree-owner', 'spc_tree-owner', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertState = database.prepare(
      `INSERT INTO page_access_state(
         page_id, collaboration_enabled, acl_version, access_mode, updated_at
       ) VALUES (?, 1, 1, ?, ?)`,
    );
    for (let index = 0; index < 120; index += 1) {
      const id = `page_public_${index.toString().padStart(3, '0')}`;
      insertPage.run(id, null, `Public ${index}`, id, owner.id, owner.id, now, now);
      insertState.run(id, 'inherit', now);
    }
    insertPage.run('page_hidden_root', null, 'Hidden root', 'zz-1', owner.id, owner.id, now, now);
    insertState.run('page_hidden_root', 'restricted', now);
    insertPage.run(
      'page_hidden_child',
      'page_hidden_root',
      'Hidden child',
      'zz-2',
      owner.id,
      owner.id,
      now,
      now,
    );
    insertState.run('page_hidden_child', 'inherit', now);
    insertPage.run('page_granted_root', null, 'Granted root', 'zz-3', owner.id, owner.id, now, now);
    insertState.run('page_granted_root', 'restricted', now);
    insertPage.run(
      'page_granted_child',
      'page_granted_root',
      'Granted child',
      'zz-4',
      owner.id,
      owner.id,
      now,
      now,
    );
    insertState.run('page_granted_child', 'inherit', now);
    database
      .prepare(
        `INSERT INTO page_grants(
           id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('page_grant_tree_member', 'org_tree-owner', 'page_granted_root',
                   'user', ?, 'viewer', ?, ?)`,
      )
      .run(member.id, owner.id, now);

    const d1 = new TestD1(database);
    const response = await listPages(testEnv(database, d1), 'spc_tree-owner', member.id);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { pages: Array<{ id: string }> };
    const ids = new Set(result.pages.map((page) => page.id));
    expect(ids.size).toBe(122);
    expect(ids.has('page_hidden_root')).toBe(false);
    expect(ids.has('page_hidden_child')).toBe(false);
    expect(ids.has('page_granted_root')).toBe(true);
    expect(ids.has('page_granted_child')).toBe(true);
    expect(d1.prepareCalls).toBe(5);
    database.close();
  });

  it('resolves space and page grants through an organization-scoped user group', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'group-owner');
    const member = seedTenant(database, 'group-member');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_group-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database
      .prepare(
        `INSERT INTO groups(id, organization_id, name, created_by, created_at)
         VALUES ('grp_editors', 'org_group-owner', 'Editors', ?, ?)`,
      )
      .run(owner.id, now);
    database
      .prepare(
        "INSERT INTO group_members(group_id, user_id, created_at) VALUES ('grp_editors', ?, ?)",
      )
      .run(member.id, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_group', 'org_group-owner', 'spc_group-owner', 'group',
                   'grp_editors', 'editor', ?, ?)`,
      )
      .run(owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_group', 'org_group-owner', 'spc_group-owner', 'Group page', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, access_mode, updated_at)
         VALUES ('page_group', 1, 1, 'restricted', ?)`,
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO page_grants(
           id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('page_grant_group', 'org_group-owner', 'page_group', 'group',
                   'grp_editors', 'commenter', ?, ?)`,
      )
      .run(owner.id, now);
    await expect(
      resolvePageAccess(testEnv(database), 'page_group', member.id),
    ).resolves.toMatchObject({
      spaceRole: 'commenter',
    });
    database.close();
  });

  it('creates mention and subscribed-comment notifications inside the tenant', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'comment-owner');
    const commenter = seedTenant(database, 'commenter');
    const watcher = seedTenant(database, 'comment-watcher');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_comment-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(commenter.id, now, now);
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_comment-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(watcher.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_commenter', 'org_comment-owner', 'spc_comment-owner', 'user', ?, 'commenter', ?, ?)`,
      )
      .run(commenter.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_comment_watcher', 'org_comment-owner', 'spc_comment-owner',
                   'user', ?, 'viewer', ?, ?)`,
      )
      .run(watcher.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES ('page_comments', 'org_comment-owner', 'spc_comment-owner', NULL,
                   'Comments', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES ('page_comments', 1, 1, ?)`,
      )
      .run(now);
    const env = testEnv(database);
    const watcherSettings = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_comments/notification-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'all_comments' }),
      }),
      env,
      watcher,
    );
    expect(watcherSettings?.status).toBe(200);

    const response = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_comments/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: `请看一下 @${owner.email}` }),
      }),
      env,
      commenter,
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      threads: [{ pageId: 'page_comments', comments: [{ author: { id: commenter.id } }] }],
    });

    const notifications = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/notifications?organizationId=org_comment-owner'),
      env,
      owner,
    );
    await expect(notifications?.json()).resolves.toMatchObject({
      unreadCount: 1,
      notifications: [{ type: 'mention', pageId: 'page_comments' }],
    });
    const watcherNotifications = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/notifications?organizationId=org_comment-owner'),
      env,
      watcher,
    );
    await expect(watcherNotifications?.json()).resolves.toMatchObject({
      unreadCount: 1,
      notifications: [{ type: 'page_comment', pageId: 'page_comments' }],
    });
    expect(
      database
        .prepare(
          'SELECT mode FROM page_notification_subscriptions WHERE page_id = ? AND user_id = ?',
        )
        .get('page_comments', commenter.id),
    ).toEqual({ mode: 'replies_mentions' });
    database.close();
  });

  it('delivers permission-filtered page updates and supports inbox read and archive workflows', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'notify-owner');
    const editor = seedTenant(database, 'notify-editor');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_notify-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(editor.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_notify_editor', 'org_notify-owner', 'spc_notify-owner',
                   'user', ?, 'editor', ?, ?)`,
      )
      .run(editor.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_notify', 'org_notify-owner', 'spc_notify-owner',
                   'Notification page', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES ('page_notify', 1, 1, ?)`,
      )
      .run(now);
    const env = testEnv(database);

    const defaultSettings = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_notify/notification-settings'),
      env,
      owner,
    );
    await expect(defaultSettings?.json()).resolves.toMatchObject({
      settings: { mode: 'replies_mentions', explicitlySet: false },
    });
    const settings = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_notify/notification-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'all_updates' }),
      }),
      env,
      owner,
    );
    await expect(settings?.json()).resolves.toMatchObject({
      settings: { mode: 'all_updates', explicitlySet: true },
    });

    const delivery = {
      organizationId: 'org_notify-owner',
      pageId: 'page_notify',
      actorId: editor.id,
      eventKey: 'page-content:page_notify:1:7',
      metadata: { eventType: 'page.content_updated', collabSeq: 7 },
    };
    await expect(deliverPageUpdateNotifications(env, delivery)).resolves.toBe(1);
    await expect(deliverPageUpdateNotifications(env, delivery)).resolves.toBe(1);
    expect(
      database
        .prepare('SELECT COUNT(*) AS total FROM notifications WHERE event_key = ?')
        .get(delivery.eventKey),
    ).toEqual({ total: 1 });

    const inbox = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/notifications?organizationId=org_notify-owner&view=inbox'),
      env,
      owner,
    );
    const inboxBody = (await inbox?.json()) as {
      notifications: Array<{ id: string; type: string; archivedAt: number | null }>;
      unreadCount: number;
    };
    expect(inboxBody).toMatchObject({
      unreadCount: 1,
      notifications: [{ type: 'page_updated', archivedAt: null }],
    });
    const notificationId = inboxBody.notifications[0]?.id;
    expect(notificationId).toBeTruthy();

    const read = await handleCommentsAndNotificationsApi(
      new Request(`https://docs.test/api/notifications/${notificationId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ read: true }),
      }),
      env,
      owner,
    );
    expect(read?.status).toBe(200);
    const archive = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/notifications/archive-read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_notify-owner' }),
      }),
      env,
      owner,
    );
    expect(archive?.status).toBe(200);
    const archived = await handleCommentsAndNotificationsApi(
      new Request(
        'https://docs.test/api/notifications?organizationId=org_notify-owner&view=archived',
      ),
      env,
      owner,
    );
    await expect(archived?.json()).resolves.toMatchObject({
      unreadCount: 0,
      notifications: [{ id: notificationId, type: 'page_updated' }],
    });
    database.close();
  });

  it('creates permission-bound reminders, delivers them once, and groups the inbox by page', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'reminder-owner');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_reminder', 'org_reminder-owner', 'spc_reminder-owner',
                   'Reminder page', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES ('page_reminder', 1, 1, ?)`,
      )
      .run(now);
    const env = testEnv(database);

    const created = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_reminder/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipientId: owner.id,
          message: 'Review the launch plan',
          dueAt: now + 60 * 60_000,
          remindAt: now + 30 * 60_000,
          timezone: 'UTC',
        }),
      }),
      env,
      owner,
    );
    expect(created?.status).toBe(200);
    const createdBody = (await created?.json()) as {
      reminders: Array<{ id: string; recipient: { id: string } }>;
    };
    expect(createdBody.reminders).toHaveLength(1);
    expect(createdBody.reminders[0]?.recipient.id).toBe(owner.id);
    const reminderId = createdBody.reminders[0]?.id;
    expect(reminderId).toBeTruthy();

    const updated = await handleCommentsAndNotificationsApi(
      new Request(`https://docs.test/api/reminders/${reminderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipientId: owner.id,
          message: 'Review the final launch plan',
          dueAt: now + 2 * 60 * 60_000,
          remindAt: now + 60 * 60_000,
          timezone: 'UTC',
        }),
      }),
      env,
      owner,
    );
    await expect(updated?.json()).resolves.toMatchObject({
      reminders: [{ id: reminderId, message: 'Review the final launch plan' }],
    });

    database
      .prepare('UPDATE page_reminders SET remind_at = ? WHERE id = ?')
      .run(now - 1, reminderId);
    await expect(deliverDueReminders(env, owner.id)).resolves.toBe(1);
    await expect(deliverDueReminders(env, owner.id)).resolves.toBe(0);

    const inbox = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/notifications?organizationId=org_reminder-owner'),
      env,
      owner,
    );
    const inboxBody = (await inbox?.json()) as {
      notifications: Array<{
        id: string;
        type: string;
        metadata: { reminderId: string; message: string };
      }>;
      groups: Array<{ pageId: string; unreadCount: number; notifications: unknown[] }>;
    };
    expect(inboxBody.notifications).toMatchObject([
      {
        type: 'reminder',
        metadata: { reminderId, message: 'Review the final launch plan' },
      },
    ]);
    expect(inboxBody.groups).toMatchObject([
      { pageId: 'page_reminder', unreadCount: 1, notifications: [{}] },
    ]);
    expect(
      database
        .prepare('SELECT status, delivered_at FROM page_reminders WHERE id = ?')
        .get(reminderId),
    ).toMatchObject({ status: 'delivered', delivered_at: expect.any(Number) });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM notifications WHERE event_key = ?')
        .get(`reminder:${reminderId}`),
    ).toEqual({ count: 1 });

    const sourceInput = {
      recipientId: owner.id,
      message: 'Review this paragraph',
      dueAt: now + 3 * 60 * 60_000,
      remindAt: now + 2 * 60 * 60_000,
      timezone: 'UTC',
      sourceType: 'inline',
      sourceId: 'inline-node-1',
    };
    const sourceCreated = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_reminder/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourceInput),
      }),
      env,
      owner,
    );
    const sourceBody = (await sourceCreated?.json()) as {
      reminders: Array<{ id: string; sourceType: string; sourceId: string | null }>;
    };
    const sourceReminder = sourceBody.reminders.find(
      (reminder) => reminder.sourceId === 'inline-node-1',
    );
    expect(sourceReminder).toMatchObject({ sourceType: 'inline', sourceId: 'inline-node-1' });

    const duplicateSource = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_reminder/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourceInput),
      }),
      env,
      owner,
    );
    expect(duplicateSource?.status).toBe(409);

    const changedSource = await handleCommentsAndNotificationsApi(
      new Request(`https://docs.test/api/reminders/${sourceReminder?.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...sourceInput,
          sourceType: 'database_date',
          sourceId: 'database:row:date',
        }),
      }),
      env,
      owner,
    );
    expect(changedSource?.status).toBe(400);

    const cancelledSource = await handleCommentsAndNotificationsApi(
      new Request(
        'https://docs.test/api/pages/page_reminder/reminders/source?sourceType=inline&sourceId=inline-node-1',
        { method: 'DELETE' },
      ),
      env,
      owner,
    );
    expect(cancelledSource?.status).toBe(200);
    expect(
      database.prepare('SELECT status FROM page_reminders WHERE id = ?').get(sourceReminder?.id),
    ).toEqual({ status: 'cancelled' });
    database.close();
  });

  it('hides previously delivered page notifications immediately after access is revoked', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'notify-revoke-owner');
    const member = seedTenant(database, 'notify-revoke-member');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_notify-revoke-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_notify_revoke_space', 'org_notify-revoke-owner',
                   'spc_notify-revoke-owner', 'user', ?, 'editor', ?, ?)`,
      )
      .run(member.id, owner.id, now);
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_notify_revoke', 'org_notify-revoke-owner',
                   'spc_notify-revoke-owner', 'Restricted notifications', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(
           page_id, collaboration_enabled, acl_version, access_mode, updated_at
         ) VALUES ('page_notify_revoke', 1, 1, 'restricted', ?)`,
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO page_grants(
           id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_notify_revoke_page', 'org_notify-revoke-owner',
                   'page_notify_revoke', 'user', ?, 'viewer', ?, ?)`,
      )
      .run(member.id, owner.id, now);
    const env = testEnv(database);
    const settings = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_notify_revoke/notification-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'all_updates' }),
      }),
      env,
      member,
    );
    expect(settings?.status).toBe(200);
    await deliverPageUpdateNotifications(env, {
      organizationId: 'org_notify-revoke-owner',
      pageId: 'page_notify_revoke',
      actorId: owner.id,
      eventKey: 'page-audit:revoke-check',
    });
    expect(
      database
        .prepare('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?')
        .get(member.id),
    ).toEqual({ total: 1 });

    database.prepare("DELETE FROM page_grants WHERE id = 'grant_notify_revoke_page'").run();
    const inbox = await handleCommentsAndNotificationsApi(
      new Request(
        'https://docs.test/api/notifications?organizationId=org_notify-revoke-owner&view=inbox',
      ),
      env,
      member,
    );
    await expect(inbox?.json()).resolves.toMatchObject({ unreadCount: 0, notifications: [] });
    database.close();
  });

  it('stores Yjs relative anchors for selected-text comments', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'anchors');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, title, sort_key, created_by, updated_by, created_at, updated_at
         ) VALUES ('page_anchors', 'org_anchors', 'spc_anchors', 'Anchors', '1', ?, ?, ?, ?)`,
      )
      .run(owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES ('page_anchors', 1, 1, ?)`,
      )
      .run(now);
    const response = await handleCommentsAndNotificationsApi(
      new Request('https://docs.test/api/pages/page_anchors/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body: '相对位置评论',
          quotedText: '被选择的文字',
          anchorStart: 'relative-start',
          anchorEnd: 'relative-end',
        }),
      }),
      testEnv(database),
      owner,
    );
    expect(response?.status).toBe(200);
    expect(
      database
        .prepare('SELECT anchor_start, anchor_end FROM comment_threads WHERE page_id = ?')
        .get('page_anchors'),
    ).toMatchObject({ anchor_start: 'relative-start', anchor_end: 'relative-end' });
    database.close();
  });

  it('exposes audit activity only to organization administrators', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'audit');
    const member = seedTenant(database, 'audit-member');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_audit', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database
      .prepare(
        `INSERT INTO audit_events(
           id, organization_id, actor_id, event_type, target_type, target_id, metadata_json, created_at
         ) VALUES ('audit_one', 'org_audit', ?, 'space.created', 'space', 'spc_audit', '{}', ?)`,
      )
      .run(owner.id, now);
    const ownerResponse = await handleTenancyApi(
      new Request('https://docs.test/api/organizations/org_audit/activity'),
      testEnv(database),
      owner,
      testContext(),
    );
    expect(ownerResponse?.status).toBe(200);
    await expect(ownerResponse?.json()).resolves.toMatchObject({
      events: [{ id: 'audit_one', actor: { id: owner.id } }],
    });
    const memberResponse = await handleTenancyApi(
      new Request('https://docs.test/api/organizations/org_audit/activity'),
      testEnv(database),
      member,
      testContext(),
    );
    expect(memberResponse?.status).toBe(403);
    database.close();
  });
});

describe('Notion parity platform', () => {
  const pageId = '11111111-1111-4111-8111-111111111111';
  const propertyId = '22222222-2222-4222-8222-222222222222';
  const databaseId = '33333333-3333-4333-8333-333333333333';

  function seedPage(database: DatabaseSync, owner: AuthUserSummary, suffix = 'parity') {
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 'Parity page', '1', ?, ?, ?, ?)`,
      )
      .run(pageId, `org_${suffix}`, `spc_${suffix}`, owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, access_mode, updated_at)
         VALUES (?, 1, 1, 'inherit', ?)`,
      )
      .run(pageId, now);
    database
      .prepare(
        `INSERT INTO page_search_projection(
           page_id, organization_id, space_id, generation, collab_seq, title, normalized_body, updated_at
         ) VALUES (?, ?, ?, 1, 0, 'Parity page', 'secret body', ?)`,
      )
      .run(pageId, `org_${suffix}`, `spc_${suffix}`, now);
  }

  it('issues a scoped API token that cannot read another tenant page', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'parity');
    const outsider = seedTenant(database, 'parity-out');
    seedPage(database, owner);
    const env = testEnv(database);
    const created = await handlePlatformApi(
      new Request('https://docs.test/api/organizations/org_parity/api-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'CI', scopes: ['pages:read', 'search:read'] }),
      }),
      env,
      owner,
    );
    expect(created?.status).toBe(201);
    const payload = (await created?.json()) as { token: { token: string } };
    const allowed = await handlePublicApi(
      new Request(`https://docs.test/api/v1/pages/${pageId}`, {
        headers: { authorization: `Bearer ${payload.token.token}` },
      }),
      env,
      testContext(),
    );
    expect(allowed?.status).toBe(200);
    const outsiderToken = await handlePlatformApi(
      new Request('https://docs.test/api/organizations/org_parity-out/api-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Out', scopes: ['pages:read'] }),
      }),
      env,
      outsider,
    );
    const outsiderPayload = (await outsiderToken?.json()) as { token: { token: string } };
    const denied = await handlePublicApi(
      new Request(`https://docs.test/api/v1/pages/${pageId}`, {
        headers: { authorization: `Bearer ${outsiderPayload.token.token}` },
      }),
      env,
      testContext(),
    );
    expect(denied?.status).toBe(404);
    database.close();
  });

  it('blocks delete when a page is on legal hold and degrades AI without a model key', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'parity');
    seedPage(database, owner);
    const env = testEnv(database);
    const hold = await handlePlatformApi(
      new Request('https://docs.test/api/organizations/org_parity/legal-holds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageId, reason: '诉讼保全' }),
      }),
      env,
      owner,
    );
    expect(hold?.status).toBe(201);
    await expect(pagesOnLegalHold(env, [pageId])).resolves.toEqual([pageId]);
    const ai = await handlePlatformApi(
      new Request(`https://docs.test/api/pages/${pageId}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'summarize', prompt: '总结这一页' }),
      }),
      env,
      owner,
    );
    expect(ai?.status).toBe(503);
    await expect(ai?.json()).resolves.toMatchObject({
      job: { status: 'degraded', citations: [{ pageId }] },
    });
    const exported = await handlePlatformApi(
      new Request('https://docs.test/api/organizations/org_parity/exports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'workspace', format: 'markdown' }),
      }),
      env,
      owner,
    );
    expect(exported?.status).toBe(201);
    await expect(exported?.json()).resolves.toMatchObject({
      job: { status: 'succeeded', pageCount: 1, format: 'markdown' },
    });
    database.close();
  });

  it('hides a column from members who only have a none grant', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'parity');
    const member = seedTenant(database, 'parity-col');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_parity', ?, 'member', 'active', ?, ?)`,
      )
      .run(member.id, now, now);
    database.prepare(`UPDATE spaces SET visibility = 'organization' WHERE id = 'spc_parity'`).run();
    seedPage(database, owner);
    database
      .prepare(
        `INSERT INTO databases(
           id, organization_id, page_id, is_locked, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'org_parity', ?, 0, ?, ?, ?, ?)`,
      )
      .run(databaseId, pageId, owner.id, owner.id, now, now);
    database
      .prepare(
        `INSERT INTO database_properties(
           id, organization_id, database_id, name, type, config_json, sort_order,
           created_by, created_at, updated_at
         ) VALUES (?, 'org_parity', ?, '薪资', 'number', '{}', 1, ?, ?, ?)`,
      )
      .run(propertyId, databaseId, owner.id, now, now);
    const grant = await handlePlatformApi(
      new Request(`https://docs.test/api/databases/${databaseId}/properties/${propertyId}/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ principalType: 'user', principalId: member.id, role: 'none' }),
      }),
      testEnv(database),
      owner,
    );
    expect(grant?.status).toBe(200);
    const snapshot = await handleDatabasesApi(
      new Request(`https://docs.test/api/databases/${databaseId}`),
      testEnv(database),
      member,
    );
    expect(snapshot?.status).toBe(200);
    const body = (await snapshot?.json()) as { properties: Array<{ id: string }> };
    expect(body.properties.map((property) => property.id)).not.toContain(propertyId);
    database.close();
  });

  it('provisions a personal workspace for a new passkey user', async () => {
    const database = migratedDatabase();
    const now = Date.now();
    const user: AuthUserSummary = {
      id: '44444444-4444-4444-8444-444444444444',
      email: 'new@rdocs.test',
      displayName: '新用户',
      avatarUrl: null,
    };
    database
      .prepare(
        `INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
      )
      .run(user.id, user.email, user.displayName, now, now);
    await provisionPersonalWorkspace(testEnv(database), user);
    expect(
      database
        .prepare(`SELECT role FROM organization_members WHERE user_id = ? AND status = 'active'`)
        .get(user.id),
    ).toMatchObject({ role: 'owner' });
    expect(
      database.prepare(`SELECT COUNT(*) AS total FROM spaces WHERE created_by = ?`).get(user.id),
    ).toMatchObject({ total: 1 });
    database.close();
  });
});
