-- Editor schema v5 adds private file, audio, and video attachment nodes.
-- Attachment storage and ACLs continue to use the existing attachment tables.
UPDATE pages
SET editor_schema_version = 5
WHERE editor_schema_version < 5;
