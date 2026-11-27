PRAGMA foreign_keys = ON;

-- Automations become trigger → conditions → actions definitions (stored in
-- trigger_config_json.definition). Trigger and action types are validated by
-- the application, so the table no longer pins them with CHECK constraints.
-- Runs reference automations with ON DELETE CASCADE, so both tables are
-- rebuilt together to keep the run history.

CREATE TABLE database_automations_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  trigger_type TEXT NOT NULL,
  trigger_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trigger_config_json)),
  action_type TEXT NOT NULL,
  action_config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action_config_json)),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (database_id, name)
);

INSERT INTO database_automations_next(
  id, organization_id, database_id, name, enabled, trigger_type, trigger_config_json,
  action_type, action_config_json, created_by, updated_by, created_at, updated_at
)
SELECT id, organization_id, database_id, name, enabled, trigger_type, trigger_config_json,
       action_type, action_config_json, created_by, updated_by, created_at, updated_at
  FROM database_automations;

CREATE TABLE database_automation_runs_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES database_automations_next(id) ON DELETE CASCADE,
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

INSERT INTO database_automation_runs_next(
  id, organization_id, database_id, automation_id, row_id, event_key, trigger_type,
  status, attempt, response_code, error_message, started_at, completed_at
)
SELECT id, organization_id, database_id, automation_id, row_id, event_key, trigger_type,
       status, attempt, response_code, error_message, started_at, completed_at
  FROM database_automation_runs;

DROP TABLE database_automation_runs;
DROP TABLE database_automations;
ALTER TABLE database_automations_next RENAME TO database_automations;
ALTER TABLE database_automation_runs_next RENAME TO database_automation_runs;

CREATE INDEX IF NOT EXISTS idx_database_automations_trigger
  ON database_automations(database_id, enabled, trigger_type);
CREATE INDEX IF NOT EXISTS idx_database_automation_runs_database
  ON database_automation_runs(database_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_automation
  ON scheduled_jobs(kind, status, json_extract(payload_json, '$.automationId'));
