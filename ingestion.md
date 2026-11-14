# PASCAL — Ingestion Design

Three ingestion paths into `runtime/pascal.db`. Each optimized for different source types.

## Overview

```mermaid
flowchart TB
    subgraph Discord["Discord (external)"]
        User[Discord User]
    end

    subgraph BotProcess["Bot Process (cmd/bot :7602)"]
        MsgHandler[Message Handler]
        ThreadMap["Thread Map\nqueue_id ↔ thread_id\n(in-memory)"]
        WSClient[WebSocket Client]
        BotHTTP[HTTP Client]
    end

    subgraph ServerProcess["Server Process (cmd/server :7600)"]
        subgraph API["HTTP API"]
            subgraph Ingest["/api/ingest/*"]
                IngestRecord["/ingest/record"]
                IngestText["/ingest/text"]
                IngestGCal["/ingest/gcal"]
            end
            WebhookAPI["/api/ingest/webhook/:id"]
        end

        subgraph Worker["Queue Worker (goroutine)"]
            Poll[Poll 500ms]
            RecipeMatch[Recipe Match\nvia Ollama]
            DirectCreate[Direct Create\nno LLM]
            PartialExtract[Partial Extract\nvia Ollama]
            Summarize[Summarize\nvia Ollama]
        end

        DirectWrite[Direct Write]
        CalFetch[Calendar API\nevents.get]
        WSHub[WebSocket Hub]
    end

    subgraph External["External Sources"]
        MCP[MCP Client]
        WebUI[Web UI]
        Raycast[Raycast Scripts]
        Gmail[Gmail Filter]
        Bank[Bank API]
        Scripts[Custom Scripts]
        GCal[Google Calendar]
    end

    Ollama[Ollama LLM\nqwen2.5:7b]
    QueueDB[(runtime/queue.db)]
    PascalDB[(runtime/pascal.db)]

    %% Discord Bot → Queue → Worker flow
    User -->|"@pascal text"| MsgHandler
    MsgHandler -->|POST text, source| IngestText
    IngestText --> QueueDB
    IngestText -->|queue_id| BotHTTP
    BotHTTP -->|create thread| MsgHandler
    MsgHandler -->|store mapping| ThreadMap

    QueueDB --> Poll
    Poll -->|no recipe_u| RecipeMatch
    RecipeMatch --> Ollama
    Poll -->|"short + complete hints"| DirectCreate
    Poll -->|"short + missing fields"| PartialExtract
    Poll -->|"long text ≥250"| Summarize
    PartialExtract --> Ollama
    Summarize --> Ollama

    %% Worker push updates via WebSocket
    RecipeMatch -->|"ambiguous"| WSHub
    PartialExtract -->|"needs_input/done"| WSHub
    Summarize -->|"needs_input/done"| WSHub
    DirectCreate -->|complete| DirectWrite
    PartialExtract -->|complete| DirectWrite
    Summarize -->|complete| DirectWrite

    WSHub -->|queue update events| WSClient
    WSClient --> ThreadMap
    ThreadMap -->|render message| MsgHandler
    MsgHandler -->|ask in thread| User

    %% User reply → re-queue with recipe_u
    User -->|reply in thread| MsgHandler
    MsgHandler -->|POST text + recipe_u| IngestText

    %% Structured sources (bypass queue)
    MCP --> IngestRecord
    WebUI --> IngestRecord
    Raycast -->|"Pascal Record"| IngestRecord
    Raycast -->|"Pascal Log"| IngestText
    IngestRecord --> DirectWrite

    %% Webhook sources
    Gmail --> WebhookAPI
    Bank --> WebhookAPI
    Scripts --> WebhookAPI
    WebhookAPI -->|has pattern/field_map| DirectWrite
    WebhookAPI -->|no pattern| QueueDB

    %% Google Calendar
    GCal -->|push notification| IngestGCal
    IngestGCal --> CalFetch
    CalFetch --> DirectWrite

    %% Write path
    DirectWrite --> PascalDB
    PascalDB -.-> WSHub
```

