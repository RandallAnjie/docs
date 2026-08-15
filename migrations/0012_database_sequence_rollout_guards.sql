PRAGMA foreign_keys = ON;

-- Keep sequence allocation correct during a rolling deployment where an older
-- Worker may briefly write against the expanded schema.
INSERT INTO database_counters(database_id, next_row_sequence)
SELECT d.id, COALESCE(MAX(r.sequence_number), 0) + 1
  FROM databases d LEFT JOIN database_rows r ON r.database_id = d.id
 GROUP BY d.id
ON CONFLICT(database_id) DO UPDATE SET
  next_row_sequence = MAX(database_counters.next_row_sequence, excluded.next_row_sequence);

UPDATE database_rows AS current
   SET sequence_number = (
     SELECT COUNT(*)
       FROM database_rows AS preceding
      WHERE preceding.database_id = current.database_id
        AND preceding.sort_key <= current.sort_key
   )
 WHERE sequence_number IS NULL;

UPDATE database_counters
   SET next_row_sequence = COALESCE(
     (SELECT MAX(sequence_number) + 1
        FROM database_rows
       WHERE database_id = database_counters.database_id),
     1
   );

CREATE TRIGGER IF NOT EXISTS database_counter_after_insert
AFTER INSERT ON databases
BEGIN
  INSERT INTO database_counters(database_id, next_row_sequence)
  VALUES (NEW.id, 1)
  ON CONFLICT(database_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS database_row_sequence_after_insert
AFTER INSERT ON database_rows
WHEN NEW.sequence_number IS NULL
BEGIN
  UPDATE database_rows
     SET sequence_number = (
       SELECT next_row_sequence FROM database_counters WHERE database_id = NEW.database_id
     )
   WHERE id = NEW.id;
  UPDATE database_counters
     SET next_row_sequence = next_row_sequence + 1
   WHERE database_id = NEW.database_id;
END;
