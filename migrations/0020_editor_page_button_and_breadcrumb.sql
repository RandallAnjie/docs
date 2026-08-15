-- Editor schema v6 adds dynamic breadcrumbs and configurable page buttons.
UPDATE pages
SET editor_schema_version = 6
WHERE editor_schema_version < 6;