## Path 1: Structured Record

Direct record creation with validated fields.

**Endpoint:** `POST /api/ingest/record` (also available at `POST /api/records`)

**Used by:** MCP interface, Web UI, bot (after queue completes extraction)

**Flow:** Validate → generate UUIDv7 → insert record + tags + values → record_log → WS broadcast

**Response:** `201` with created record.

No queue, no inference. Caller provides complete structured data.

## Path 2: Generic Webhook

Configurable endpoints for external data sources.

**Endpoint:** `POST /api/ingest/webhook/:id`

**Network:** Public (VPS)

**Auth:** `X-Webhook-Secret` header matched against `webhook.secret`

### Schema

```sql
CREATE TABLE webhook (
    id TEXT PRIMARY KEY,              -- slug for URL path
    d TEXT NOT NULL,                   -- description
    secret TEXT NOT NULL,              -- per-webhook auth token
    pattern TEXT,                      -- regex with named groups (for text payloads)
    field_map TEXT,                    -- JSON: maps JSONPath to record fields (for JSON payloads)
    recipe_u TEXT REFERENCES recipe(u), -- optional recipe binding
    active INTEGER NOT NULL DEFAULT 1
);
```

### Three Processing Modes

#### A. Text + Pattern (regex extraction)

For patterned text payloads (email subjects, SMS, plain alerts).

**Request:**
```json
{ "text": "Purchase 450.00 THB at 7-Eleven" }
```

**Pattern:** Go regex with named groups. Named groups map to record fields:

| Named Group | Maps To |
|---|---|
| `(?P<title>...)` | `record.tl` |
| `(?P<detail>...)` | `record.dt` |
| `(?P<scope>...)` | `record.sc` |
| `(?P<category>...)` | `record.cg` |
| Any other name | Matched against `recipe_values.master_key` for numeric values |

**Example webhook:**
```
id:        "cc_kbank"
d:         "KBank credit card transaction"
secret:    "random-token"
pattern:   "(?P<title>.+?) (?P<amount>[\\d,.]+) THB"
recipe_u:  "cc_spend"
```

**Response:** `201` (direct write)

**Pattern match failure:** `422` — deterministic path stays deterministic. Fix pattern, don't fall back to LLM.

#### B. JSON + Field Map (structured extraction)

For JSON payloads from APIs (bank open API, IoT, health trackers).

**Request:**
```json
{
    "transaction": {
        "description": "7-Eleven",
        "amount": 450.00,
        "category": "food"
    }
}
```

**Field map format:**
```json
{
    "tl": "$.transaction.description",
    "cg": "$.transaction.category",
    "values": {
        "THB": "$.transaction.amount"
    }
}
```

Maps JSONPath expressions to record fields. Recipe binding fills in defaults (scope, required tags).

**Response:** `201` (direct write)

#### C. No Pattern, No Field Map (Ollama fallback)

Raw text → queue → Ollama inference.

**Request:**
```json
{ "text": "spent 200 baht on lunch at MK" }
```

If recipe bound: include recipe context (description, required values/tags) in Ollama prompt for better inference.

**Response:** `202` (queued)

### Summary

| Pattern | Field Map | Recipe | Behavior | Response |
|---|---|---|---|---|
| Yes | — | Optional | Regex extract → direct write | 201 |
| — | Yes | Optional | JSONPath extract → direct write | 201 |
| No | No | Yes | Queue to Ollama with recipe hint | 202 |
| No | No | No | Queue to Ollama, plain | 202 |

## Path 3: Google Calendar Sync

Separate from generic webhooks. Google Calendar push notifications are *sync triggers*, not data delivery — payload is nearly empty, you must fetch event details via API callback.

