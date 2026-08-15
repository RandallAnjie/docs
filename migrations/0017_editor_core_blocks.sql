-- Editor schema v3 adds persisted collaborative nodes for callouts, toggles,
-- bookmarks, embeds, formulae, and live table-of-contents blocks.
UPDATE pages
SET editor_schema_version = 3
WHERE editor_schema_version < 3;
