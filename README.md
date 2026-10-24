# PASCAL

> Personal Assistant for Statistics, Context, Actions & Logging

Local-network server for personal event logging and statistics. Collects events, crunches numbers, serves dashboards. Built in Go, stores everything in SQLite.

## Components

1. **API Server** (Go) — HTTP + WebSocket server, serves web UI via `go:embed`
2. **Ingestion** — Three paths (see [ingestion.md](ingestion.md)):
   - **Structured API** — MCP + web UI, direct DB write
   - **Generic Webhooks** — external sources (Gmail, bank alerts), pattern/field_map extract or Ollama fallback
   - **Google Calendar Sync** — push notifications, two-way sync with calendar events
3. **Web Dashboard** — Pure HTML/JS/CSS, real-time updates via WebSocket
4. **Discord Bot** — Separate binary, calls `/api/ingest/text`
5. **Queue Worker** — Goroutine, polls `runtime/queue.db`, runs Ollama inference

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

- `runtime/pascal.db` — all application data (permanent, backed up)
- `runtime/queue.db` — ingestion queue (ephemeral, safe to delete)

### Schema

```sql
-- Scope hierarchy (tag grouping + autocomplete)
CREATE TABLE scope (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES scope(id),
    UNIQUE(name, parent_id)
);

-- Tags (scope-based exclusivity)
CREATE TABLE tag (
    t TEXT PRIMARY KEY,
    s INTEGER REFERENCES scope(id), -- scope group (exclusive per record)
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
    d TEXT NOT NULL,
    default_st INTEGER NOT NULL DEFAULT 1  -- default status for new records
);

-- Recipe ↔ value mappings (MCP reads these to determine required/optional values)
CREATE TABLE recipe_values (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    master_key TEXT NOT NULL REFERENCES master_value(k),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, master_key)
);

-- Recipe ↔ scope mappings (required scopes per recipe)
CREATE TABLE recipe_scopes (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    scope_id INTEGER NOT NULL REFERENCES scope(id),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, scope_id)
);

-- Webhook endpoints (see ingestion.md for processing modes)
CREATE TABLE webhook (
    id TEXT PRIMARY KEY,                        -- slug for URL: /api/webhook/:id
    d TEXT NOT NULL,                             -- description
    secret TEXT NOT NULL,                        -- per-webhook auth token
    pattern TEXT,                                -- regex with named groups (text payloads)
    field_map TEXT,                              -- JSON: JSONPath mappings (JSON payloads)
    recipe_u TEXT REFERENCES recipe(u),          -- optional recipe binding
    active INTEGER NOT NULL DEFAULT 1
);

-- Google Calendar sync config
CREATE TABLE gcal_sync (
    id TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL,
    channel_id TEXT,
    channel_token TEXT,
    resource_id TEXT,
    expiration TEXT,
    scope TEXT NOT NULL,                         -- default scope for synced records
    category TEXT NOT NULL,                      -- default category
    recipe_u TEXT REFERENCES recipe(u),
    active INTEGER NOT NULL DEFAULT 1
);

-- Main record
CREATE TABLE record (
    id BLOB PRIMARY KEY,            -- UUIDv7, 16 bytes
    tl TEXT NOT NULL,               -- title
    dt TEXT,                        -- detail
    st INTEGER NOT NULL DEFAULT 1,  -- 0=paused, 1=todo, 2=doing, 3=done
    ct TEXT NOT NULL DEFAULT (datetime('now')),
    r TEXT REFERENCES recipe(u)     -- nullable
);

-- Record ↔ tag junction (with denormalized scope path)
CREATE TABLE record_tags (
    record_id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
    tag TEXT NOT NULL REFERENCES tag(t),
    scope_path TEXT,                -- materialized path from tag's scope ancestry, NULL if unscoped
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
3. Filter aggregations by tags — `JOIN record_tags`
4. Multi-dimensional grouping — `GROUP BY record_tags.scope_path` (e.g. by payment source, category, etc.)

## API

| Method | Path | Network | Purpose |
|---|---|---|---|
| POST | `/api/webhook/:id` | Public | Generic webhook (pattern/field_map/Ollama) |
| POST | `/api/gcal/push` | Public | Google Calendar push receiver |
| POST | `/api/gcal/setup` | Tailscale | Register calendar watch |
| GET | `/api/gcal/sync/:id` | Tailscale | Manual calendar sync |
| POST | `/api/ingest/text` | Tailscale | Unstructured text → queue → Ollama |
| POST | `/api/records` | Tailscale | Create structured record |
| PATCH | `/api/records/:id` | Tailscale | Update record (status → record_log) |
| GET | `/api/records` | Tailscale | Query with filters |
| GET | `/api/stats` | Tailscale | Aggregations |
| GET | `/api/tags` | Tailscale | Tag tree |
| GET | `/api/recipes` | Tailscale | List recipes |
| GET | `/api/scopes` | Tailscale | Scope tree (autocomplete) |
| WS | `/ws` | Tailscale | Real-time events |

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
├── migrations/
│   ├── main/              # pascal.db migrations (go:embed)
│   └── queue/             # queue.db migrations (go:embed)
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