**Network:** Push endpoint public (VPS), setup/management endpoints Tailscale only.

**Auth:** OAuth2 for Calendar API access. Channel token for push verification.

### Schema

```sql
CREATE TABLE gcal_sync (
    id TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL,          -- Google Calendar ID
    channel_id TEXT,                    -- watch channel ID (set after watch setup)
    channel_token TEXT,                 -- verification token
    resource_id TEXT,                   -- Google resource ID
    expiration TEXT,                    -- watch expiration (needs periodic renewal)
    scope TEXT NOT NULL,                -- default scope for synced records
    category TEXT NOT NULL,             -- default category
    recipe_u TEXT REFERENCES recipe(u),
    active INTEGER NOT NULL DEFAULT 1
);
```

### Endpoints

| Method | Path | Network | Purpose |
|---|---|---|---|
| POST | `/api/ingest/gcal` | Public | Receive push notification from Google |
| POST | `/api/gcal/setup` | Tailscale | Register watch channel on a calendar |
| GET | `/api/gcal/sync/:id` | Tailscale | Manual trigger full sync |

### Push Flow

```mermaid
flowchart TD
    Google[Google Calendar] -->|POST with headers only| Push["/api/ingest/gcal"]
    Push --> Verify{Verify channel_token}
    Verify -->|fail| R401[401]
    Verify -->|pass| Lookup[Lookup gcal_sync by channel_id]
    Lookup --> Fetch[Calendar API: events.get/list]
    Fetch --> State{Resource state?}
    State -->|created| Create[Create record\nscope + category from gcal_sync defaults]
    State -->|updated| Update[Update record\ntitle, time, status]
    State -->|deleted/cancelled| Done[Set record status → done]
    Create --> PascalDB[(runtime/pascal.db)]
    Update --> PascalDB
    Done --> PascalDB
    PascalDB -.-> WS[WebSocket broadcast]
```

### Push Notification Headers

Google sends these headers (no meaningful body):

| Header | Purpose |
|---|---|
| `X-Goog-Channel-ID` | Channel ID (matches `gcal_sync.channel_id`) |
| `X-Goog-Resource-ID` | Resource being watched |
| `X-Goog-Resource-State` | `sync`, `exists`, or `not_exists` |
| `X-Goog-Channel-Token` | Verification token |

### Watch Renewal

Google Calendar watch channels expire (~7 days). Server needs periodic renewal:
- Goroutine checks `gcal_sync.expiration` daily
- Re-registers watch before expiry
- Updates `channel_id`, `resource_id`, `expiration`

### Calendar Event → Record Mapping

| Calendar Event Field | Record Field |
|---|---|
| `summary` | `record.tl` |
| `description` | `record.dt` |
| `start.dateTime` | `record.ct` |
| Event status `confirmed` | `record.st = 1` (todo) |
| Event status `cancelled` | `record.st = 3` (done) |
| Scope, category | From `gcal_sync` defaults |
| Recurring event | Each occurrence → separate record |

### vs Generic Webhook

| | Generic Webhook | Google Calendar Push |
|---|---|---|
| Data in payload | Yes | No (headers only) |
| Needs API callback | No | Yes (fetch event) |
| Auth | Shared secret | Channel token + OAuth2 |
| Watch expiration | N/A | ~7 days, needs renewal |
| OAuth | No | Yes |

## Unstructured Ingestion Queue

Shared by Discord bot (`/api/ingest/text`), and pattern-less webhooks. The queue is the central orchestrator for all unstructured text — it handles recipe matching, field extraction, and communicates back to callers via WebSocket.

### Queue Schema (runtime/queue.db — separate file)

