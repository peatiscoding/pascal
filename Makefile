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

dev: build
	@trap 'kill 0' EXIT; \
	go run ./cmd/server & \
	go run ./cmd/bot & \
	go run ./cmd/web & \
	wait

dev-detached: build
	@go run ./cmd/server &
	@go run ./cmd/bot &
	@go run ./cmd/web &
	@echo "All servers started (pidguard handles old instances)"

dev-kill:
	@pkill -f "go run ./cmd/server" 2>/dev/null && echo "Killed server (go run)" || true
	@pkill -f "go run ./cmd/bot" 2>/dev/null && echo "Killed bot (go run)" || true
	@pkill -f "go run ./cmd/web" 2>/dev/null && echo "Killed web (go run)" || true
	@pkill -f "go-build.*exe/bot$$" 2>/dev/null && echo "Killed bot (child)" || true
	@pkill -f "go-build.*exe/server$$" 2>/dev/null && echo "Killed server (child)" || true
	@pkill -f "go-build.*exe/web$$" 2>/dev/null && echo "Killed web (child)" || true
	@rm -f runtime/server.pid runtime/bot.pid runtime/web.pid
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
