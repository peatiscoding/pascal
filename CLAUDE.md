# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PASCAL (Personal Assistant for Statistics, Context, Actions & Logging) — local-network Go server for personal event logging, stats aggregation, and dashboards. Single-user, no auth.

## Architecture

- **API Server** (`cmd/server`) — Go binary: HTTP API + queue worker goroutine + WebSocket hub + embedded static files
- **Discord Bot** (`cmd/bot`) — Separate Go binary, calls server API over HTTP
- **Two SQLite files:** `runtime/pascal.db` (permanent data), `runtime/queue.db` (ephemeral ingestion queue)
- **Three ingestion paths:** Structured (direct DB write), Generic Webhooks (pattern/field_map/Ollama), Google Calendar sync (push notifications)
- **Frontend:** Pure HTML/JS/CSS, no frameworks, served via `go:embed`

## Tech Stack

- Go with `chi` router, `modernc.org/sqlite` (pure Go, no CGO), `coder/websocket`, `discordgo`
- Ollama for LLM inference (unstructured text → structured records)
- Raw SQL migrations embedded via `go:embed`, applied on startup

## Data Model

Short field names throughout. UUIDv7 as `BLOB(16)` for record IDs. Key tables:

- `record` — main entity (title, detail, status, scope as materialized path, category)
- `record_tags` — junction table (record ↔ tag)
- `record_values` — numeric values per record (immutable, set once)
- `record_log` — status change audit trail
- `scope` — hierarchy master table for autocomplete/validation
- `tag` — hierarchical tags (self-referential parent FK)
- `master_value` — value type registry (THB, TOKEN, etc.)
- `recipe` — templates with `recipe_values` and `recipe_scopes` for MCP interpretation
- `webhook` — configurable ingestion endpoints (pattern, field_map, optional recipe binding)
- `gcal_sync` — Google Calendar watch channel config
- `ingest_queue` (in runtime/queue.db) — pending unstructured text for Ollama processing

Deletion strategy: `ON DELETE CASCADE` everywhere, no soft delete.

Network: VPS with public endpoints (webhooks, gcal push) + Tailscale for everything else.

## Development

- `make dev` — run all 3 servers (foreground, Ctrl-C kills all)
- `make dev-detached` — run all 3 servers in background
- `make dev-kill` — kill all servers (ports 7600, 7601, 7602)
- `make server` / `make bot` / `make web` — run individual server
- `make test` — run all tests
- `make build` — compile binaries
- `make tidy` — go mod tidy

## Design Documents

- `design.md` — Full design specification (schema DDL, API, architecture diagram, queue design)
- `ingestion.md` — Ingestion system design (webhooks, gcal sync, queue, network topology)
- `analysis.md` — Architecture analysis with decision rationale
