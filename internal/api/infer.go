package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"pascal/internal/db"
)

// ollama import lives in router.go via Server struct

// --- Phase 1: Match recipe ---

type matchRecipeRequest struct {
	Text string `json:"text"`
}

type matchRecipeResponse struct {
	Matches []string `json:"matches"` // recipe usecases
}

func (s *Server) matchRecipe(w http.ResponseWriter, r *http.Request) {
	var req matchRecipeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Text == "" {
		http.Error(w, "text required", http.StatusBadRequest)
		return
	}

	recipes, err := db.ListRecipesFull(s.mainDB)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if len(recipes) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(matchRecipeResponse{Matches: []string{}})
		return
	}

	// Build recipe summary for prompt
	var recipeList strings.Builder
	for _, rc := range recipes {
		fmt.Fprintf(&recipeList, "- %s: %s\n", rc.Usecase, rc.Description)
	}

	prompt := fmt.Sprintf(`You are a classifier. Given user text and a list of available recipes, return which recipe(s) match the user's intent.

Available recipes:
%s
Return JSON: {"matches": ["recipe_usecase1"]}
Return empty matches if none fit. Only return exact usecase keys from the list above.

User text: %s`, recipeList.String(), req.Text)

	resp, err := s.ollama.Generate(prompt)
	if err != nil {
		http.Error(w, fmt.Sprintf("ollama: %v", err), http.StatusInternalServerError)
		return
	}

	var result matchRecipeResponse
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		// Try to salvage — if ollama returned something weird
		http.Error(w, fmt.Sprintf("parse ollama response: %v (raw: %s)", err, resp), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// --- Phase 2: Extract fields ---

type extractRequest struct {
	Text   string `json:"text"`
	Recipe string `json:"recipe"` // recipe usecase
}

type extractResponse struct {
	Title   string           `json:"tl"`
	Detail  *string          `json:"dt,omitempty"`
	Status  int              `json:"st"`
	Tags    []string         `json:"tags"`
	Values  []db.RecordValue `json:"values"`
	Missing []string         `json:"missing,omitempty"`
}

func (s *Server) extractFields(w http.ResponseWriter, r *http.Request) {
	var req extractRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Text == "" || req.Recipe == "" {
		http.Error(w, "text and recipe required", http.StatusBadRequest)
		return
	}

	recipe, err := db.GetRecipe(s.mainDB, req.Recipe)
	if err != nil {
		http.Error(w, fmt.Sprintf("recipe not found: %v", err), http.StatusNotFound)
		return
	}

	// Gather master data context
	tags, _ := s.listTagsData()
	masterVals, _ := s.listMasterValuesData()

	// Build context for prompt
	var ctx strings.Builder
	fmt.Fprintf(&ctx, "Recipe: %s — %s (default status: %d)\n\n", recipe.Usecase, recipe.Description, recipe.DefaultStatus)

	if len(recipe.Values) > 0 {
		ctx.WriteString("Expected values:\n")
		for _, v := range recipe.Values {
			unit := v.MasterKey
			for _, mv := range masterVals {
				if mv.Key == v.MasterKey {
					unit = mv.Key
					break
				}
			}
			req := ""
			if v.Required {
				req = " (REQUIRED)"
			}
			fmt.Fprintf(&ctx, "- %s%s\n", unit, req)
		}
	}

	if len(recipe.Scopes) > 0 {
		ctx.WriteString("\nRequired tag scopes (must pick a tag from each):\n")
		for _, sc := range recipe.Scopes {
			req := ""
			if sc.Required {
				req = " (REQUIRED)"
			}
			fmt.Fprintf(&ctx, "- %s%s\n", sc.ScopeName, req)
		}
	}

	if len(tags) > 0 {
		ctx.WriteString("\nAvailable tags: ")
		names := make([]string, len(tags))
		for i, t := range tags {
			names[i] = t.Name
		}
		ctx.WriteString(strings.Join(names, ", "))
		ctx.WriteString("\n")
	}

	statusHint := fmt.Sprintf("Use %d (recipe default) unless text clearly indicates otherwise.", recipe.DefaultStatus)

	prompt := fmt.Sprintf(`You are a data extraction assistant. Extract structured data from user text using the recipe context below.

%s
Return JSON with these fields:
- tl (string): title/summary
- dt (string, optional): detail
- st (int): status 0=paused, 1=todo, 2=doing, 3=done. %s
- tags (string[]): pick from available tags only. Include tags from required scopes.
- values (object[]): each with "k" (master value key) and "v" (number). Extract numeric values from the text.
- missing (string[]): list any REQUIRED fields you could not find in the text

User text: %s`, ctx.String(), statusHint, req.Text)

	resp, err := s.ollama.Generate(prompt)
	if err != nil {
		http.Error(w, fmt.Sprintf("ollama: %v", err), http.StatusInternalServerError)
		return
	}

	var result extractResponse
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		http.Error(w, fmt.Sprintf("parse: %v (raw: %s)", err, resp), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// --- Internal helpers for fetching master data ---

type tagData struct {
	Name string
}

type scopeData struct {
	ID       int
	Name     string
	ParentID *int
}

type masterValueData struct {
	Key  string
	Desc string
}

func (s *Server) listTagsData() ([]tagData, error) {
	rows, err := s.mainDB.Query(`SELECT t FROM tag ORDER BY t`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []tagData
	for rows.Next() {
		var t tagData
		if err := rows.Scan(&t.Name); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

func (s *Server) listScopesData() ([]scopeData, error) {
	rows, err := s.mainDB.Query(`SELECT id, name, parent_id FROM scope ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var scopes []scopeData
	for rows.Next() {
		var sc scopeData
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.ParentID); err != nil {
			return nil, err
		}
		scopes = append(scopes, sc)
	}
	return scopes, nil
}

func (s *Server) listMasterValuesData() ([]masterValueData, error) {
	rows, err := s.mainDB.Query(`SELECT k, d FROM master_value ORDER BY k`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var vals []masterValueData
	for rows.Next() {
		var v masterValueData
		if err := rows.Scan(&v.Key, &v.Desc); err != nil {
			return nil, err
		}
		vals = append(vals, v)
	}
	return vals, nil
}
