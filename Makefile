.PHONY: build run server bot clean

build:
	go build -o pascal-server ./cmd/server
	go build -o pascal-bot ./cmd/bot

server:
	go run ./cmd/server

bot:
	go run ./cmd/bot

run: build
	./pascal-server &
	./pascal-bot

clean:
	rm -f pascal-server pascal-bot
	rm -rf runtime/

tidy:
	go mod tidy

test:
	go test ./...
