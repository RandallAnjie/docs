PRAGMA foreign_keys = ON;

-- Notion-style unique ID properties are backed by an immutable, monotonically
-- increasing sequence. The number belongs to the row, so changing a property's
-- prefix never changes the numeric identity and deleted numbers are not reused.
ALTER TABLE database_rows ADD COLUMN sequence_number INTEGER;

UPDATE database_rows AS current
   SET sequence_number = (
     SELECT COUNT(*)
       FROM database_rows AS preceding
      WHERE preceding.database_id = current.database_id
        AND preceding.sort_key <= current.sort_key
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_database_rows_sequence
  ON database_rows(database_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS database_counters (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  next_row_sequence INTEGER NOT NULL CHECK (next_row_sequence > 0)
);

INSERT INTO database_counters(database_id, next_row_sequence)
SELECT d.id, COALESCE(MAX(r.sequence_number), 0) + 1
  FROM databases d LEFT JOIN database_rows r ON r.database_id = d.id
 GROUP BY d.id
ON CONFLICT(database_id) DO NOTHING;
