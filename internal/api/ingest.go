package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"pascal/internal/db"

	"github.com/go-chi/chi/v5"
)

type ingestRequest struct {
	Text    string  `json:"text"`
	Source  string  `json:"source"`
	RecipeU *string `json:"recipe_u,omitempty"`
}

type ingestResponse struct {
	QueueID int64  `json:"queue_id"`
	Status  string `json:"status"`
}

func (s *Server) ingestText(w http.ResponseWriter, r *http.Request) {
	var req ingestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Text == "" {
		http.Error(w, "text required", http.StatusBadRequest)
		return
	}
	if req.Source == "" {
		req.Source = "api"
	}

	queueID, err := db.Enqueue(s.queueDB, req.Text, req.Source, req.RecipeU)
	if err != nil {
		if err.Error() == "queue full" {
			http.Error(w, "queue full", http.StatusTooManyRequests)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(ingestResponse{
		QueueID: queueID,
		Status:  "queued",
	})
}

func (s *Server) getQueueItem(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	item, err := db.GetQueueItem(s.queueDB, id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(item)
}

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	// TODO: implement webhook ingestion
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) {
	rows, err := s.mainDB.Query(`SELECT t.t, t.s, sc.name, t.d FROM tag t LEFT JOIN scope sc ON t.s = sc.id ORDER BY t.t`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type tag struct {
		Name      string  `json:"t"`
		ScopeID   *int    `json:"s,omitempty"`
		ScopeName *string `json:"scope_name,omitempty"`
		Desc      string  `json:"d"`
	}

	var tags []tag
	for rows.Next() {
		var t tag
		if err := rows.Scan(&t.Name, &t.ScopeID, &t.ScopeName, &t.Desc); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		tags = append(tags, t)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tags)
}


func (s *Server) listScopes(w http.ResponseWriter, r *http.Request) {
	rows, err := s.mainDB.Query(`SELECT id, name, parent_id FROM scope ORDER BY id`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type scope struct {
		ID       int    `json:"id"`
		Name     string `json:"name"`
		ParentID *int   `json:"parent_id,omitempty"`
	}

	var scopes []scope
	for rows.Next() {
		var sc scope
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.ParentID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		scopes = append(scopes, sc)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(scopes)
}
