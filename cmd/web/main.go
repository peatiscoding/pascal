package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"pascal/internal/pidguard"
)

//go:embed static
var static embed.FS

var webStartTime = time.Now()

func main() {
	pidguard.Start("runtime/web.pid", 5*time.Second)
	addr := envOr("PASCAL_WEB_ADDR", ":7601")
	apiURL := envOr("PASCAL_API_URL", "http://localhost:7600")

	sub, err := fs.Sub(static, "static")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	apiPort := envOr("PASCAL_API_PORT", "7600")
	botPort := envOr("PASCAL_BOT_PORT", "7602")
	mux.HandleFunc("/config.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		// Derive API/Bot URLs from browser's current hostname so Tailscale etc. work
		w.Write([]byte(fmt.Sprintf(
			`(function(){var h=location.hostname;var p=location.protocol+"//";window.PASCAL_API_URL=p+h+":%s";window.PASCAL_BOT_URL=p+h+":%s";})();`,
			apiPort, botPort,
		)))
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
