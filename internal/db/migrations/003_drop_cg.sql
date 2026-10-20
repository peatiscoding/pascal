-- Remove category column from record (now derived from tags).
-- SQLite 3.35+ supports ALTER TABLE DROP COLUMN.
ALTER TABLE record DROP COLUMN cg;
DROP INDEX IF EXISTS idx_record_cg;
