-- Rate-limited or temporarily failing import items wait and try again.
ALTER TABLE notion_import_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notion_import_items ADD COLUMN retry_at INTEGER;
