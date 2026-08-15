PRAGMA foreign_keys = ON;

INSERT INTO users(id, email, display_name, avatar_url, status, created_at, updated_at)
VALUES (
  'usr_rdocs_forms',
  'forms@system.rdocs.invalid',
  'Rdocs Forms',
  NULL,
  'active',
  unixepoch('now') * 1000,
  unixepoch('now') * 1000
)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS database_form_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_database_form_links_view
  ON database_form_links(view_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS database_form_submissions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  form_link_id TEXT NOT NULL REFERENCES database_form_links(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL UNIQUE REFERENCES database_rows(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_database_form_submissions_rate
  ON database_form_submissions(form_link_id, created_at DESC);
