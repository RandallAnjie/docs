PRAGMA foreign_keys = ON;

ALTER TABLE page_grants RENAME TO page_grants_before_acl_roles;

CREATE TABLE page_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'organization')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('none', 'space_admin', 'editor', 'commenter', 'viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, page_id, principal_type, principal_id)
);

INSERT INTO page_grants(
  id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
)
SELECT id, organization_id, page_id, principal_type, principal_id, role, created_by, created_at
  FROM page_grants_before_acl_roles;

DROP TABLE page_grants_before_acl_roles;

CREATE INDEX idx_page_grants_principal
  ON page_grants(organization_id, principal_type, principal_id, page_id);
