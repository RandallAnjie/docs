PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inbound_emails (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  page_id TEXT REFERENCES pages(id),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'failed')),
  error_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_created
  ON inbound_emails(created_at DESC);
