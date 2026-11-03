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

const (
	pollInterval       = 500 * time.Millisecond
	summarizeThreshold = 250
)

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
	Title    string           `json:"tl"`
	Detail   *string          `json:"dt,omitempty"`
	Status   int              `json:"st"`
	Tags     []string         `json:"tags"`
	Values   []db.RecordValue `json:"values"`
	Missing  []string         `json:"missing,omitempty"`
	RecordID string           `json:"record_id,omitempty"`
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
		if rc.Example != "" {
			fmt.Fprintf(&recipeList, "  Examples: %s\n", rc.Example)
		}
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
		w.extractNoRecipe(item)
		return
	}

	// Parse hints from queue item
	hintTags, hintValues := parseHints(item)
	tags, _ := db.ListTagsWithScope(w.mainDB)

	// Long text → always use LLM to summarize
	if len(item.Payload) >= summarizeThreshold {
		w.doSummarize(item, recipe, tags, hintTags, hintValues)
		return
	}

	// Short text: check if all required tags+values are already provided
	missing := findMissing(recipe, tags, hintTags, hintValues)
	if len(missing) == 0 {
		// Everything provided — direct create, no LLM
		w.directCreate(item, recipe, hintTags, hintValues)
		return
	}

	// Short text with missing fields — LLM extracts only what's missing
	w.doPartialExtract(item, recipe, tags, hintTags, hintValues, missing)
}

func (w *Worker) extractNoRecipe(item *db.QueueItem) {
	hintTags, hintValues := parseHints(item)
	tags, _ := db.ListTagsWithScope(w.mainDB)

	if len(item.Payload) >= summarizeThreshold {
		w.doSummarize(item, nil, tags, hintTags, hintValues)
		return
	}

	// No recipe = no required fields to check, but still need title extraction if ambiguous
	// For short text without recipe, use text as title directly
	w.directCreate(item, nil, hintTags, hintValues)
}

// parseHints extracts hint tags and values from queue item JSON columns.
func parseHints(item *db.QueueItem) ([]string, []db.RecordValue) {
	var hintTags []string
	if item.HintTags != nil {
		json.Unmarshal([]byte(*item.HintTags), &hintTags)
	}
	var hintValues []db.RecordValue
	if item.HintValues != nil {
		json.Unmarshal([]byte(*item.HintValues), &hintValues)
	}
	return hintTags, hintValues
}

// findMissing checks recipe requirements against provided hints.
// Returns list of missing field descriptions.
func findMissing(recipe *db.RecipeFull, allTags []db.TagWithScope, hintTags []string, hintValues []db.RecordValue) []string {
	if recipe == nil {
		return nil
	}

	targetSt := recipe.DefaultStatus
	var missing []string

	// Check required values
	for _, rv := range recipe.Values {
		if !statusIn(rv.RequiredAt, targetSt) {
			continue
		}
		found := false
		for _, hv := range hintValues {
			if hv.Key == rv.MasterKey {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, rv.MasterKey)
		}
	}

	// Check required scopes — hint tags may be "scope:tag" or bare "tag"
	hintTagBare := make(map[string]bool)
	hintTagScoped := make(map[string]string) // scope → tag
	for _, ht := range hintTags {
		bare := bareTagName(ht)
		hintTagBare[bare] = true
		if idx := strings.LastIndex(ht, ":"); idx >= 0 {
			hintTagScoped[ht[:idx]] = bare
		} else {
			// Try to resolve scope from allTags
			for _, t := range allTags {
				if t.Name == bare && t.ScopeName != nil {
					hintTagScoped[*t.ScopeName] = bare
				}
			}
		}
	}

	for _, sc := range recipe.Scopes {
		if !sc.Required {
			continue
		}
		if _, ok := hintTagScoped[sc.ScopeName]; !ok {
			missing = append(missing, "tag:"+sc.ScopeName)
		}
	}

	return missing
}

