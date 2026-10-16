# PASCAL

> Personal Assistant for Statistics, Context, Actions & Logging

Local-network server for personal event logging and statistics. Collects events, crunches numbers, serves dashboards. Built in Go, stores everything in SQLite.

## Components

1. **API Server** (Go) — HTTP + WebSocket server, serves web UI via `go:embed`
2. **Ingestion** — Two paths:
   - **Structured API** — used by MCP interface and web UI, writes directly to DB
   - **Unstructured API** — used by Discord bot and other bots, queued and processed via Ollama
3. **Web Dashboard** — Pure HTML/JS/CSS, real-time updates via WebSocket
4. **Discord Bot** — Separate binary, communicates via ingestion API. `@pascal` to create records
5. **Queue Worker** — Goroutine in server process, polls `queue.db`, runs Ollama inference

## Tech Stack

| Component | Choice |
|---|---|
| Language | Go |
| Database | SQLite (`modernc.org/sqlite`, pure Go) |
| Router | `net/http` + `chi` |
| WebSocket | `nhooyr.io/websocket` |
| Discord | `discordgo` |
| LLM | Ollama (local, configurable model) |
| Frontend | Pure HTML/JS/CSS |

## Database

Two SQLite files:

- `pascal.db` — all application data (permanent, backed up)
- `queue.db` — ingestion queue (ephemeral, safe to delete)

### Schema

```sql
-- Scope hierarchy (autocomplete + validation for materialized paths)
CREATE TABLE scope (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES scope(id),
    UNIQUE(name, parent_id)
);

-- Tags (hierarchical, self-referential)
CREATE TABLE tag (
    t TEXT PRIMARY KEY,
    p TEXT REFERENCES tag(t),
    d TEXT NOT NULL
);

-- Value type registry
CREATE TABLE master_value (
    k TEXT PRIMARY KEY,
    d TEXT NOT NULL
);

-- Recipe templates
CREATE TABLE recipe (
    u TEXT PRIMARY KEY,
    d TEXT NOT NULL
);

-- Recipe ↔ value mappings (MCP reads these to determine required/optional values)
CREATE TABLE recipe_values (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    master_key TEXT NOT NULL REFERENCES master_value(k),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, master_key)
);

-- Recipe ↔ tag mappings (MCP reads these to determine required/optional tags)
CREATE TABLE recipe_tags (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    tag TEXT NOT NULL REFERENCES tag(t),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, tag)
);

-- Main record
CREATE TABLE record (
    id BLOB PRIMARY KEY,            -- UUIDv7, 16 bytes
    tl TEXT NOT NULL,               -- title
    dt TEXT,                        -- detail
    st INTEGER NOT NULL DEFAULT 1,  -- 0=paused, 1=todo, 2=doing, 3=done
    ct TEXT NOT NULL DEFAULT (datetime('now')),
    sc TEXT NOT NULL,               -- scope (materialized path, pipe-delimited)
    cg TEXT NOT NULL,               -- category
    r TEXT REFERENCES recipe(u)     -- nullable
);

-- Record ↔ tag junction
CREATE TABLE record_tags (
    record_id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    tag TEXT NOT NULL REFERENCES tag(t),
    PRIMARY KEY (record_id, tag)
);

-- Aggregatable values (immutable, set once per record)
CREATE TABLE record_values (
    id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    k TEXT NOT NULL REFERENCES master_value(k),
    v REAL NOT NULL,
    PRIMARY KEY (id, k)
);

-- Status change audit log
CREATE TABLE record_log (
    id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    sst INTEGER NOT NULL,
    inf TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Expected Use Cases

1. Count events over a period — `GROUP BY strftime(ct)`
2. Aggregate values (sum/min/max/avg) over a period — `JOIN record_values`
3. Filter aggregations by tags/category — `JOIN record_tags`
4. Distinct dimension breakdown (pie chart) — `GROUP BY cg`

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ingest/text` | Unstructured text → queue → Ollama → record |
| POST | `/api/records` | Create structured record |
| PATCH | `/api/records/:id` | Update record (status → record_log) |
| GET | `/api/records` | Query with filters |
| GET | `/api/stats` | Aggregations |
| GET | `/api/tags` | Tag tree |
| GET | `/api/recipes` | List recipes |
| GET | `/api/scopes` | Scope tree (autocomplete) |
| WS | `/ws` | Real-time events |

## Project Structure

```
pascal/
├── cmd/
│   ├── server/main.go       # API server + queue worker
│   └── bot/main.go          # Discord bot (separate binary)
├── internal/
│   ├── db/                  # Database layer
│   ├── api/                 # HTTP handlers
│   ├── worker/              # Queue worker + Ollama
│   ├── ollama/              # Ollama HTTP client
│   └── ws/                  # WebSocket hub
├── migrations/              # SQL migrations (go:embed)
├── web/                     # Static frontend (go:embed)
├── go.mod
└── Makefile
```

## Development

```bash
# Build
make build

# Run server
./pascal-server

# Run Discord bot
DISCORD_TOKEN=... ./pascal-bot

# Run both
make run
```
