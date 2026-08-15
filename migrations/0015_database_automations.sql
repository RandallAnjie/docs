PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS database_automations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'row_created', 'row_updated', 'property_changed', 'form_submitted', 'manual'
  )),
  trigger_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trigger_config_json)),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'set_property', 'toggle_checkbox', 'increment_number', 'archive_row', 'webhook'
  )),
  action_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action_config_json)),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (database_id, name)
);
CREATE INDEX IF NOT EXISTS idx_database_automations_trigger
  ON database_automations(database_id, enabled, trigger_type);

CREATE TABLE IF NOT EXISTS database_automation_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES database_automations(id) ON DELETE CASCADE,
  row_id TEXT REFERENCES database_rows(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  response_code INTEGER,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (automation_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_database_automation_runs_database
  ON database_automation_runs(database_id, started_at DESC);
