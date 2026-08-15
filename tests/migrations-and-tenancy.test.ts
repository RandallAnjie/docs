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
import { handleTenancyApi } from '../apps/worker/src/tenancy';
import { handleCommentsAndNotificationsApi } from '../apps/worker/src/comments';
import { handleDatabasesApi } from '../apps/worker/src/databases';

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

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const migration of [
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
  ]) {
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
    ).toMatchObject({ total: 7 });
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
          values: { [titlePropertyId!]: '发布 Rdocs', [numberProperty.property.id]: 3 },
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

  it('creates page comments and an unread mention notification inside the tenant', async () => {
    const database = migratedDatabase();
    const owner = seedTenant(database, 'comment-owner');
    const commenter = seedTenant(database, 'commenter');
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO organization_members(organization_id, user_id, role, status, joined_at, updated_at)
         VALUES ('org_comment-owner', ?, 'member', 'active', ?, ?)`,
      )
      .run(commenter.id, now, now);
    database
      .prepare(
        `INSERT INTO space_grants(
           id, organization_id, space_id, principal_type, principal_id, role, created_by, created_at
         ) VALUES ('grant_commenter', 'org_comment-owner', 'spc_comment-owner', 'user', ?, 'commenter', ?, ?)`,
      )
      .run(commenter.id, owner.id, now);
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
