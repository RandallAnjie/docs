-- Preserve one recoverable cascade-delete operation on a synced block.
-- The page references table continues to identify every affected page while
-- their document contains a deletedSyncedBlock placeholder.
ALTER TABLE synced_blocks
ADD COLUMN deletion_operation_id TEXT;

ALTER TABLE synced_blocks
ADD COLUMN deletion_expires_at INTEGER;

ALTER TABLE synced_blocks
ADD COLUMN deletion_restore_lease_at INTEGER;

CREATE UNIQUE INDEX idx_synced_blocks_deletion_operation
  ON synced_blocks(deletion_operation_id)
  WHERE deletion_operation_id IS NOT NULL;

CREATE INDEX idx_synced_blocks_deletion_expiry
  ON synced_blocks(deletion_expires_at, deleted_at)
  WHERE deletion_operation_id IS NOT NULL;

UPDATE pages
SET editor_schema_version = 9
WHERE editor_schema_version < 9;
