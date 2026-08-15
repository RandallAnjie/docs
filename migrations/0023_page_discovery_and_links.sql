CREATE TABLE page_links (
  source_page_id TEXT NOT NULL,
  target_page_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (source_page_id, target_page_id),
  FOREIGN KEY (source_page_id) REFERENCES pages(id) ON DELETE CASCADE,
  FOREIGN KEY (target_page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX idx_page_links_target
  ON page_links(target_page_id, last_seen_at DESC, source_page_id);

UPDATE pages
SET editor_schema_version = 8
WHERE editor_schema_version < 8;
