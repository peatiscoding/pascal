package api

import (
	"encoding/json"
	"net/http"
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
