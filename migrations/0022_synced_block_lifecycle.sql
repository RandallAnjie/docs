ALTER TABLE synced_blocks
ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
CHECK (lifecycle_state IN ('active', 'unsyncing'));

CREATE INDEX idx_synced_blocks_lifecycle
  ON synced_blocks(lifecycle_state, deleted_at, updated_at DESC);