```sql
CREATE TABLE ingest_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    source TEXT NOT NULL,              -- 'discord', 'webhook:cc_kbank', 'api', etc.
    recipe_u TEXT,                     -- resolved recipe (NULL = needs matching, set = skip to extract)
    hint_tags TEXT,                    -- JSON string[]: pre-selected tags from caller (e.g. ["payment-source:cash"])
    hint_values TEXT,                  -- JSON object[]: pre-selected values from caller (e.g. [{"k":"THB","v":200}])
    result TEXT,                       -- JSON: worker output (extracted fields, matched recipes, error detail)
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
);

CREATE INDEX idx_queue_status ON ingest_queue(status, created_at);
```

### Ingest API

**Endpoint:** `POST /api/ingest/text`

```json
{
    "text": "Lunch at MK",
    "source": "discord",
    "recipe_u": "expense",
    "hint_tags": ["payment-source:cash"],
    "hint_values": [{"k": "THB", "v": 200}]
}
```

- `recipe_u` optional. If set, worker skips recipe matching and goes straight to extraction.
- `hint_tags` optional. Pre-selected tags from frontend (e.g. `#scope:tag` tokens). Merged into result, guaranteed to survive LLM extraction.
- `hint_values` optional. Pre-selected values from frontend (e.g. `@THB(200)` tokens). Merged into result, override LLM-extracted values on key conflict.
- Returns `202` with `{"queue_id": 42}`.
- Caller (e.g. bot) uses `queue_id` to track progress via WebSocket.

### Worker Logic — Unified 3-Phase Pipeline

Single goroutine, polls every 500ms. Every message flows through the same pipeline:

```
Phase 1: EXTRACT — resolve recipe + required values/tags
Phase 2: TITLE  — strip essentials, replace annotations, summarize
Phase 3: DESC   — replace all annotations, generate description
```

#### Phase 1: Extract Essential Components

```
pick next pending item from queue

1a. RESOLVE RECIPE
    if recipe_u is NULL:
        → classify text against all recipes via Ollama
        → 0 matches: proceed without recipe
        → 1 match:  use as recipe_u
        → N matches: set status "ambiguous", push WS event, STOP

1b. BUILD EXTRACTED STATE
    - Parse hint_tags / hint_values from queue item
    - Load recipe requirements (recipe_values, recipe_scopes)
    - Populate state from hints
    - Mark each value/tag as "essential" if required by recipe at target status
    - Find missing required fields

1c. LLM EXTRACT (conditional)
    if missing fields exist:
        → Ollama prompt: extract ONLY the missing tags/values
        → Merge LLM result with hints (hints take precedence)
        → Re-check missing after merge
    if still missing → set "needs_input", push WS event, STOP
```

**Essential** = required by recipe at target status. Essential fields are displayed separately in the UI listing view, so they're redundant in the title.

Intermediate state after Phase 1:

```json
{
    "input": "<raw annotated text>",
    "recipe": "<recipe object>",
    "status": 3,
    "values": {
        "THB": { "essential": true, "v": 200 }
    },
    "tags": {
        "payment-source": { "essential": true, "tags": ["cash"] }
    },
    "free_tags": ["coffee"],
    "missing": []
}
```

#### Phase 2: Summarize Title

1. Start with raw input text
2. **Strip essential annotations** — remove `@key(v)` where key is essential, remove `#scope:tag` where scope is essential
3. **Replace remaining annotations with readable text:**
   - `@spent(30)` → `"spent 30"`
   - `#payment-source:prime` → `"SCB Prime"` (use `tag.d` if non-empty, else slug)
   - `#:cslp` → `"cslp"` (bare tag slug)
4. If ≤5 words → use as-is, skip LLM
5. If >5 words → LLM: "Summarize into short title (max 80 chars)"
6. If ≥250 chars → always LLM summarize

**Example:**
```
Raw:    "paid @THB(30) for coffee at #:cslp #:coffee #payment-source:prime"
Recipe: expense (requires THB, payment-source)
Essential: THB, payment-source

After strip essential: "paid for coffee at #:cslp #:coffee"
After replace:         "paid for coffee at cslp coffee"
≤5 words? No (6 words) → LLM summarize
Title:                 "Coffee at CSLP"
```

