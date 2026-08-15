// Node's built-in sqlite typings are intentionally outside the Worker tsconfig.
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

describe('reminder source migration', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('keeps page reminders and enforces one active source per creator', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec(`
      CREATE TABLE organizations(id TEXT PRIMARY KEY);
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE pages(id TEXT PRIMARY KEY, editor_schema_version INTEGER NOT NULL DEFAULT 9);
      CREATE TABLE page_reminders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id),
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        remind_at INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'delivered', 'cancelled')),
        delivered_at INTEGER,
        cancelled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (remind_at <= due_at),
        CHECK (
          (status = 'scheduled' AND delivered_at IS NULL AND cancelled_at IS NULL)
          OR (status = 'delivered' AND delivered_at IS NOT NULL AND cancelled_at IS NULL)
          OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
        )
      );
      INSERT INTO organizations VALUES ('org');
      INSERT INTO users VALUES ('creator'), ('second'), ('recipient');
      INSERT INTO pages(id) VALUES ('page');
      INSERT INTO page_reminders VALUES (
        'legacy', 'org', 'page', 'creator', 'recipient', 'Legacy page reminder',
        2000, 1000, 'UTC', 'scheduled', NULL, NULL, 1, 1
      );
    `);
    database.exec(
      readFileSync(
        new URL('../../../migrations/0027_reminder_sources.sql', import.meta.url),
        'utf8',
      ),
    );

    expect(
      database
        .prepare('SELECT source_type, source_id FROM page_reminders WHERE id = ?')
        .get('legacy'),
    ).toEqual({ source_type: 'page', source_id: null });
    expect(database.prepare('SELECT editor_schema_version FROM pages').get()).toEqual({
      editor_schema_version: 10,
    });

    const insert = database.prepare(
      `INSERT INTO page_reminders(
         id, organization_id, page_id, created_by, recipient_id, message,
         due_at, remind_at, timezone, status, delivered_at, cancelled_at,
         created_at, updated_at, source_type, source_id
       ) VALUES (?, 'org', 'page', ?, 'recipient', 'Inline reminder',
                 2000, 1000, 'UTC', 'scheduled', NULL, NULL, 1, 1, 'inline', 'node-1')`,
    );
    insert.run('inline-1', 'creator');
    expect(() => insert.run('inline-duplicate', 'creator')).toThrow();
    expect(() => insert.run('inline-other-creator', 'second')).not.toThrow();
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
