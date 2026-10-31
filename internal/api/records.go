package api

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"pascal/internal/db"
	"pascal/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type createRecordRequest struct {
	Title  string           `json:"tl"`
	Detail *string          `json:"dt,omitempty"`
	Status *int             `json:"st,omitempty"`
	Recipe *string          `json:"r,omitempty"`
	Tags   []string         `json:"tags"`
	Values []db.RecordValue `json:"values"`
}

func (s *Server) createRecord(w http.ResponseWriter, r *http.Request) {
	var req createRecordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Title == "" {
		http.Error(w, "tl required", http.StatusBadRequest)
		return
	}

	// Resolve status: explicit > recipe default > 1
	status := 1
	if req.Status != nil {
		status = *req.Status
	} else if req.Recipe != nil {
		if recipe, err := db.GetRecipe(s.mainDB, *req.Recipe); err == nil {
			status = recipe.DefaultStatus
		}
	}

	id, err := uuid.NewV7()
	if err != nil {
		http.Error(w, "uuid generation failed", http.StatusInternalServerError)
		return
	}
	idBytes, _ := id.MarshalBinary()

	rec := &db.RecordFull{
		Record: db.Record{
			ID:     idBytes,
			Title:  req.Title,
			Detail: req.Detail,
			Status: status,
			Recipe: req.Recipe,
		},
		Tags:   req.Tags,
		Values: req.Values,
	}

	if err := db.InsertRecord(s.mainDB, rec); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(ws.Event{
		Type: "record:created",
		ID:   fmt.Sprintf("%x", idBytes),
	})

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(rec)
}

func (s *Server) getRecord(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	rec, err := db.GetRecord(s.mainDB, id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rec)
}

func (s *Server) listRecords(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := db.RecordFilter{
		Limit:  100,
		Offset: 0,
	}

	if v := q.Get("scope"); v != "" {
		f.Scope = &v
	}
	if v := q.Get("st"); v != "" {
		st, err := strconv.Atoi(v)
		if err == nil {
			f.Status = &st
		}
	}
	if v := q.Get("tag"); v != "" {
		f.Tag = &v
	}
	if v := q.Get("from"); v != "" {
		f.From = &v
	}
	if v := q.Get("to"); v != "" {
		f.To = &v
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Offset = n
		}
	}

	records, err := db.ListRecords(s.mainDB, f)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(records)
}

type updateRecordRequest struct {
	Title  *string          `json:"tl,omitempty"`
	Detail *string          `json:"dt,omitempty"`
	Status *int             `json:"st,omitempty"`
	Info   string           `json:"inf"`
	Recipe *string          `json:"r,omitempty"`
	Tags   []string         `json:"tags,omitempty"`
	Values []db.RecordValue `json:"values,omitempty"`
	Full   bool             `json:"full,omitempty"` // true = full update (title/tags/values)
}

func (s *Server) updateRecord(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	var req updateRecordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Full {
		// Full record update
		if req.Title == nil || *req.Title == "" {
			http.Error(w, "tl required", http.StatusBadRequest)
			return
		}
		st := 1
		if req.Status != nil {
			st = *req.Status
		}
		if err := db.UpdateRecord(s.mainDB, id, *req.Title, req.Detail, st, req.Recipe, req.Tags, req.Values); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		// Status-only update (backward compat)
		st := 0
		if req.Status != nil {
			st = *req.Status
		}
		if err := db.UpdateRecordStatus(s.mainDB, id, st, req.Info); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	s.hub.Broadcast(ws.Event{
		Type: "record:updated",
		ID:   fmt.Sprintf("%x", id),
	})

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteRecord(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	if err := db.DeleteRecord(s.mainDB, id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(ws.Event{
		Type: "record:deleted",
		ID:   fmt.Sprintf("%x", id),
	})

	w.WriteHeader(http.StatusNoContent)
}

func parseID(s string) ([]byte, error) {
	return hex.DecodeString(s)
}
