PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS database_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  values_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(values_json)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (database_id, name)
);
CREATE INDEX IF NOT EXISTS idx_database_templates_database
  ON database_templates(database_id, is_default DESC, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_database_templates_one_default
  ON database_templates(database_id) WHERE is_default = 1;
