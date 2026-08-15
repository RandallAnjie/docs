PRAGMA foreign_keys = ON;

-- A database is a structured data source owned by a regular Rdocs page. The
-- backing page is the single authorization boundary for schema and view access.
CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_databases_organization
  ON databases(organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_properties (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'title', 'text', 'number', 'select', 'status', 'multi_select', 'date',
    'formula', 'relation', 'rollup', 'person', 'files', 'checkbox', 'url',
    'email', 'phone', 'created_time', 'created_by', 'last_edited_time',
    'last_edited_by', 'button', 'unique_id', 'place'
  )),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  sort_order INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (database_id, name),
  UNIQUE (database_id, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_database_properties_database
  ON database_properties(database_id, sort_order);

-- Every structured row has a normal page. Opening a row therefore uses the
-- same editor, collaboration, comments, history and inherited ACL as any page.
CREATE TABLE IF NOT EXISTS database_rows (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (database_id, sort_key)
);
CREATE INDEX IF NOT EXISTS idx_database_rows_database
  ON database_rows(database_id, archived_at, sort_key);

CREATE TABLE IF NOT EXISTS database_cells (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (row_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_database_cells_property
  ON database_cells(database_id, property_id, row_id);

CREATE TABLE IF NOT EXISTS database_views (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'table', 'board', 'timeline', 'calendar', 'list', 'gallery', 'chart',
    'dashboard', 'form', 'feed', 'map'
  )),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  sort_order INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (database_id, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_database_views_database
  ON database_views(database_id, sort_order);

CREATE TABLE IF NOT EXISTS database_relation_edges (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  source_row_id TEXT NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
  source_property_id TEXT NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  target_database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  target_row_id TEXT NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_row_id, source_property_id, target_row_id)
);
CREATE INDEX IF NOT EXISTS idx_database_relation_edges_target
  ON database_relation_edges(target_database_id, target_row_id);

