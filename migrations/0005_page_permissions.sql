PRAGMA foreign_keys = ON;

ALTER TABLE page_access_state
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (access_mode IN ('inherit', 'restricted'));

CREATE TABLE IF NOT EXISTS page_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'organization')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('space_admin', 'editor', 'commenter', 'viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, page_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_page_grants_principal
  ON page_grants(organization_id, principal_type, principal_id, page_id);
