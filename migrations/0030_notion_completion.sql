PRAGMA foreign_keys = ON;

ALTER TABLE pages ADD COLUMN cover_position TEXT NOT NULL DEFAULT 'center'
  CHECK (cover_position IN ('top', 'center', 'bottom'));

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('automation', 'reminder', 'email_digest', 'export')),
  payload_json TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
  ON scheduled_jobs(status, run_at, id);

CREATE TABLE IF NOT EXISTS outbound_emails (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_user_id TEXT,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  error_message TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbound_emails_org
  ON outbound_emails(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_installs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  app_id TEXT NOT NULL REFERENCES oauth_apps(id),
  installer_user_id TEXT NOT NULL REFERENCES users(id),
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_installs_org ON oauth_installs(organization_id, created_at DESC);
