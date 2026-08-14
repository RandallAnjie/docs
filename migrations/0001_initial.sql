PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended')),
  joined_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_organization_members_user
  ON organization_members(user_id, status);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  organization_role TEXT NOT NULL CHECK (organization_role IN ('admin', 'member', 'guest')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_org_email
  ON invitations(organization_id, email, accepted_at, revoked_at);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('organization', 'restricted')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS space_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group', 'organization')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('space_admin', 'editor', 'commenter', 'viewer')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, space_id, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_space_grants_principal
  ON space_grants(organization_id, principal_type, principal_id);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  parent_id TEXT REFERENCES pages(id),
  title TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  current_generation INTEGER NOT NULL DEFAULT 1,
  editor_schema_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_pages_tree
  ON pages(organization_id, space_id, parent_id, deleted_at, sort_key);
CREATE INDEX IF NOT EXISTS idx_pages_recent
  ON pages(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_space
  ON pages(space_id, deleted_at);

CREATE TABLE IF NOT EXISTS page_access_state (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  collaboration_enabled INTEGER NOT NULL DEFAULT 1 CHECK (collaboration_enabled IN (0, 1)),
  acl_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  generation INTEGER NOT NULL,
  collab_seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('automatic', 'manual', 'restore', 'pre_delete', 'pre_export')),
  label TEXT,
  description TEXT,
  snapshot_location TEXT NOT NULL CHECK (snapshot_location IN ('do', 'r2')),
  snapshot_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_page
  ON revisions(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'quarantined', 'deleted')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments(page_id, status);

CREATE TABLE IF NOT EXISTS comment_threads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  generation INTEGER NOT NULL,
  anchor_start TEXT,
  anchor_end TEXT,
  quoted_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id, created_at);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter')),
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_org
  ON audit_events(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS page_search_projection (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  collab_seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  normalized_body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS page_search_fts USING fts5(
  page_id UNINDEXED,
  title,
  normalized_body,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL REFERENCES users(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE IF NOT EXISTS page_visits (
  user_id TEXT NOT NULL REFERENCES users(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

INSERT OR IGNORE INTO users(
  id, email, display_name, avatar_url, status, created_at, updated_at
) VALUES (
  'usr_phase0_system', 'phase0-system@rdocs.invalid', 'Rdocs Phase 0', NULL, 'active', 0, 0
);

INSERT OR IGNORE INTO organizations(
  id, name, slug, created_by, created_at, updated_at, deleted_at
) VALUES (
  'org_phase0', 'Rdocs', 'rdocs', 'usr_phase0_system', 0, 0, NULL
);

INSERT OR IGNORE INTO organization_members(
  organization_id, user_id, role, status, joined_at, updated_at
) VALUES (
  'org_phase0', 'usr_phase0_system', 'owner', 'active', 0, 0
);

INSERT OR IGNORE INTO spaces(
  id, organization_id, name, slug, icon, visibility,
  created_by, created_at, updated_at, archived_at, deleted_at
) VALUES (
  'spc_phase0', 'org_phase0', 'Technical Preview', 'preview', 'sparkles',
  'organization', 'usr_phase0_system', 0, 0, NULL, NULL
);

INSERT OR IGNORE INTO space_grants(
  id, organization_id, space_id, principal_type, principal_id,
  role, created_by, created_at
) VALUES (
  'grant_phase0', 'org_phase0', 'spc_phase0', 'organization', 'org_phase0',
  'editor', 'usr_phase0_system', 0
);