// directCreate writes a record without calling LLM.
// Title = cleaned payload text, tags/values from hints.
func (w *Worker) directCreate(item *db.QueueItem, recipe *db.RecipeFull, hintTags []string, hintValues []db.RecordValue) {
	st := 3 // default done
	if recipe != nil {
		st = recipe.DefaultStatus
	}

	// Normalize tags to bare names for storage
	bareTags := make([]string, len(hintTags))
	for i, t := range hintTags {
		bareTags[i] = bareTagName(t)
	}

	result := extractResult{
		Title:  item.Payload,
		Status: st,
		Tags:   bareTags,
		Values: hintValues,
	}

	var recipeU *string
	if recipe != nil {
		recipeU = &recipe.Usecase
	}

	w.createRecord(item, result, recipeU)
}

// doSummarize calls LLM to summarize long text. Title = summary, detail = original.
func (w *Worker) doSummarize(item *db.QueueItem, recipe *db.RecipeFull, allTags []db.TagWithScope, hintTags []string, hintValues []db.RecordValue) {
	var ctx strings.Builder
	if recipe != nil {
		fmt.Fprintf(&ctx, "Recipe: %s — %s\n", recipe.Usecase, recipe.Description)
	}
	if len(allTags) > 0 {
		tagStrs := make([]string, len(allTags))
		for i, t := range allTags {
			tagStrs[i] = t.FormatTagHash()
		}
		fmt.Fprintf(&ctx, "Available tags: %s\n", strings.Join(tagStrs, ", "))
	}

	statusHint := "Default 3 for completed actions, 1 for future tasks."
	if recipe != nil {
		statusHint = fmt.Sprintf("Use %d (recipe default) unless text clearly indicates otherwise.", recipe.DefaultStatus)
	}

	prompt := fmt.Sprintf(`You are a data extraction assistant. The following text is long and needs summarization.

%s
Return JSON only with these fields:
- tl (string): short title/summary (max 80 chars)
- st (int): status 0=paused, 1=todo, 2=doing, 3=done. %s
- tags (string[]): tag names ONLY — no # prefix, no scope prefix
- values (object[]): each with "k" (value type key) and "v" (number)
- missing (string[]): list any REQUIRED fields you could not find

User text: %s`, ctx.String(), statusHint, item.Payload)

	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		log.Printf("ollama summarize error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	var result extractResult
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		log.Printf("parse summarize response for item %d: %v (raw: %s)", item.ID, err, resp)
		db.MarkFailed(w.queueDB, item.ID, fmt.Sprintf("parse: %v", err))
		return
	}

	// Set original text as detail
	detail := item.Payload
	result.Detail = &detail

	// Merge hints
	result.Tags = mergeTags(result.Tags, hintTags)
	result.Values = mergeValues(result.Values, hintValues)

	w.finalize(item, recipe, result, allTags)
}