#### Phase 3: Generate Description

1. Start with raw input text
2. **Keep essentials** — do NOT strip them
3. **Replace ALL annotations** with readable text (same rules as title)
4. Short text → use as-is (no LLM)
5. Long text (≥250 chars) → store original as `record.dt`

**Example:**
```
Raw:    "paid @THB(30) for coffee at #:cslp #:coffee #payment-source:prime"
After replace all: "paid THB 30 for coffee at cslp coffee SCB Prime"
Short → use as-is
```

#### Finalize

1. Strip scope prefixes from tags (`payment-source:cash` → `cash`)
2. Check recipe required fields against final result
3. If complete → create record, mark done, WS broadcast
4. If still missing → set `needs_input`, WS broadcast, wait for user

### Queue Statuses

| Status | Meaning | Next action |
|---|---|---|
| `pending` | Waiting for worker | Worker picks up |
| `processing` | Worker is handling | — |
| `ambiguous` | Multiple recipe matches | Caller re-queues with chosen `recipe_u` |
| `needs_input` | Missing required fields | Caller re-queues with additional text + `recipe_u` |
| `done` | Record created | Terminal |
| `failed` | Unrecoverable error (3 retries or no match) | Terminal |

### WebSocket Events

Worker pushes queue status updates through the existing WebSocket hub. Events:

| Event type | Payload | Meaning |
|---|---|---|
| `queue:ambiguous` | `{id, matches: ["recipe_a", "recipe_b"]}` | Multiple recipes matched, pick one |
| `queue:needs_input` | `{id, missing: ["field"], partial: {...}}` | Extraction incomplete, need more info |
| `queue:done` | `{id, record: {...}}` | Record created successfully |
| `queue:no_match` | `{id}` | No recipe matched |
| `queue:failed` | `{id, error: "..."}` | Processing failed |

### Worker Rules

- Single goroutine, polls every 500ms
- Backpressure: reject `429` if pending count > 1000
- 3 retry attempts for transient errors (Ollama timeout, etc.), then mark `failed`
- `ambiguous` and `needs_input` are NOT retried — they wait for caller input
- Separate DB file (`runtime/queue.db`): ephemeral, no WAL contention with main DB, `rm runtime/queue.db` to reset

### Ollama Prompt Strategy

Up to 3 conditional LLM calls per message, each narrowly scoped.

**1. Recipe matching** (conditional: no `recipe_u`):
```
You are a classifier. Given user text and available recipes, return which recipe(s) match.

Available recipes:
- expense: Track daily expenses with amount and payment method
- meal_log: Log meals with calories and ingredients
...

Return JSON: {"matches": ["recipe_usecase"]}
Return empty matches if none fit.

User text: {payload}
```

**2. Missing field extraction** (conditional: required fields not in hints):
```
You are a data extraction assistant. Extract ONLY the specifically requested fields.

Recipe: expense — Track daily expenses with amount and payment method

Extract ONLY the following missing fields from the text:
- Tag from scope 'payment-source' — choices: cash, card, prompt-pay
- Value: THB (Thai Baht amount) (number)

Return JSON only with these fields:
- tags (string[]): tag names ONLY for the requested scopes
- values (object[]): each with "k" and "v" — only for requested values
- missing (string[]): list any requested fields you could NOT find

User text: {payload}
```

**3. Title summarization** (conditional: cleaned text >5 words or ≥250 chars):
```
Summarize the following text into a short title (max 80 chars).
Return JSON only: {"tl": "the title"}

Context: this is a 'expense' record (Track daily expenses with amount and payment method).

Text: {cleaned_text_with_essentials_stripped}
```

For short text (≤5 words after stripping essentials), the cleaned text is used directly as title — no LLM call.

## Web UI Spotlight — Inline Syntax

