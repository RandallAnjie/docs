PRAGMA foreign_keys = ON;

CREATE TABLE notifications_next (
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

INSERT INTO notifications_next(
  id, organization_id, user_id, actor_id, type, page_id, thread_id,
  comment_id, metadata_json, event_key, created_at, read_at, archived_at
)
SELECT id, organization_id, user_id, actor_id, type, page_id, thread_id,
       comment_id, metadata_json, NULL, created_at, read_at, NULL
  FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;

CREATE INDEX idx_notifications_user
  ON notifications(user_id, organization_id, archived_at, read_at, created_at DESC);

CREATE UNIQUE INDEX idx_notifications_event_key
  ON notifications(user_id, event_key)
  WHERE event_key IS NOT NULL;

CREATE TABLE page_notification_subscriptions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('all_updates', 'all_comments', 'replies_mentions')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, user_id)
);

CREATE INDEX idx_page_notification_subscriptions_user
  ON page_notification_subscriptions(user_id, organization_id, updated_at DESC);

CREATE INDEX idx_page_notification_subscriptions_page
  ON page_notification_subscriptions(page_id, mode, user_id);
