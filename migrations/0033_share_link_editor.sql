PRAGMA foreign_keys = OFF;

CREATE TABLE share_links_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

INSERT INTO share_links_new (
  id, organization_id, page_id, token_hash, role, expires_at, revoked_at, created_by, created_at
)
SELECT
  id, organization_id, page_id, token_hash, role, expires_at, revoked_at, created_by, created_at
FROM share_links;

DROP TABLE share_links;
ALTER TABLE share_links_new RENAME TO share_links;

PRAGMA foreign_keys = ON;
