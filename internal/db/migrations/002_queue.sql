-- Queue schema (applied to queue.db, not pascal.db)
CREATE TABLE IF NOT EXISTS ingest_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON ingest_queue(status, created_at);
