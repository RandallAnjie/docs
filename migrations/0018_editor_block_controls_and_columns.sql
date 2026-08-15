-- Editor schema v4 adds collaborative multi-column containers. Block drag,
-- transform, duplicate, move, and delete operations use existing Yjs nodes.
UPDATE pages
SET editor_schema_version = 4
WHERE editor_schema_version < 4;
