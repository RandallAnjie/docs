// Node's built-in sqlite typings are intentionally outside the Worker tsconfig.
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

describe('page discovery migration', () => {
  it('creates tenant-safe page links and advances the editor schema', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE pages(
        id TEXT PRIMARY KEY,
        editor_schema_version INTEGER NOT NULL
      );
      INSERT INTO pages VALUES ('source', 7), ('target', 7);
    `);
    database.exec(
      readFileSync(
        new URL('../../../migrations/0023_page_discovery_and_links.sql', import.meta.url),
        'utf8',
      ),
    );
    database.prepare('INSERT INTO page_links VALUES (?, ?, ?, ?)').run('source', 'target', 1, 1);

    expect(
      database.prepare('SELECT MIN(editor_schema_version) AS version FROM pages').get(),
    ).toEqual({ version: 8 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.prepare("DELETE FROM pages WHERE id = 'target'").run();
    expect(database.prepare('SELECT COUNT(*) AS count FROM page_links').get()).toEqual({
      count: 0,
    });
    database.close();
  });
});
