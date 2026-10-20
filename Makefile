-include runtime/.env
export

.PHONY: build run server bot web mcp dev dev-detached dev-kill clean

build:
	@mkdir -p runtime
	go build -o runtime/pascal-server ./cmd/server
	go build -o runtime/pascal-bot ./cmd/bot
	go build -o runtime/pascal-web ./cmd/web
	go build -o runtime/pascal-mcp ./cmd/mcp

server:
	go run ./cmd/server

bot:
	go run ./cmd/bot

web:
	go run ./cmd/web

mcp:
	go run ./cmd/mcp

dev: dev-kill build
	@trap 'kill 0' EXIT; \
	go run ./cmd/server & echo $$! > runtime/server.pid; \
	go run ./cmd/bot & echo $$! > runtime/bot.pid; \
	go run ./cmd/web & echo $$! > runtime/web.pid; \
	wait

dev-detached: dev-kill build
	@go run ./cmd/server & echo $$! > runtime/server.pid
	@go run ./cmd/bot & echo $$! > runtime/bot.pid
	@go run ./cmd/web & echo $$! > runtime/web.pid
	@echo "All servers started in background (PIDs in runtime/*.pid)"

dev-kill:
	@for f in runtime/server.pid runtime/bot.pid runtime/web.pid; do \
		if [ -f "$$f" ]; then \
			pid=$$(cat "$$f"); \
			pkill -P "$$pid" 2>/dev/null || true; \
			kill "$$pid" 2>/dev/null || true; \
			echo "Killed $$(basename $$f .pid) (PID $$pid)"; \
			rm -f "$$f"; \
		fi; \
	done
	@sleep 0.5

run: build
	./runtime/pascal-server &
	./runtime/pascal-bot &
	./runtime/pascal-web

clean:
	rm -f runtime/pascal-server runtime/pascal-bot runtime/pascal-web runtime/pascal-mcp

tidy:
	go mod tidy

test:
	go test ./...
