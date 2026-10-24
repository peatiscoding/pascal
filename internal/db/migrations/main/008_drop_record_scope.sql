-- Move scope from record to record_tags as materialized path
ALTER TABLE record_tags ADD COLUMN scope_path TEXT;

-- Backfill: scoped tags get record's current sc value
UPDATE record_tags SET scope_path = (
    SELECT r.sc FROM record r WHERE r.id = record_tags.record_id
) WHERE EXISTS (
    SELECT 1 FROM tag t WHERE t.t = record_tags.tag AND t.s IS NOT NULL
);

-- Drop scope from record (index first, SQLite validates index refs during DROP COLUMN)
DROP INDEX IF EXISTS idx_record_sc;
ALTER TABLE record DROP COLUMN sc;

-- Index for scope_path queries
CREATE INDEX idx_record_tags_scope_path ON record_tags(scope_path);
