package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"pascal/internal/db"

	"github.com/go-chi/chi/v5"
)

// --- Master Values ---

type masterValueReq struct {
	Key         string `json:"k"`
	Description string `json:"d"`
}

func (s *Server) createMasterValue(w http.ResponseWriter, r *http.Request) {
	var req masterValueReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Key == "" || req.Description == "" {
		http.Error(w, "k and d required", http.StatusBadRequest)
		return
	}
	if _, err := s.mainDB.Exec(`INSERT INTO master_value (k, d) VALUES (?, ?)`, req.Key, req.Description); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(req)
}

func (s *Server) updateMasterValue(w http.ResponseWriter, r *http.Request) {
	k := chi.URLParam(r, "k")
	var req masterValueReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	res, err := s.mainDB.Exec(`UPDATE master_value SET d=? WHERE k=?`, req.Description, k)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteMasterValue(w http.ResponseWriter, r *http.Request) {
	k := chi.URLParam(r, "k")
	res, err := s.mainDB.Exec(`DELETE FROM master_value WHERE k=?`, k)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Tags ---

type tagReq struct {
	Tag         string  `json:"t"`
	Parent      *string `json:"p,omitempty"`
	Description string  `json:"d"`
}

func (s *Server) createTag(w http.ResponseWriter, r *http.Request) {
	var req tagReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Tag == "" || req.Description == "" {
		http.Error(w, "t and d required", http.StatusBadRequest)
		return
	}
	if _, err := s.mainDB.Exec(`INSERT INTO tag (t, p, d) VALUES (?, ?, ?)`, req.Tag, req.Parent, req.Description); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(req)
}

func (s *Server) updateTag(w http.ResponseWriter, r *http.Request) {
	t := chi.URLParam(r, "t")
	var req tagReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Check if parent is changing and tag is in use
	var currentParent sql.NullString
	if err := s.mainDB.QueryRow(`SELECT p FROM tag WHERE t=?`, t).Scan(&currentParent); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	newParent := req.Parent
	parentChanged := (currentParent.Valid != (newParent != nil)) ||
		(currentParent.Valid && newParent != nil && currentParent.String != *newParent)
	if parentChanged {
		inUse, err := db.TagInUse(s.mainDB, t)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if inUse {
			http.Error(w, "cannot change parent of tag in use by records", http.StatusConflict)
			return
		}
	}

	res, err := s.mainDB.Exec(`UPDATE tag SET p=?, d=? WHERE t=?`, req.Parent, req.Description, t)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) {
	t := chi.URLParam(r, "t")
	res, err := s.mainDB.Exec(`DELETE FROM tag WHERE t=?`, t)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Scopes ---

type scopeReq struct {
	Name     string `json:"name"`
	ParentID *int   `json:"parent_id,omitempty"`
}

func (s *Server) createScope(w http.ResponseWriter, r *http.Request) {
	var req scopeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	res, err := s.mainDB.Exec(`INSERT INTO scope (name, parent_id) VALUES (?, ?)`, req.Name, req.ParentID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	id, _ := res.LastInsertId()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id, "name": req.Name, "parent_id": req.ParentID})
}

func (s *Server) updateScope(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	var req scopeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	res, err := s.mainDB.Exec(`UPDATE scope SET name=?, parent_id=? WHERE id=?`, req.Name, req.ParentID, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteScope(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	res, err := s.mainDB.Exec(`DELETE FROM scope WHERE id=?`, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
