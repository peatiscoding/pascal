package api

import (
	"encoding/json"
	"net/http"

	"pascal/internal/db"

	"github.com/go-chi/chi/v5"
)

func (s *Server) listRecipesFull(w http.ResponseWriter, r *http.Request) {
	recipes, err := db.ListRecipesFull(s.mainDB)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if recipes == nil {
		recipes = []db.RecipeFull{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(recipes)
}

func (s *Server) getRecipe(w http.ResponseWriter, r *http.Request) {
	u := chi.URLParam(r, "u")
	recipe, err := db.GetRecipe(s.mainDB, u)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(recipe)
}

func (s *Server) createRecipe(w http.ResponseWriter, r *http.Request) {
	var req db.RecipeFull
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Usecase == "" || req.Description == "" {
		http.Error(w, "u and d required", http.StatusBadRequest)
		return
	}
	if req.Values == nil {
		req.Values = []db.RecipeValue{}
	}
	if req.Tags == nil {
		req.Tags = []db.RecipeTag{}
	}

	if err := db.InsertRecipe(s.mainDB, &req); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(req)
}

func (s *Server) updateRecipe(w http.ResponseWriter, r *http.Request) {
	u := chi.URLParam(r, "u")
	var req db.RecipeFull
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Usecase = u
	if req.Values == nil {
		req.Values = []db.RecipeValue{}
	}
	if req.Tags == nil {
		req.Tags = []db.RecipeTag{}
	}

	if err := db.UpdateRecipe(s.mainDB, &req); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteRecipe(w http.ResponseWriter, r *http.Request) {
	u := chi.URLParam(r, "u")
	if err := db.DeleteRecipe(s.mainDB, u); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listMasterValues(w http.ResponseWriter, r *http.Request) {
	rows, err := s.mainDB.Query(`SELECT k, d FROM master_value ORDER BY k`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type masterValue struct {
		Key         string `json:"k"`
		Description string `json:"d"`
	}

	var values []masterValue
	for rows.Next() {
		var v masterValue
		if err := rows.Scan(&v.Key, &v.Description); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		values = append(values, v)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if values == nil {
		values = []masterValue{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(values)
}
