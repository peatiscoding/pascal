package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"pascal/internal/db"
	"pascal/internal/ollama"
	"pascal/internal/ws"

	"github.com/google/uuid"
)

const pollInterval = 500 * time.Millisecond

const inferPrompt = `You are a data extraction assistant. Parse the following text into a structured record.
Return JSON with these fields:
- tl (string): title/summary
- dt (string, optional): detail
- st (int): status 0=paused, 1=todo, 2=doing, 3=done. Default 1.
- sc (string): scope hierarchy, pipe-delimited (e.g. "Work|ProjectX")
- cg (string): category
- tags (string[]): relevant tags
- values (object[]): each with "k" (value type key) and "v" (number), if applicable

Text: %s`

type Worker struct {
	queueDB  *sql.DB
	mainDB   *sql.DB
	ollama   *ollama.Client
	hub      *ws.Hub
}

func New(queueDB, mainDB *sql.DB, oc *ollama.Client, hub *ws.Hub) *Worker {
	return &Worker{
		queueDB: queueDB,
		mainDB:  mainDB,
		ollama:  oc,
		hub:     hub,
	}
}

func (w *Worker) Run(ctx context.Context) {
	log.Println("queue worker started")
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("queue worker stopped")
			return
		case <-ticker.C:
			w.processNext()
		}
	}
}

func (w *Worker) processNext() {
	item, err := db.DequeueNext(w.queueDB)
	if err != nil {
		log.Printf("dequeue error: %v", err)
		return
	}
	if item == nil {
		return
	}

	log.Printf("processing queue item %d from %s", item.ID, item.Source)

	prompt := fmt.Sprintf(inferPrompt, item.Payload)
	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		log.Printf("ollama error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	record, err := parseResponse(resp)
	if err != nil {
		log.Printf("parse error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	if err := db.InsertRecord(w.mainDB, record); err != nil {
		log.Printf("insert error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	if err := db.MarkDone(w.queueDB, item.ID); err != nil {
		log.Printf("mark done error for item %d: %v", item.ID, err)
	}

	w.hub.Broadcast(ws.Event{
		Type: "record:created",
		ID:   fmt.Sprintf("%x", record.ID),
	})

	log.Printf("processed queue item %d -> record %x", item.ID, record.ID)
}

type ollamaRecord struct {
	Title    string             `json:"tl"`
	Detail   *string            `json:"dt,omitempty"`
	Status   int                `json:"st"`
	Scope    string             `json:"sc"`
	Category string             `json:"cg"`
	Tags     []string           `json:"tags"`
	Values   []db.RecordValue   `json:"values"`
}

func parseResponse(resp string) (*db.RecordFull, error) {
	var parsed ollamaRecord
	if err := json.Unmarshal([]byte(resp), &parsed); err != nil {
		return nil, fmt.Errorf("unmarshal ollama response: %w", err)
	}

	if parsed.Title == "" {
		return nil, fmt.Errorf("missing title in ollama response")
	}
	if parsed.Scope == "" {
		return nil, fmt.Errorf("missing scope in ollama response")
	}
	if parsed.Category == "" {
		return nil, fmt.Errorf("missing category in ollama response")
	}

	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	idBytes, _ := id.MarshalBinary()

	return &db.RecordFull{
		Record: db.Record{
			ID:       idBytes,
			Title:    parsed.Title,
			Detail:   parsed.Detail,
			Status:   parsed.Status,
			Scope:    parsed.Scope,
			Category: parsed.Category,
		},
		Tags:   parsed.Tags,
		Values: parsed.Values,
	}, nil
}
