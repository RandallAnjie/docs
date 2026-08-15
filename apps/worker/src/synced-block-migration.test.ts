// Node's built-in sqlite typings are intentionally outside the Worker tsconfig.
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

describe('cross-page synced block migration', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('creates tenant-bound resources and cascades page deletion', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations(id TEXT PRIMARY KEY);
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE pages(
        id TEXT PRIMARY KEY,
        editor_schema_version INTEGER NOT NULL,
        FOREIGN KEY (id) REFERENCES pages(id)
      );
      INSERT INTO organizations VALUES ('org-1');
      INSERT INTO users VALUES ('user-1');
      INSERT INTO pages VALUES ('source-page', 6), ('destination-page', 6);
    `);
    database.exec(
      readFileSync(
        new URL('../../../migrations/0021_cross_page_synced_blocks.sql', import.meta.url),
        'utf8',
      ),
    );
    database.exec(
      readFileSync(
        new URL('../../../migrations/0022_synced_block_lifecycle.sql', import.meta.url),
        'utf8',
      ),
    );

    database
      .prepare(
        `INSERT INTO synced_blocks(
          id, organization_id, source_page_id, editor_schema_version,
          created_by, updated_by, created_at, updated_at
        ) VALUES ('block-1', 'org-1', 'source-page', 7, 'user-1', 'user-1', 1, 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO synced_block_references
         VALUES ('block-1', 'destination-page', 1, 1)`,
      )
      .run();

    expect(
      database.prepare('SELECT editor_schema_version FROM pages WHERE id = ?').get('source-page'),
    ).toEqual({ editor_schema_version: 7 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      database.prepare("SELECT lifecycle_state FROM synced_blocks WHERE id = 'block-1'").get(),
    ).toEqual({ lifecycle_state: 'active' });

    database.prepare("DELETE FROM pages WHERE id = 'source-page'").run();
    expect(database.prepare('SELECT COUNT(*) AS count FROM synced_blocks').get()).toEqual({
      count: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM synced_block_references').get()).toEqual(
      { count: 0 },
    );
  });
});
