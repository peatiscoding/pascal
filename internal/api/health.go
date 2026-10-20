package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

var startTime = time.Now()

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	status := "ok"

	// Check main DB
	dbOK := true
	if err := s.mainDB.Ping(); err != nil {
		dbOK = false
		status = "degraded"
	}

	// Check queue DB
	queueOK := true
	if err := s.queueDB.Ping(); err != nil {
		queueOK = false
		status = "degraded"
	}

	// Queue depth
	var queueDepth int
	s.queueDB.QueryRow(`SELECT COUNT(*) FROM ingest_queue WHERE status='pending'`).Scan(&queueDepth)

	// Record count
	var recordCount int
	s.mainDB.QueryRow(`SELECT COUNT(*) FROM record`).Scan(&recordCount)

	resp := map[string]any{
		"status":       status,
		"uptime_sec":   int(time.Since(startTime).Seconds()),
		"db_ok":        dbOK,
		"queue_db_ok":  queueOK,
		"queue_depth":  queueDepth,
		"record_count": recordCount,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) mcpProbe(w http.ResponseWriter, r *http.Request) {
	// Find MCP binary relative to executable
	exe, _ := os.Executable()
	mcpBin := filepath.Join(filepath.Dir(exe), "pascal-mcp")

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, mcpBin)
	cmd.Stdin = bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}` + "\n"))

	out, err := cmd.Output()

	w.Header().Set("Content-Type", "application/json")

	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]any{
			"status": "error",
			"error":  err.Error(),
		})
		return
	}

	// Verify valid JSON-RPC response
	var resp map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(out), &resp); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]any{
			"status": "error",
			"error":  "invalid response: " + string(out),
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"status":   "ok",
		"response": resp,
	})
}
