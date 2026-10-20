package api

import (
	"encoding/json"
	"net/http"

	"pascal/internal/db"
)

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := db.StatFilter{
		GroupBy: q.Get("group_by"),
	}

	if f.GroupBy == "" {
		http.Error(w, "group_by required", http.StatusBadRequest)
		return
	}

	if v := q.Get("value_key"); v != "" {
		f.ValueKey = &v
	}
	if v := q.Get("scope"); v != "" {
		f.Scope = &v
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

	results, err := db.QueryStats(s.mainDB, f)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}
