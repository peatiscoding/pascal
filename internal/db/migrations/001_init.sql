-- Scope hierarchy (autocomplete + validation for materialized paths)
CREATE TABLE IF NOT EXISTS scope (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES scope(id),
    UNIQUE(name, parent_id)
);

-- Tags (hierarchical, self-referential)
CREATE TABLE IF NOT EXISTS tag (
    t TEXT PRIMARY KEY,
    p TEXT REFERENCES tag(t),
    d TEXT NOT NULL
);

-- Value type registry (THB, TOKEN, etc.)
CREATE TABLE IF NOT EXISTS master_value (
    k TEXT PRIMARY KEY,
    d TEXT NOT NULL
);

-- Recipe templates
CREATE TABLE IF NOT EXISTS recipe (
    u TEXT PRIMARY KEY,
    d TEXT NOT NULL
);

-- Recipe <-> MasterValue mapping
CREATE TABLE IF NOT EXISTS recipe_values (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    master_key TEXT NOT NULL REFERENCES master_value(k),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, master_key)
);

-- Recipe <-> Tag mapping
CREATE TABLE IF NOT EXISTS recipe_tags (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    tag TEXT NOT NULL REFERENCES tag(t),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, tag)
);

-- Main record
CREATE TABLE IF NOT EXISTS record (
    id BLOB PRIMARY KEY,
    tl TEXT NOT NULL,
    dt TEXT,
    st INTEGER NOT NULL DEFAULT 1,
    ct TEXT NOT NULL DEFAULT (datetime('now')),
    sc TEXT NOT NULL,
    cg TEXT NOT NULL,
    r TEXT REFERENCES recipe(u)
);

-- Record <-> Tag junction
CREATE TABLE IF NOT EXISTS record_tags (
    record_id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    tag TEXT NOT NULL REFERENCES tag(t),
    PRIMARY KEY (record_id, tag)
);

-- Aggregatable values per record (immutable)
CREATE TABLE IF NOT EXISTS record_values (
    id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    k TEXT NOT NULL REFERENCES master_value(k),
    v REAL NOT NULL,
    PRIMARY KEY (id, k)
);

-- Status change audit log
CREATE TABLE IF NOT EXISTS record_log (
    id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    sst INTEGER NOT NULL,
    inf TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scope_parent ON scope(parent_id);
CREATE INDEX IF NOT EXISTS idx_record_ct ON record(ct);
CREATE INDEX IF NOT EXISTS idx_record_cg ON record(cg);
CREATE INDEX IF NOT EXISTS idx_record_st ON record(st);
CREATE INDEX IF NOT EXISTS idx_record_sc ON record(sc);
CREATE INDEX IF NOT EXISTS idx_record_tags_tag ON record_tags(tag);
CREATE INDEX IF NOT EXISTS idx_record_values_k ON record_values(id, k);
CREATE INDEX IF NOT EXISTS idx_record_log_id_at ON record_log(id, at);
