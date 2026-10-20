-- Change tag.p from self-referential to scope reference.
-- Tags under same scope are exclusive (one per record per scope).
CREATE TABLE IF NOT EXISTS tag_new (
    t TEXT PRIMARY KEY,
    s INTEGER REFERENCES scope(id),
    d TEXT NOT NULL
);
INSERT OR IGNORE INTO tag_new (t, s, d) SELECT t, NULL, d FROM tag;
DROP TABLE IF EXISTS tag;
ALTER TABLE tag_new RENAME TO tag;