The spotlight input (keyboard shortcut or + button) supports inline tokens for recipes, tags, and values:

```
/expense Lunch at MK #payment-source:cash @THB(200)
```

| Token | Syntax | Example | Purpose |
|---|---|---|---|
| Recipe | `/recipe` | `/expense` | Select recipe (must be first) |
| Tag | `#tag` or `#scope:tag` | `#cash`, `#payment-source:cash` | Pre-select tags |
| Value | `@key(number)` | `@THB(200)`, `@hours(1.5)` | Pre-select numeric values |

### Processing

1. Frontend parses tokens → `hint_tags`, `hint_values`
2. Tokens stripped from text before sending to API
3. Clean text + hints sent to `/api/ingest/text`
4. Worker uses hints to decide processing path (direct/partial/summarize)

### Highlighting

Tokens are highlighted inline in the contenteditable input:
- `/recipe` → purple (action module color)
- `#tag` → blue (stat module color)
- `@value(n)` → orange (log module color)

### Autocomplete

- `/` triggers recipe autocomplete (Tab to cycle, Enter to confirm)
- `#` triggers tag autocomplete (filtered by recipe scopes, Tab/Enter to confirm)
- `@` triggers value key autocomplete from master values (Tab/Enter to confirm, inserts `@KEY(` ready for number)

## Discord Bot — Queue-Driven Conversation

The Discord bot uses the queue as the processing backbone. Bot is thin: it posts to the queue, listens for WebSocket updates, and renders Discord messages. All inference happens in the server's queue worker.

### Process Responsibilities

| Process | Role |
|---|---|
| **Bot** (`cmd/bot`) | Discord I/O, thread management, queue_id↔thread_id mapping, renders WS events as Discord messages |
| **Server** (`cmd/server`) | Queue management, recipe matching (Ollama), field extraction (Ollama), record creation, pushes WS events |
| **Ollama** | LLM inference (called by server worker only) |

### Flow

```mermaid
sequenceDiagram
    participant U as Discord User / Web UI
    participant C as Client (Bot / Frontend)
    participant S as Server (cmd/server)
    participant W as Queue Worker (goroutine)
    participant O as Ollama
    participant Q as queue.db
    participant DB as pascal.db

    Note over C,S: Example 1: Complete input (PATH A — no LLM)
    U->>C: /expense Lunch @THB(200) #payment-source:cash
    C->>S: POST /api/ingest/text<br/>{"text":"Lunch","recipe_u":"expense",<br/>"hint_tags":["payment-source:cash"],<br/>"hint_values":[{"k":"THB","v":200}]}
    S->>Q: INSERT (pending)
    S-->>C: 202 {queue_id: 42}
    W->>Q: Poll pending → SET processing
    Note over W: Short text + all required<br/>fields provided → direct create
    W->>DB: INSERT record (no Ollama call)
    W->>Q: SET done
    W-->>C: WS: record:created

    Note over C,S: Example 2: Missing fields (PATH B — partial LLM)
    U->>C: /expense Lunch @THB(200)
    C->>S: POST /api/ingest/text<br/>{"text":"Lunch","recipe_u":"expense",<br/>"hint_values":[{"k":"THB","v":200}]}
    S->>Q: INSERT (pending)
    W->>Q: Poll pending → SET processing
    Note over W: Short text + missing<br/>tag:payment-source → partial LLM
    W->>O: Extract ONLY missing: payment-source tag
    O-->>W: {"tags":["cash"],"missing":[]}
    Note over W: Merge LLM tags + hint values → finalize
    W->>DB: INSERT record
    W->>Q: SET done
    W-->>C: WS: record:created

    Note over C,S: Example 3: Long text (PATH C — summarize LLM)
    U->>C: (pastes 500-char meeting notes)
    C->>S: POST /api/ingest/text<br/>{"text":"...long text...","recipe_u":"meeting"}
    S->>Q: INSERT (pending)
    W->>Q: Poll pending → SET processing
    Note over W: Long text (≥250 chars) → summarize
    W->>O: Summarize + extract all fields
    O-->>W: {"tl":"Q3 Planning Meeting","st":3,...}
    Note over W: title=summary, detail=original text
    W->>DB: INSERT record
    W->>Q: SET done
    W-->>C: WS: record:created

    Note over C,S: Example 4: No recipe (auto-match)
    U->>C: Lunch for 200 THB cash
    C->>S: POST /api/ingest/text<br/>{"text":"Lunch for 200 THB cash","source":"discord"}
    S->>Q: INSERT (pending, recipe_u=NULL)
    W->>Q: Poll pending
    W->>O: Classify against recipe list
    O-->>W: {"matches":["expense"]}
    Note over W: 1 match → proceed to extract path
    Note over W: Short text, no hints → PATH B
    W->>O: Extract missing fields with recipe context
    O-->>W: {"tags":["cash"],"values":[{"k":"THB","v":200}],...}
    W->>DB: INSERT record
    W->>Q: SET done
    W-->>C: WS: record:created
```

