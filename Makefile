.PHONY: build run server bot web dev clean

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

dev:
	@trap 'kill 0' EXIT; \
	go run ./cmd/server & \
	go run ./cmd/bot & \
	go run ./cmd/web & \
	wait

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
