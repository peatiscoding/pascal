-- Add recipe_u and result columns to queue (applied to queue.db)
ALTER TABLE ingest_queue ADD COLUMN recipe_u TEXT;
ALTER TABLE ingest_queue ADD COLUMN result TEXT;
