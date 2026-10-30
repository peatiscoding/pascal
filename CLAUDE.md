# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PASCAL (Personal Assistant for Statistics, Context, Actions & Logging) — local-network Go server for personal event logging, stats aggregation, and dashboards. Single-user, no auth.

## Architecture

- **API Server** (`cmd/server`) — Go binary: HTTP API + queue worker goroutine + WebSocket hub + embedded static files
- **Discord Bot** (`cmd/bot`) — Separate Go binary, calls server API over HTTP
- **Two SQLite files:** `runtime/pascal.db` (permanent data), `runtime/queue.db` (ephemeral ingestion queue)
- **Three ingestion paths:** Structured (direct DB write), Generic Webhooks (pattern/field_map/Ollama), Google Calendar sync (push notifications)
- **MCP Server** (`cmd/mcp`) — stdio JSON-RPC server for Claude Code integration, calls API server over HTTP
- **Frontend:** Pure HTML/JS/CSS, no frameworks, served via `go:embed`

## Tech Stack

- Go with `chi` router, `modernc.org/sqlite` (pure Go, no CGO), `coder/websocket`, `discordgo`
- Ollama for LLM inference (unstructured text → structured records)
- Raw SQL migrations embedded via `go:embed`, applied on startup

## Data Model

Short field names throughout. UUIDv7 as `BLOB(16)` for record IDs. Key tables:

- `record` — main entity (title, detail, status, created, recipe FK)
- `record_tags` — junction table (record ↔ tag) with `scope_path` (denormalized materialized path from tag's scope ancestry)
- `record_values` — numeric values per record (immutable, set once)
- `record_log` — status change audit trail
- `scope` — hierarchy master table (parent_id chain) for tag grouping and autocomplete
- `tag` — tags with optional scope FK (`tag.s → scope.id`); tags sharing a scope are exclusive per record
- `master_value` — value type registry (THB, TOKEN, etc.)
- `recipe` — templates with `default_st`, linked to `recipe_values` and `recipe_scopes`
- `webhook` — configurable ingestion endpoints (pattern, field_map, optional recipe binding)
- `gcal_sync` — Google Calendar watch channel config
- `ingest_queue` (in runtime/queue.db) — pending unstructured text for Ollama processing

Deletion strategy: `ON DELETE CASCADE` everywhere, no soft delete.

Network: VPS with public endpoints (webhooks, gcal push) + Tailscale for everything else.

## Development

- `make dev` — run all 3 servers (foreground, Ctrl-C kills all)
- `make dev-detached` — run all 3 servers in background
- `make dev-kill` — kill all servers (ports 7600, 7601, 7602)
- `make server` / `make bot` / `make web` / `make mcp` — run individual server
- `make test` — run all tests
- `make build` — compile binaries
- `make tidy` — go mod tidy

## Design Documents

- `design.md` — Full design specification (schema DDL, API, architecture diagram, queue design)
- `ingestion.md` — Ingestion system design (webhooks, gcal sync, queue, network topology)
- `analysis.md` — Architecture analysis with decision rationale

## Design System (web UI)

- Tokens live in `cmd/web/static/tokens.css` (loaded before `style.css`). Use `var(--…)` — never hard-coded hex in CSS or `app.js` inline styles.
- Type: `--fs-0…8` = 12·1.25ⁿ. Fonts: Geist (words), Geist Mono + `.num` (all numbers, tabular), STIX Two italic `.math` (symbols).
- Space/radius: Fibonacci only (`--s-1…9` = 2,3,5,8,13,21,34,55,89; `--r-*`). No shadows, 1px rules.
- Modules: σ stats `--mod-stat`, ∫ context `--mod-ctx`, Δ actions `--mod-act`, Σ logging `--mod-log` — always pair color with symbol. Sign: `--pos`/`--neg`/`--warn` with + / − / ≈.
- Carbon web components are themed via `--cds-*` overrides in `tokens.css`.
