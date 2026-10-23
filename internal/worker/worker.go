package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"pascal/internal/db"
	"pascal/internal/ollama"
	"pascal/internal/ws"

	"github.com/google/uuid"
)

const pollInterval = 500 * time.Millisecond

type Worker struct {
	queueDB *sql.DB
	mainDB  *sql.DB
	ollama  *ollama.Client
	hub     *ws.Hub
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

// --- Result types stored in queue result column ---

type matchResult struct {
	Matches []string `json:"matches"`
}

type extractResult struct {
	Title   string           `json:"tl"`
	Detail  *string          `json:"dt,omitempty"`
	Status  int              `json:"st"`
	Scope   string           `json:"sc"`
	Tags    []string         `json:"tags"`
	Values  []db.RecordValue `json:"values"`
	Missing []string         `json:"missing,omitempty"`
}

// needsInputResult wraps partial extraction for the draft UI.
type needsInputResult struct {
	Partial extractResult `json:"partial"`
	Missing []string      `json:"missing,omitempty"`
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

	if item.RecipeU != nil && *item.RecipeU != "" {
		// Recipe known — go straight to extract
		w.phaseExtract(item, *item.RecipeU)
	} else {
		// Phase 1: match recipe
		w.phaseMatch(item)
	}
}

func (w *Worker) phaseMatch(item *db.QueueItem) {
	recipes, err := db.ListRecipesFull(w.mainDB)
	if err != nil {
		log.Printf("list recipes error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	if len(recipes) == 0 {
		// No recipes at all — extract without recipe context
		w.extractNoRecipe(item)
		return
	}

	// Build recipe list for prompt
	var recipeList strings.Builder
	for _, rc := range recipes {
		fmt.Fprintf(&recipeList, "- %s: %s\n", rc.Usecase, rc.Description)
	}

	prompt := fmt.Sprintf(`You are a classifier. Given user text and a list of available recipes, return which recipe(s) match the user's intent.

Available recipes:
%s
Return JSON only: {"matches": ["recipe_usecase1"]}
Return empty matches array if none fit. Only return exact usecase keys from the list above.

User text: %s`, recipeList.String(), item.Payload)

	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		log.Printf("ollama match error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	var result matchResult
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		log.Printf("parse match response for item %d: %v (raw: %s)", item.ID, err, resp)
		// Ollama gave garbage — fall through to no-recipe extract
		w.extractNoRecipe(item)
		return
	}

	switch len(result.Matches) {
	case 0:
		w.extractNoRecipe(item)
	case 1:
		w.phaseExtract(item, result.Matches[0])
	default:
		// Ambiguous — store matches, let user pick
		resultJSON, _ := json.Marshal(result)
		if err := db.SetQueueResult(w.queueDB, item.ID, "ambiguous", string(resultJSON)); err != nil {
			log.Printf("set ambiguous error for item %d: %v", item.ID, err)
		}
		w.hub.Broadcast(ws.Event{Type: "queue:ambiguous", ID: fmt.Sprintf("%d", item.ID)})
		log.Printf("item %d ambiguous: %v", item.ID, result.Matches)
	}
}

func (w *Worker) phaseExtract(item *db.QueueItem, recipeU string) {
	recipe, err := db.GetRecipe(w.mainDB, recipeU)
	if err != nil {
		log.Printf("get recipe %s for item %d: %v", recipeU, item.ID, err)
		// Recipe not found — extract without
		w.extractNoRecipe(item)
		return
	}

	tags, _ := db.ListTagNames(w.mainDB)
	scopes, _ := db.ListScopeNames(w.mainDB)
	masterVals, _ := db.ListMasterValues(w.mainDB)

	var ctx strings.Builder
	fmt.Fprintf(&ctx, "Recipe: %s — %s\n\n", recipe.Usecase, recipe.Description)

	if len(recipe.Values) > 0 {
		ctx.WriteString("Expected values:\n")
		for _, v := range recipe.Values {
			req := ""
			if v.Required {
				req = " (REQUIRED)"
			}
			// Find description from master values
			desc := v.MasterKey
			for _, mv := range masterVals {
				if mv.Key == v.MasterKey {
					desc = fmt.Sprintf("%s (%s)", mv.Key, mv.Desc)
					break
				}
			}
			fmt.Fprintf(&ctx, "- %s%s\n", desc, req)
		}
	}

	if len(recipe.Scopes) > 0 {
		ctx.WriteString("\nExpected scopes:\n")
		for _, sc := range recipe.Scopes {
			req := ""
			if sc.Required {
				req = " (REQUIRED)"
			}
			fmt.Fprintf(&ctx, "- %s%s\n", sc.ScopeName, req)
		}
	}

	w.doExtract(item, ctx.String(), tags, scopes, recipe)
}

func (w *Worker) extractNoRecipe(item *db.QueueItem) {
	tags, _ := db.ListTagNames(w.mainDB)
	scopes, _ := db.ListScopeNames(w.mainDB)

	w.doExtract(item, "", tags, scopes, nil)
}

func (w *Worker) doExtract(item *db.QueueItem, recipeCtx string, tags, scopes []string, recipe *db.RecipeFull) {
	var promptCtx strings.Builder
	if recipeCtx != "" {
		promptCtx.WriteString(recipeCtx)
		promptCtx.WriteString("\n")
	}
	if len(tags) > 0 {
		fmt.Fprintf(&promptCtx, "Available tags: %s\n", strings.Join(tags, ", "))
	}
	if len(scopes) > 0 {
		fmt.Fprintf(&promptCtx, "Available scopes: %s\n", strings.Join(scopes, ", "))
	}

	prompt := fmt.Sprintf(`You are a data extraction assistant. Extract structured data from the user text below.
%s
Return JSON only with these fields:
- tl (string): title/summary
- dt (string, optional): detail
- st (int): status 0=paused, 1=todo, 2=doing, 3=done. Default 3 for completed actions, 1 for future tasks.
- sc (string): scope path, pipe-delimited (e.g. "Finance|Spending"). Pick from available scopes.
- tags (string[]): pick from available tags only
- values (object[]): each with "k" (value type key) and "v" (number)
- missing (string[]): list any REQUIRED fields you could not find in the text

User text: %s`, promptCtx.String(), item.Payload)

	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		log.Printf("ollama extract error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	var result extractResult
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		log.Printf("parse extract response for item %d: %v (raw: %s)", item.ID, err, resp)
		db.MarkFailed(w.queueDB, item.ID, fmt.Sprintf("parse: %v", err))
		return
	}

	// Check for missing required fields
	hasMissing := len(result.Missing) > 0

	// Also check recipe required fields if we have a recipe
	if recipe != nil && !hasMissing {
		for _, v := range recipe.Values {
			if !v.Required {
				continue
			}
			found := false
			for _, rv := range result.Values {
				if rv.Key == v.MasterKey {
					found = true
					break
				}
			}
			if !found {
				result.Missing = append(result.Missing, v.MasterKey)
				hasMissing = true
			}
		}
	}

	if hasMissing || result.Title == "" || result.Scope == "" {
		// Needs user input
		niResult := needsInputResult{
			Partial: result,
			Missing: result.Missing,
		}
		resultJSON, _ := json.Marshal(niResult)
		if err := db.SetQueueResult(w.queueDB, item.ID, "needs_input", string(resultJSON)); err != nil {
			log.Printf("set needs_input error for item %d: %v", item.ID, err)
		}
		w.hub.Broadcast(ws.Event{Type: "queue:needs_input", ID: fmt.Sprintf("%d", item.ID)})
		log.Printf("item %d needs_input, missing: %v", item.ID, result.Missing)
		return
	}

	// All good — create the record
	id, err := uuid.NewV7()
	if err != nil {
		log.Printf("uuid error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}
	idBytes, _ := id.MarshalBinary()

	var recipeU *string
	if recipe != nil {
		recipeU = &recipe.Usecase
	}

	record := &db.RecordFull{
		Record: db.Record{
			ID:     idBytes,
			Title:  result.Title,
			Detail: result.Detail,
			Status: result.Status,
			Scope:  result.Scope,
			Recipe: recipeU,
		},
		Tags:   result.Tags,
		Values: result.Values,
	}

	if err := db.InsertRecord(w.mainDB, record); err != nil {
		log.Printf("insert error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	// Store result for draft UI display
	resultJSON, _ := json.Marshal(result)
	if err := db.SetQueueResult(w.queueDB, item.ID, "done", string(resultJSON)); err != nil {
		log.Printf("set done error for item %d: %v", item.ID, err)
	}

	w.hub.Broadcast(ws.Event{
		Type: "record:created",
		ID:   fmt.Sprintf("%x", record.ID),
	})

	log.Printf("processed item %d -> record %x", item.ID, record.ID)
}
