package api

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func (s *Server) streamBotLog(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	f, err := os.Open(s.botLogPath)
	if err != nil {
		fmt.Fprintf(w, "data: {\"error\":\"log not available\"}\n\n")
		flusher.Flush()
		return
	}
	defer f.Close()

	// Backfill last 50 lines
	backfill(f, w, flusher, 50)

	// Tail new lines
	reader := bufio.NewReader(f)
	for {
		select {
		case <-r.Context().Done():
			return
		default:
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			return
		}
		line = strings.TrimRight(line, "\n")
		if line == "" {
			continue
		}
		fmt.Fprintf(w, "data: %s\n\n", line)
		flusher.Flush()
	}
}

func backfill(f *os.File, w http.ResponseWriter, flusher http.Flusher, n int) {
	scanner := bufio.NewScanner(f)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	start := 0
	if len(lines) > n {
		start = len(lines) - n
	}
	for _, line := range lines[start:] {
		fmt.Fprintf(w, "data: %s\n\n", line)
	}
	flusher.Flush()
}