### Bot State (in-memory)

Bot maintains a lightweight map, not conversation state:

| Map | Key → Value | Purpose |
|---|---|---|
| `threadMap` | `queue_id` → `discord_thread_id` | Route WS events to correct Discord thread |
| `userThreads` | `channelID:userID` → `thread_id` | Track active thread per user for follow-up routing |

No conversation phase tracking. The queue status IS the state. Bot just renders what the server tells it.

### Bot Behavior

1. **New `@pascal` message:** POST to `/api/ingest/text`, create Discord thread, store mapping
2. **WS `queue:ambiguous`:** Post recipe choices in thread, wait for reply
3. **WS `queue:needs_input`:** Post missing field list in thread, wait for reply
4. **WS `queue:done`:** Post confirmation in thread
5. **WS `queue:no_match` / `queue:failed`:** Post error in thread
6. **User reply in thread:** Look up thread → last queue context, POST new `/api/ingest/text` with combined text + resolved `recipe_u`
7. **`cancel`:** Close thread context, no further processing

## Raycast Scripts

Lightweight ingestion from macOS/iPhone via Raycast. Scripts in `scripts/`.

### `raycast-pascal-log.sh` — Unstructured

Quick-capture text → queue → Ollama processing.

- **Raycast command:** "Pascal Log"
- **Input:** Free text (e.g. "Lunch 200 THB prompt pay")
- **Endpoint:** `POST /api/ingest/text` with `source: "raycast"`
- **Response:** "Queued (#N)"

### `raycast-pascal-record.sh` — Structured

Direct record creation, no Ollama.

- **Raycast command:** "Pascal Record"
- **Input:** Title + optional scope
- **Endpoint:** `POST /api/ingest/record`
- **Response:** "Recorded: {title}"

### Setup

Set `PASCAL_URL` env var in Raycast preferences. Default: `http://100.64.0.1:7600` (Tailscale IP of server).

## Network Topology

```
Internet (Public VPS IP)
├── POST /api/ingest/webhook/:id       ← Gmail, bank, external services
├── POST /api/ingest/gcal       ← Google Calendar push notifications
├── POST /api/ingest/record     ← (public alias for structured ingestion)
│
Tailscale (Internal)
├── POST /api/ingest/text       ← Discord bot, Raycast (Pascal Log)
├── POST /api/ingest/record     ← MCP, Web UI, Raycast (Pascal Record)
├── POST /api/records           ← MCP, Web UI (original path, kept)
├── GET  /api/records           ← Web UI
├── GET  /api/stats             ← Web UI
├── POST /api/gcal/setup        ← Admin
├── GET  /api/gcal/sync/:id     ← Admin
├── WS   /ws                    ← Web UI, Bot
└── GET  /                      ← Web dashboard
```
