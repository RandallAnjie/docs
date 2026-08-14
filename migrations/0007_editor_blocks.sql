-- Rdocs editor schema v2 adds task-list and table nodes. Existing Yjs documents
-- remain compatible; this records the schema understood by the current client.
UPDATE pages SET editor_schema_version = 2 WHERE editor_schema_version < 2;
