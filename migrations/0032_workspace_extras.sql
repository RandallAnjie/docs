PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_templates_org
  ON workspace_templates(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_skills (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_workspace_skills_org
  ON workspace_skills(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email_mentions INTEGER NOT NULL DEFAULT 1 CHECK (email_mentions IN (0, 1)),
  email_reminders INTEGER NOT NULL DEFAULT 1 CHECK (email_reminders IN (0, 1)),
  email_digest INTEGER NOT NULL DEFAULT 0 CHECK (email_digest IN (0, 1)),
  digest_hour INTEGER NOT NULL DEFAULT 9 CHECK (digest_hour >= 0 AND digest_hour <= 23),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS database_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id),
  source_database_id TEXT NOT NULL REFERENCES databases(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_database_links_source
  ON database_links(source_database_id, created_at DESC);
