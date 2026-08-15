-- Cross-page synced blocks use independent DocumentRoom instances while
-- retaining source-page and destination-page authorization.
CREATE TABLE synced_blocks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  source_page_id TEXT NOT NULL,
  current_generation INTEGER NOT NULL DEFAULT 1 CHECK (current_generation >= 1),
  editor_schema_version INTEGER NOT NULL,
  acl_version INTEGER NOT NULL DEFAULT 1 CHECK (acl_version >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_page_id) REFERENCES pages(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX idx_synced_blocks_source
  ON synced_blocks(source_page_id, deleted_at, updated_at DESC);

CREATE TABLE synced_block_references (
  synced_block_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (synced_block_id, page_id),
  FOREIGN KEY (synced_block_id) REFERENCES synced_blocks(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX idx_synced_block_references_page
  ON synced_block_references(page_id, synced_block_id);

UPDATE pages
SET editor_schema_version = 7
WHERE editor_schema_version < 7;
