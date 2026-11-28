-- Notion tree imports: one job per run, and a queue of Notion pages,
-- databases, row batches and row bodies processed a few at a time.
CREATE TABLE IF NOT EXISTS notion_import_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notion_import_jobs_org ON notion_import_jobs(organization_id, created_at);

CREATE TABLE IF NOT EXISTS notion_import_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES notion_import_jobs(id) ON DELETE CASCADE,
  notion_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  parent_page_id TEXT,
  page_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state_json TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notion_import_items_queue ON notion_import_items(job_id, status, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notion_import_items_once ON notion_import_items(job_id, kind, notion_id);
