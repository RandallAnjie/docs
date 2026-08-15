// Node's built-in sqlite typings are intentionally outside the Worker tsconfig.
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

describe('page reminder migration', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('preserves inbox rows and adds tenant-bound reminder scheduling', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations(id TEXT PRIMARY KEY);
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE pages(
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE comment_threads(
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE
      );
      CREATE TABLE comments(
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE
      );
      CREATE TABLE notifications(
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id),
        type TEXT NOT NULL CHECK (type IN (
          'mention', 'comment_reply', 'page_comment', 'page_updated',
          'page_shared', 'permission_changed', 'invitation_accepted'
        )),
        page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES comment_threads(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        event_key TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        archived_at INTEGER
      );
      CREATE INDEX idx_notifications_user
        ON notifications(user_id, organization_id, archived_at, read_at, created_at DESC);
      CREATE UNIQUE INDEX idx_notifications_event_key
        ON notifications(user_id, event_key) WHERE event_key IS NOT NULL;
      INSERT INTO organizations VALUES ('org-1');
      INSERT INTO users VALUES ('creator'), ('recipient');
      INSERT INTO pages VALUES ('page-1', 'org-1');
      INSERT INTO notifications(
        id, organization_id, user_id, actor_id, type, page_id, thread_id,
        comment_id, metadata_json, event_key, created_at, read_at, archived_at
      ) VALUES (
        'notification-1', 'org-1', 'recipient', 'creator', 'page_updated',
        'page-1', NULL, NULL, '{}', 'event-1', 10, NULL, NULL
      );
    `);
    database.exec(
      readFileSync(
        new URL('../../../migrations/0026_page_reminders_and_inbox_groups.sql', import.meta.url),
        'utf8',
      ),
    );

    expect(database.prepare('SELECT id, type FROM notifications').all()).toEqual([
      { id: 'notification-1', type: 'page_updated' },
    ]);
    database
      .prepare(
        `INSERT INTO page_reminders(
           id, organization_id, page_id, created_by, recipient_id, message,
           due_at, remind_at, timezone, status, delivered_at, cancelled_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, ?, ?)`,
      )
      .run(
        'reminder-1',
        'org-1',
        'page-1',
        'creator',
        'recipient',
        'Review this page',
        2_000,
        1_000,
        'UTC',
        1,
        1,
      );
    database
      .prepare(
        `INSERT INTO notifications(
           id, organization_id, user_id, actor_id, type, page_id, thread_id,
           comment_id, metadata_json, event_key, created_at, read_at, archived_at
         ) VALUES (?, ?, ?, ?, 'reminder', ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        'notification-2',
        'org-1',
        'recipient',
        'creator',
        'page-1',
        '{"reminderId":"reminder-1"}',
        'reminder:reminder-1',
        1_000,
      );

    expect(database.prepare('SELECT status FROM page_reminders').get()).toEqual({
      status: 'scheduled',
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      database
        .prepare('PRAGMA index_list(page_reminders)')
        .all()
        .map((row) => row.name),
    ).toEqual(
      expect.arrayContaining(['idx_page_reminders_page', 'idx_page_reminders_recipient_due']),
    );
  });
});