// doPartialExtract calls LLM only to fill in missing tags/values.
func (w *Worker) doPartialExtract(item *db.QueueItem, recipe *db.RecipeFull, allTags []db.TagWithScope, hintTags []string, hintValues []db.RecordValue, missing []string) {
	masterVals, _ := db.ListMasterValues(w.mainDB)

	var ctx strings.Builder
	fmt.Fprintf(&ctx, "Recipe: %s — %s\n\n", recipe.Usecase, recipe.Description)

	// Only describe missing fields
	ctx.WriteString("Extract ONLY the following missing fields from the text:\n")
	for _, m := range missing {
		if strings.HasPrefix(m, "tag:") {
			scopeName := strings.TrimPrefix(m, "tag:")
			var scopeTags []string
			for _, t := range allTags {
				if t.ScopeName != nil && *t.ScopeName == scopeName {
					scopeTags = append(scopeTags, t.Name)
				}
			}
			fmt.Fprintf(&ctx, "- Tag from scope '%s' — choices: %s\n", scopeName, strings.Join(scopeTags, ", "))
		} else {
			desc := m
			for _, mv := range masterVals {
				if mv.Key == m {
					desc = fmt.Sprintf("%s (%s)", mv.Key, mv.Desc)
					break
				}
			}
			fmt.Fprintf(&ctx, "- Value: %s (number)\n", desc)
		}
	}

	prompt := fmt.Sprintf(`You are a data extraction assistant. Extract ONLY the specifically requested fields.

%s
Return JSON only with these fields:
- tags (string[]): tag names ONLY for the requested scopes — no # prefix, no scope prefix
- values (object[]): each with "k" (value type key) and "v" (number) — only for requested values
- missing (string[]): list any requested fields you could NOT find in the text

User text: %s`, ctx.String(), item.Payload)

	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		log.Printf("ollama partial-extract error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}

	var llmResult extractResult
	if err := json.Unmarshal([]byte(resp), &llmResult); err != nil {
		log.Printf("parse partial-extract response for item %d: %v (raw: %s)", item.ID, err, resp)
		db.MarkFailed(w.queueDB, item.ID, fmt.Sprintf("parse: %v", err))
		return
	}

	// Build full result: title from payload, merge all sources
	st := recipe.DefaultStatus
	allResultTags := mergeTags(llmResult.Tags, hintTags)
	allResultValues := mergeValues(llmResult.Values, hintValues)

	result := extractResult{
		Title:   item.Payload,
		Status:  st,
		Tags:    allResultTags,
		Values:  allResultValues,
		Missing: llmResult.Missing,
	}

	w.finalize(item, recipe, result, allTags)
}

// finalize checks for missing fields and either creates the record or marks needs_input.
func (w *Worker) finalize(item *db.QueueItem, recipe *db.RecipeFull, result extractResult, _ []db.TagWithScope) {
	// Strip scope prefixes from tags
	for i, t := range result.Tags {
		t = strings.TrimPrefix(t, "#")
		if idx := strings.LastIndex(t, ":"); idx >= 0 {
			t = t[idx+1:]
		}
		result.Tags[i] = t
	}

	hasMissing := len(result.Missing) > 0

	// Check recipe required fields
	if recipe != nil && !hasMissing {
		targetSt := recipe.DefaultStatus
		if result.Status > 0 {
			targetSt = result.Status
		}
		for _, v := range recipe.Values {
			if !statusIn(v.RequiredAt, targetSt) {
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

	if hasMissing || result.Title == "" {
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

	var recipeU *string
	if recipe != nil {
		recipeU = &recipe.Usecase
	}

	w.createRecord(item, result, recipeU)
}

// createRecord inserts a record into the main DB and marks the queue item done.
func (w *Worker) createRecord(item *db.QueueItem, result extractResult, recipeU *string) {
	id, err := uuid.NewV7()
	if err != nil {
		log.Printf("uuid error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}
	idBytes, _ := id.MarshalBinary()

	record := &db.RecordFull{
		Record: db.Record{
			ID:     idBytes,
			Title:  result.Title,
			Detail: result.Detail,
			Status: result.Status,
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

	result.RecordID = fmt.Sprintf("%x", record.ID)
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

// --- Helpers ---

// mergeTags combines LLM-extracted tags with hint tags, deduplicating by bare name.
func mergeTags(llmTags []string, hintTags []string) []string {
	if len(hintTags) == 0 {
		return llmTags
	}
	hintMap := make(map[string]string) // bareName → full hint string
	for _, h := range hintTags {
		hintMap[bareTagName(h)] = h
	}
	// Replace matching LLM tags with hint version
	for i, t := range llmTags {
		bare := bareTagName(strings.TrimPrefix(t, "#"))
		if h, ok := hintMap[bare]; ok {
			llmTags[i] = h
			delete(hintMap, bare)
		}
	}
	// Append remaining hints
	for _, h := range hintMap {
		llmTags = append(llmTags, h)
	}
	return llmTags
}

// mergeValues combines LLM-extracted values with hint values, hint wins on conflict.
func mergeValues(llmValues []db.RecordValue, hintValues []db.RecordValue) []db.RecordValue {
	if len(hintValues) == 0 {
		return llmValues
	}
	hintMap := make(map[string]db.RecordValue)
	for _, hv := range hintValues {
		hintMap[hv.Key] = hv
	}
	for i, v := range llmValues {
		if hv, ok := hintMap[v.Key]; ok {
			llmValues[i] = hv
			delete(hintMap, v.Key)
		}
	}
	for _, hv := range hintMap {
		llmValues = append(llmValues, hv)
	}
	return llmValues
}

func bareTagName(t string) string {
	if idx := strings.LastIndex(t, ":"); idx >= 0 {
		return t[idx+1:]
	}
	return t
}

func statusIn(statuses []int, st int) bool {
	for _, s := range statuses {
		if s == st {
			return true
		}
	}
	return false
}
