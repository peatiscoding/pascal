-include runtime/.env
export

.PHONY: build run server bot web dev dev-detached dev-kill clean

build:
	go build -o pascal-server ./cmd/server
	go build -o pascal-bot ./cmd/bot
	go build -o pascal-web ./cmd/web

server:
	go run ./cmd/server

bot:
	go run ./cmd/bot

web:
	go run ./cmd/web

dev: dev-kill
	@trap 'kill 0' EXIT; \
	go run ./cmd/server & echo $$! > runtime/server.pid; \
	go run ./cmd/bot & echo $$! > runtime/bot.pid; \
	go run ./cmd/web & echo $$! > runtime/web.pid; \
	wait

dev-detached: dev-kill
	@mkdir -p runtime
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
	./pascal-server &
	./pascal-bot &
	./pascal-web

clean:
	rm -f pascal-server pascal-bot pascal-web
	rm -rf runtime/

tidy:
	go mod tidy

test:
	go test ./...
