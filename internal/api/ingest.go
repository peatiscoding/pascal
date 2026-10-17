package api

import (
	"encoding/json"
	"net/http"

	"pascal/internal/db"
)

type ingestRequest struct {
	Text   string `json:"text"`
	Source string `json:"source"`
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

	queueID, err := db.Enqueue(s.queueDB, req.Text, req.Source)
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

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) {
	rows, err := s.mainDB.Query(`SELECT t, p, d FROM tag ORDER BY t`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type tag struct {
		Name        string  `json:"t"`
		Parent      *string `json:"p,omitempty"`
		Description string  `json:"d"`
	}

	var tags []tag
	for rows.Next() {
		var t tag
		if err := rows.Scan(&t.Name, &t.Parent, &t.Description); err != nil {
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

func (s *Server) listRecipes(w http.ResponseWriter, r *http.Request) {
	rows, err := s.mainDB.Query(`SELECT u, d FROM recipe ORDER BY u`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type recipe struct {
		Usecase     string `json:"u"`
		Description string `json:"d"`
	}

	var recipes []recipe
	for rows.Next() {
		var rc recipe
		if err := rows.Scan(&rc.Usecase, &rc.Description); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		recipes = append(recipes, rc)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(recipes)
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
