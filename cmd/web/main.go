package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"
)

//go:embed static
var static embed.FS

var webStartTime = time.Now()

func main() {
	addr := envOr("PASCAL_WEB_ADDR", ":7601")
	apiURL := envOr("PASCAL_API_URL", "http://localhost:7600")
	botURL := envOr("PASCAL_BOT_URL", "http://localhost:7602")

	sub, err := fs.Sub(static, "static")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/config.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Write([]byte(`window.PASCAL_API_URL="` + apiURL + `";window.PASCAL_BOT_URL="` + botURL + `";`))
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","uptime_sec":%d}`, int(time.Since(webStartTime).Seconds()))
	})

	log.Printf("pascal web listening on %s (api: %s)", addr, apiURL)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("http server: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
