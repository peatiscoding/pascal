package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"pascal/internal/api"
	"pascal/internal/db"
	"pascal/internal/ollama"
	"pascal/internal/worker"
	"pascal/internal/ws"
)

func main() {
	addr := envOr("PASCAL_ADDR", ":7600")
	dbPath := envOr("PASCAL_DB", "runtime/pascal.db")
	queuePath := envOr("PASCAL_QUEUE_DB", "runtime/queue.db")
	ollamaURL := envOr("OLLAMA_URL", "http://localhost:11434")
	ollamaModel := envOr("OLLAMA_MODEL", "llama3.2:3b")

	// Ensure runtime directory exists
	if dir := filepath.Dir(dbPath); dir != "." {
		os.MkdirAll(dir, 0o755)
	}
	if dir := filepath.Dir(queuePath); dir != "." {
		os.MkdirAll(dir, 0o755)
	}

	// Open main database
	mainDB, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("open main db: %v", err)
	}
	defer mainDB.Close()

	if err := db.Migrate(mainDB, "001_init.sql"); err != nil {
		log.Fatalf("migrate main db: %v", err)
	}

	// Open queue database
	queueDB, err := db.Open(queuePath)
	if err != nil {
		log.Fatalf("open queue db: %v", err)
	}
	defer queueDB.Close()

	if err := db.Migrate(queueDB, "002_queue.sql"); err != nil {
		log.Fatalf("migrate queue db: %v", err)
	}

	// Init components
	hub := ws.NewHub()
	oc := ollama.New(ollamaURL, ollamaModel)

	// Start queue worker
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w := worker.New(queueDB, mainDB, oc, hub)
	go w.Run(ctx)

	// Start HTTP server
	srv := api.NewServer(mainDB, queueDB, hub)
	httpSrv := &http.Server{
		Addr:    addr,
		Handler: srv.Router(),
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("shutting down...")
		cancel()
		httpSrv.Close()
	}()

	log.Printf("pascal server listening on %s", addr)
	if err := httpSrv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("http server: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
