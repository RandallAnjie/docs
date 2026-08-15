PRAGMA foreign_keys = ON;

ALTER TABLE page_reminders
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'page'
  CHECK (source_type IN ('page', 'inline', 'database_date'));

ALTER TABLE page_reminders
  ADD COLUMN source_id TEXT;

CREATE UNIQUE INDEX idx_page_reminders_active_source
  ON page_reminders(created_by, source_type, source_id)
  WHERE status = 'scheduled' AND source_id IS NOT NULL;

CREATE INDEX idx_page_reminders_source
  ON page_reminders(page_id, source_type, source_id, status);

UPDATE pages
  SET editor_schema_version = 10
  WHERE editor_schema_version < 10;
