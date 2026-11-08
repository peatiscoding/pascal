-include runtime/.env
export

.PHONY: build run server bot web mcp dev dev-detached dev-kill clean check-deps

check-deps:
	@command -v go >/dev/null 2>&1 || { echo "Error: go is not installed. Install from https://go.dev/dl/"; exit 1; }
	@command -v caddy >/dev/null 2>&1 || { echo "Error: caddy is not installed. Install: brew install caddy"; exit 1; }

build: check-deps
	@mkdir -p runtime
	go build -o runtime/pascal-server ./cmd/server
	go build -o runtime/pascal-bot ./cmd/bot
	go build -o runtime/pascal-mcp ./cmd/mcp

server:
	go run ./cmd/server

bot:
	go run ./cmd/bot

web:
	caddy run

mcp:
	go run ./cmd/mcp

dev: build
	@mkdir -p runtime/logs
	@trap 'kill 0' EXIT; \
	go run ./cmd/server 2>&1 | tee runtime/logs/server.log & \
	go run ./cmd/bot 2>&1 | tee runtime/logs/bot.log & \
	caddy run 2>&1 | tee runtime/logs/web.log & \
	wait

dev-detached: dev-kill build
	@mkdir -p runtime/logs
	@go run ./cmd/server >> runtime/logs/server.log 2>&1 &
	@go run ./cmd/bot >> runtime/logs/bot.log 2>&1 &
	@caddy start >> runtime/logs/web.log 2>&1
	@echo "All servers started. Logs: runtime/logs/{server,bot,web}.log"

dev-kill:
	@pkill -f "go run ./cmd/server" 2>/dev/null && echo "Killed server (go run)" || true
	@pkill -f "go run ./cmd/bot" 2>/dev/null && echo "Killed bot (go run)" || true
	@caddy stop 2>/dev/null && echo "Killed caddy" || pkill -x caddy 2>/dev/null && echo "Killed caddy (pkill)" || true
	@pkill -f "go-build.*exe/bot$$" 2>/dev/null && echo "Killed bot (child)" || true
	@pkill -f "go-build.*exe/server$$" 2>/dev/null && echo "Killed server (child)" || true
	@rm -f runtime/server.pid runtime/bot.pid
	@for port in 7600 7601 7602; do \
		for i in 1 2 3 4 5 6 7 8 9 10; do \
			lsof -iTCP:$$port -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN || break; \
			sleep 0.3; \
		done; \
	done

run: build
	./runtime/pascal-server &
	./runtime/pascal-bot &
	caddy run

clean:
	rm -f runtime/pascal-server runtime/pascal-bot runtime/pascal-mcp

tidy:
	go mod tidy

test:
	go test ./...
