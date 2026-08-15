PRAGMA foreign_keys = ON;

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

CREATE INDEX idx_page_reminders_recipient_due
  ON page_reminders(recipient_id, status, remind_at, id);

CREATE INDEX idx_page_reminders_page
  ON page_reminders(page_id, status, due_at, id);

CREATE TABLE notifications_with_reminders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'mention', 'comment_reply', 'page_comment', 'page_updated',
    'page_shared', 'permission_changed', 'invitation_accepted', 'reminder'
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

INSERT INTO notifications_with_reminders(
  id, organization_id, user_id, actor_id, type, page_id, thread_id,
  comment_id, metadata_json, event_key, created_at, read_at, archived_at
)
SELECT id, organization_id, user_id, actor_id, type, page_id, thread_id,
       comment_id, metadata_json, event_key, created_at, read_at, archived_at
  FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_with_reminders RENAME TO notifications;

CREATE INDEX idx_notifications_user
  ON notifications(user_id, organization_id, archived_at, read_at, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_event_key
  ON notifications(user_id, event_key)
  WHERE event_key IS NOT NULL;
