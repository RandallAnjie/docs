PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS revision_restore_operations (
  idempotency_key TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  source_generation INTEGER NOT NULL,
  target_generation INTEGER,
  previous_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'prepared', 'completed', 'failed')),
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_revision_restore_operations_page
  ON revision_restore_operations(page_id, created_at DESC);
