-- Remove category column from record (now derived from tags).
DROP INDEX IF EXISTS idx_record_cg;
ALTER TABLE record DROP COLUMN cg;
