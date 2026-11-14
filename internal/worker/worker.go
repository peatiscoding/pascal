package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
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
	shortTitleMaxWords = 5
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

// --- Extracted state: intermediate representation between phases ---

type extractedValue struct {
	Essential bool    // required by recipe at target status
	V         float64 // numeric value
}

type extractedScopeTags struct {
	Essential bool     // scope is required by recipe
	Tags      []string // tag slugs within this scope
}

type extractedState struct {
	Input    string                        // raw annotated text
	Recipe   *db.RecipeFull                // resolved recipe (may be nil)
	Status   int                           // target status
	Values   map[string]extractedValue     // value key → {essential, v}
	Tags     map[string]extractedScopeTags // scope name → {essential, [slugs]}
	FreeTags []string                      // unscoped tags
	Missing  []string                      // fields still missing after extraction
}

// --- Main pipeline ---

func (w *Worker) processNext() {
	item, err := db.DequeueNext(w.queueDB)
	if err != nil {
		log.Printf("dequeue error: %v", err)
		return
	}
	if item == nil {
		return
	}

	log.Printf("[item:%d] ── START ── source=%s payload=%q", item.ID, item.Source, item.Payload)

	// ── Phase 1a: Resolve recipe ──
	var recipeU string
	if item.RecipeU != nil && *item.RecipeU != "" {
		recipeU = *item.RecipeU
		log.Printf("[item:%d] 1a/RECIPE hint=%s", item.ID, recipeU)
	} else {
		log.Printf("[item:%d] 1a/RECIPE no hint, classifying via LLM", item.ID)
		resolved, ok := w.resolveRecipe(item)
		if !ok {
			log.Printf("[item:%d] 1a/RECIPE STOP (ambiguous or error)", item.ID)
			return
		}
		recipeU = resolved
		if recipeU == "" {
			log.Printf("[item:%d] 1a/RECIPE none matched, proceeding without", item.ID)
		} else {
			log.Printf("[item:%d] 1a/RECIPE resolved=%s", item.ID, recipeU)
		}
	}

	// ── Phase 1b+1c: Extract essential components ──
	log.Printf("[item:%d] 1b/EXTRACT building state", item.ID)
	state, err := w.buildExtractedState(item, recipeU)
	if err != nil {
		log.Printf("[item:%d] 1b/EXTRACT ERROR: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return
	}
	log.Printf("[item:%d] 1b/EXTRACT state: values=%v tags=%v free_tags=%v missing=%v",
		item.ID, stateValuesDebug(state), stateTagsDebug(state), state.FreeTags, state.Missing)

	// ── Phase 2: Title ──
	log.Printf("[item:%d] 2/TITLE generating", item.ID)
	allTags, _ := db.ListTagsWithScope(w.mainDB)
	tagLookup := buildTagLookup(allTags)
	title := w.generateTitle(item, state, tagLookup)
	log.Printf("[item:%d] 2/TITLE result=%q", item.ID, title)

	// ── Phase 3: Description ──
	log.Printf("[item:%d] 3/DESC generating", item.ID)
	detail := w.generateDescription(item, state, tagLookup)
	if detail != nil {
		log.Printf("[item:%d] 3/DESC result=%q", item.ID, *detail)
	} else {
		log.Printf("[item:%d] 3/DESC result=nil", item.ID)
	}

	// Check for missing required fields → needs_input draft with title preview
	if len(state.Missing) > 0 {
		result := stateToResult(state, title, detail)
		log.Printf("[item:%d] ── NEEDS_INPUT ── missing=%v", item.ID, state.Missing)
		w.markNeedsInput(item, state, result)
		return
	}

	// Finalize: check requirements and create record
	result := stateToResult(state, title, detail)
	log.Printf("[item:%d] ── FINALIZE ──", item.ID)
	w.finalize(item, state.Recipe, result)
}

// resolveRecipe uses LLM to classify text against available recipes.
// Returns (recipeU, true) on success, ("", true) for no-recipe processing,
// or ("", false) if processing should stop (ambiguous/error).
func (w *Worker) resolveRecipe(item *db.QueueItem) (string, bool) {
	recipes, err := db.ListRecipesFull(w.mainDB)
	if err != nil {
		log.Printf("list recipes error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return "", false
	}

	if len(recipes) == 0 {
		return "", true // no recipes in system — proceed without
	}

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

	log.Printf("[LLM:match] item %d prompt:\n%s", item.ID, prompt)
	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		log.Printf("ollama match error for item %d: %v", item.ID, err)
		db.MarkFailed(w.queueDB, item.ID, err.Error())
		return "", false
	}
	log.Printf("[LLM:match] item %d response: %s", item.ID, resp)

	var result matchResult
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		log.Printf("parse match response for item %d: %v (raw: %s)", item.ID, err, resp)
		return "", true // garbage response — proceed without recipe
	}

	switch len(result.Matches) {
	case 0:
		return "", true
	case 1:
		return result.Matches[0], true
	default:
		resultJSON, _ := json.Marshal(result)
		if err := db.SetQueueResult(w.queueDB, item.ID, "ambiguous", string(resultJSON)); err != nil {
			log.Printf("set ambiguous error for item %d: %v", item.ID, err)
		}
		w.hub.Broadcast(ws.Event{Type: "queue:ambiguous", ID: fmt.Sprintf("%d", item.ID)})
		log.Printf("item %d ambiguous: %v", item.ID, result.Matches)
		return "", false
	}
}

// buildExtractedState creates the intermediate extracted state from hints + optional LLM extraction.
func (w *Worker) buildExtractedState(item *db.QueueItem, recipeU string) (*extractedState, error) {
	hintTags, hintValues := parseHints(item)
	allTags, _ := db.ListTagsWithScope(w.mainDB)

	// Resolve recipe
	var recipe *db.RecipeFull
	if recipeU != "" {
		r, err := db.GetRecipe(w.mainDB, recipeU)
		if err != nil {
			log.Printf("get recipe %s for item %d: %v", recipeU, item.ID, err)
			// Continue without recipe
		} else {
			recipe = r
		}
	}

	st := 3 // default done
	if recipe != nil {
		st = recipe.DefaultStatus
	}

	state := &extractedState{
		Input:  item.Payload,
		Recipe: recipe,
		Status: st,
		Values: make(map[string]extractedValue),
		Tags:   make(map[string]extractedScopeTags),
	}

	// Populate from hints
	for _, hv := range hintValues {
		state.Values[hv.Key] = extractedValue{V: hv.Value}
	}

	// Resolve hint tags into scoped/unscoped buckets
	for _, ht := range hintTags {
		bare := bareTagName(ht)
		if idx := strings.LastIndex(ht, ":"); idx >= 0 {
			scopeName := ht[:idx]
			entry := state.Tags[scopeName]
			entry.Tags = append(entry.Tags, bare)
			state.Tags[scopeName] = entry
		} else {
			// Try to resolve scope from allTags
			resolved := false
			for _, t := range allTags {
				if t.Name == bare && t.ScopeName != nil {
					entry := state.Tags[*t.ScopeName]
					entry.Tags = append(entry.Tags, bare)
					state.Tags[*t.ScopeName] = entry
					resolved = true
					break
				}
			}
			if !resolved {
				state.FreeTags = append(state.FreeTags, bare)
			}
		}
	}

	// Mark essentials based on recipe requirements
	w.markEssentials(state)

	// Find missing required fields
	missing := findMissing(recipe, allTags, hintTags, hintValues)
	if len(missing) == 0 {
		return state, nil
	}

	// Try LLM extraction for missing fields
	llmResult, err := w.llmExtractMissing(item, recipe, allTags, missing)
	if err != nil {
		// LLM failed — report what's missing
		state.Missing = missing
		return state, nil
	}

	// Merge LLM results into state (hints take precedence)
	for _, lv := range llmResult.Values {
		if _, exists := state.Values[lv.Key]; !exists {
			state.Values[lv.Key] = extractedValue{V: lv.Value}
		}
	}
	for _, lt := range llmResult.Tags {
		lt = strings.TrimPrefix(lt, "#")
		bare := bareTagName(lt)
		// Resolve scope for LLM-extracted tags
		for _, t := range allTags {
			if t.Name == bare && t.ScopeName != nil {
				entry := state.Tags[*t.ScopeName]
				// Don't duplicate
				found := false
				for _, existing := range entry.Tags {
					if existing == bare {
						found = true
						break
					}
				}
				if !found {
					entry.Tags = append(entry.Tags, bare)
					state.Tags[*t.ScopeName] = entry
				}
				break
			}
		}
	}

	// Re-mark essentials after merge
	w.markEssentials(state)

	// Re-check missing after LLM extraction
	state.Missing = recheckMissing(state)

	return state, nil
}

// markEssentials flags values and scoped tags as essential if required by recipe.
func (w *Worker) markEssentials(state *extractedState) {
	if state.Recipe == nil {
		return
	}

	// Mark essential values
	for _, rv := range state.Recipe.Values {
		if !statusIn(rv.RequiredAt, state.Status) {
			continue
		}
		if ev, ok := state.Values[rv.MasterKey]; ok {
			ev.Essential = true
			state.Values[rv.MasterKey] = ev
		}
	}

	// Mark essential scopes
	for _, sc := range state.Recipe.Scopes {
		if !sc.Required {
			continue
		}
		if entry, ok := state.Tags[sc.ScopeName]; ok {
			entry.Essential = true
			state.Tags[sc.ScopeName] = entry
		}
	}
}

// recheckMissing verifies recipe requirements against current state.
func recheckMissing(state *extractedState) []string {
	if state.Recipe == nil {
		return nil
	}

	var missing []string

	for _, rv := range state.Recipe.Values {
		if !statusIn(rv.RequiredAt, state.Status) {
			continue
		}
		if _, ok := state.Values[rv.MasterKey]; !ok {
			missing = append(missing, rv.MasterKey)
		}
	}

	for _, sc := range state.Recipe.Scopes {
		if !sc.Required {
			continue
		}
		if entry, ok := state.Tags[sc.ScopeName]; !ok || len(entry.Tags) == 0 {
			missing = append(missing, "tag:"+sc.ScopeName)
		}
	}

	return missing
}

// llmExtractMissing calls Ollama to extract only the missing required fields.
func (w *Worker) llmExtractMissing(item *db.QueueItem, recipe *db.RecipeFull, allTags []db.TagWithScope, missing []string) (*extractResult, error) {
	masterVals, _ := db.ListMasterValues(w.mainDB)

	var ctx strings.Builder
	if recipe != nil {
		fmt.Fprintf(&ctx, "Recipe: %s — %s\n\n", recipe.Usecase, recipe.Description)
	}

	// Build structured extraction instructions per missing field
	var valueMissing []string
	var tagMissing []string
	for _, m := range missing {
		if strings.HasPrefix(m, "tag:") {
			scopeName := strings.TrimPrefix(m, "tag:")
			var scopeTags []string
			for _, t := range allTags {
				if t.ScopeName != nil && *t.ScopeName == scopeName {
					if t.Desc != "" {
						scopeTags = append(scopeTags, fmt.Sprintf("%s (%s)", t.Name, t.Desc))
					} else {
						scopeTags = append(scopeTags, t.Name)
					}
				}
			}
			tagMissing = append(tagMissing, fmt.Sprintf("scope '%s': pick ONE of [%s]. Return ONLY the slug (e.g. \"prime\", not \"SCB Prime\")", scopeName, strings.Join(scopeTags, ", ")))
		} else {
			desc := m
			for _, mv := range masterVals {
				if mv.Key == m {
					desc = fmt.Sprintf("%s = %s", mv.Key, mv.Desc)
					break
				}
			}
			valueMissing = append(valueMissing, fmt.Sprintf("key \"%s\": %s — extract the numeric amount", m, desc))
		}
	}

	if len(valueMissing) > 0 {
		ctx.WriteString("Required numeric values to extract:\n")
		for _, v := range valueMissing {
			fmt.Fprintf(&ctx, "  - %s\n", v)
		}
	}
	if len(tagMissing) > 0 {
		ctx.WriteString("Required tags to extract:\n")
		for _, t := range tagMissing {
			fmt.Fprintf(&ctx, "  - %s\n", t)
		}
	}

	prompt := fmt.Sprintf(`You are a data extraction assistant.

%s
From the user text below, extract ONLY the requested fields. Return JSON:
{
  "values": [{"k": "<exact key name from list above>", "v": <number>}],
  "tags": ["<tag name>"],
  "missing": ["<key or tag:scope for anything NOT found>"]
}

Rules:
- For values: "k" MUST be the exact key name listed above (e.g. "spent", "token"). Do NOT invent keys.
- For tags: return ONLY the tag name, no # prefix, no scope prefix.
- Do NOT extract fields that were not requested.

User text: %s`, ctx.String(), item.Payload)

	log.Printf("[LLM:extract] item %d prompt:\n%s", item.ID, prompt)
	resp, err := w.ollama.Generate(prompt)
	if err != nil {
		return nil, fmt.Errorf("ollama extract: %w", err)
	}
	log.Printf("[LLM:extract] item %d response: %s", item.ID, resp)

	var result extractResult
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		return nil, fmt.Errorf("parse extract response: %w (raw: %s)", err, resp)
	}

	return &result, nil
}

// --- Phase 2: Title generation ---

// generateTitle produces a title by stripping essential annotations and replacing the rest
// with readable text, then optionally summarizing via LLM.
func (w *Worker) generateTitle(item *db.QueueItem, state *extractedState, tagLookup map[string]db.TagWithScope) string {
	text := state.Input

	// For long text, use LLM to summarize
	if len(text) >= summarizeThreshold {
		return w.llmSummarizeTitle(text, state, tagLookup)
	}

	// Strip essential annotations from text
	text = stripEssentialAnnotations(text, state)

	// Replace remaining annotations with readable text
	text = replaceAnnotationsReadable(text, tagLookup)

	// Clean up whitespace
	text = normalizeWhitespace(text)

	if text == "" {
		if state.Recipe != nil {
			return state.Recipe.Description
		}
		return state.Input
	}

	// Short text (≤5 words): use as-is
	if wordCount(text) <= shortTitleMaxWords {
		return text
	}

	// Longer text: LLM summarize
	return w.llmSummarizeTitle(text, state, tagLookup)
}

// llmSummarizeTitle calls Ollama to generate a short title.
func (w *Worker) llmSummarizeTitle(text string, state *extractedState, tagLookup map[string]db.TagWithScope) string {
	// For long text, first strip essentials and replace annotations
	cleaned := stripEssentialAnnotations(text, state)
	cleaned = replaceAnnotationsReadable(cleaned, tagLookup)
	cleaned = normalizeWhitespace(cleaned)

	if cleaned == "" {
		if state.Recipe != nil {
			return state.Recipe.Description
		}
		return text
	}

	var recipeCtx string
	if state.Recipe != nil {
		recipeCtx = fmt.Sprintf("Context: this is a '%s' record (%s).\n", state.Recipe.Usecase, state.Recipe.Description)
	}

	// Build list of essential fields to omit from title
	var omit []string
	for k, ev := range state.Values {
		if ev.Essential {
			omit = append(omit, fmt.Sprintf("%s (%.0f)", k, ev.V))
		}
	}
	for scope, entry := range state.Tags {
		if entry.Essential {
			for _, slug := range entry.Tags {
				if t, ok := tagLookup[slug]; ok && t.Desc != "" {
					omit = append(omit, fmt.Sprintf("%s/%s (%s)", scope, slug, t.Desc))
				} else {
					omit = append(omit, fmt.Sprintf("%s/%s", scope, slug))
				}
			}
		}
	}

	var omitCtx string
	if len(omit) > 0 {
		omitCtx = fmt.Sprintf(`The following info is ALREADY shown elsewhere in the UI — strip ALL references to them (amounts, numbers, names, abbreviations, anything related):
%s
Keep ONLY the core activity/event. Example: "lunch with keith at sushiro paid 495 THB with SCB Prime" → "Lunch with Keith at Sushiro"
`, strings.Join(omit, "\n"))
	}

	prompt := fmt.Sprintf(`Extract the core activity from the text as a short title (max 80 chars). Return JSON only: {"tl": "the title"}

%s%s
Text: %s`, recipeCtx, omitCtx, cleaned)

	log.Printf("[LLM:title] prompt:\n%s", prompt)
	resp, err := w.ollama.Generate(prompt)
	log.Printf("[LLM:title] response: %s", resp)
	if err != nil {
		log.Printf("ollama title error: %v", err)
		// Fallback: truncate cleaned text
		if len(cleaned) > 80 {
			return cleaned[:77] + "..."
		}
		return cleaned
	}

	var result struct {
		Title string `json:"tl"`
	}
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		log.Printf("parse title response: %v (raw: %s)", err, resp)
		if len(cleaned) > 80 {
			return cleaned[:77] + "..."
		}
		return cleaned
	}

	if result.Title == "" {
		return cleaned
	}
	return result.Title
}

// --- Phase 3: Description generation ---

// generateDescription produces a description by replacing ALL annotations with readable text.
// For short text, returns as-is. For long text, stores original.
func (w *Worker) generateDescription(item *db.QueueItem, state *extractedState, tagLookup map[string]db.TagWithScope) *string {
	text := state.Input

	// Long text: store original as detail (existing behavior)
	if len(text) >= summarizeThreshold {
		return &text
	}

	// Replace ALL annotations (including essentials) with readable text
	desc := replaceAnnotationsReadable(text, tagLookup)
	desc = normalizeWhitespace(desc)

	if desc == "" {
		return nil
	}

	return &desc
}

// --- Finalize and create record ---

// finalize checks for missing fields and either creates the record or marks needs_input.
func (w *Worker) finalize(item *db.QueueItem, recipe *db.RecipeFull, result extractResult) {
	// Strip # prefix but keep scope:tag format for insertTagsExclusive
	for i, t := range result.Tags {
		result.Tags[i] = strings.TrimPrefix(t, "#")
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

func (w *Worker) markNeedsInput(item *db.QueueItem, state *extractedState, result extractResult) {
	niResult := needsInputResult{
		Partial: result,
		Missing: state.Missing,
	}
	resultJSON, _ := json.Marshal(niResult)
	if err := db.SetQueueResult(w.queueDB, item.ID, "needs_input", string(resultJSON)); err != nil {
		log.Printf("set needs_input error for item %d: %v", item.ID, err)
	}
	w.hub.Broadcast(ws.Event{Type: "queue:needs_input", ID: fmt.Sprintf("%d", item.ID)})
	log.Printf("item %d needs_input, missing: %v", item.ID, state.Missing)
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

// --- Annotation processing ---

var reTagCapture = regexp.MustCompile(`#([a-zA-Z0-9_-]*:)?([a-zA-Z0-9_-]+)`)
var reValueCapture = regexp.MustCompile(`@([a-zA-Z0-9_-]+)\(([^)]*)\)`)
var reTag = regexp.MustCompile(`#[a-zA-Z0-9_:-]+\s*`)
var reValueFull = regexp.MustCompile(`@[a-zA-Z0-9_-]+\([^)]*\)\s*`)
var reValueBare = regexp.MustCompile(`@[a-zA-Z0-9_-]*\s*`)

// stripEssentialAnnotations removes annotations for essential (recipe-required) values and tags.
func stripEssentialAnnotations(text string, state *extractedState) string {
	// Strip essential value annotations: @key(v) where key is essential
	text = reValueCapture.ReplaceAllStringFunc(text, func(match string) string {
		sub := reValueCapture.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		key := sub[1]
		if ev, ok := state.Values[key]; ok && ev.Essential {
			return "" // strip essential
		}
		return match
	})

	// Strip essential tag annotations: #scope:tag where scope is essential
	text = reTagCapture.ReplaceAllStringFunc(text, func(match string) string {
		sub := reTagCapture.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		scopePart := strings.TrimSuffix(sub[1], ":")
		if scopePart != "" {
			if entry, ok := state.Tags[scopePart]; ok && entry.Essential {
				return "" // strip essential scoped tag
			}
		}
		return match
	})

	return text
}

// replaceAnnotationsReadable replaces remaining annotation tokens with human-readable text.
// @key(v) → "key v", #scope:tag → tag display name, #tag → tag display name
func replaceAnnotationsReadable(text string, tagLookup map[string]db.TagWithScope) string {
	// Replace @key(v) → "key v"
	text = reValueCapture.ReplaceAllStringFunc(text, func(match string) string {
		sub := reValueCapture.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		return sub[1] + " " + sub[2]
	})

	// Replace #scope:tag or #tag → display name
	text = reTagCapture.ReplaceAllStringFunc(text, func(match string) string {
		sub := reTagCapture.FindStringSubmatch(match)
		if len(sub) < 3 {
			return match
		}
		tagSlug := sub[2]
		if t, ok := tagLookup[tagSlug]; ok {
			return t.DisplayName()
		}
		return tagSlug
	})

	// Clean bare @key (no parens)
	text = reValueBare.ReplaceAllString(text, "")

	return text
}

// --- Helpers ---

// stateToResult converts extractedState into extractResult for storage.
func stateToResult(state *extractedState, title string, detail *string) extractResult {
	var tags []string
	for scope, entry := range state.Tags {
		for _, slug := range entry.Tags {
			tags = append(tags, scope+":"+slug) // preserve scope:tag for insertTagsExclusive
		}
	}
	tags = append(tags, state.FreeTags...)

	var values []db.RecordValue
	for k, ev := range state.Values {
		values = append(values, db.RecordValue{Key: k, Value: ev.V})
	}

	return extractResult{
		Title:   title,
		Detail:  detail,
		Status:  state.Status,
		Tags:    tags,
		Values:  values,
		Missing: state.Missing,
	}
}

// buildTagLookup creates a map from tag slug → TagWithScope for display name resolution.
func buildTagLookup(tags []db.TagWithScope) map[string]db.TagWithScope {
	m := make(map[string]db.TagWithScope, len(tags))
	for _, t := range tags {
		m[t.Name] = t
	}
	return m
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
func findMissing(recipe *db.RecipeFull, allTags []db.TagWithScope, hintTags []string, hintValues []db.RecordValue) []string {
	if recipe == nil {
		return nil
	}

	targetSt := recipe.DefaultStatus
	var missing []string

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

	hintTagScoped := make(map[string]string)
	for _, ht := range hintTags {
		bare := bareTagName(ht)
		if idx := strings.LastIndex(ht, ":"); idx >= 0 {
			hintTagScoped[ht[:idx]] = bare
		} else {
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

// mergeTags combines LLM-extracted tags with hint tags, deduplicating by bare name.
func mergeTags(llmTags []string, hintTags []string) []string {
	if len(hintTags) == 0 {
		return llmTags
	}
	hintMap := make(map[string]string)
	for _, h := range hintTags {
		hintMap[bareTagName(h)] = h
	}
	for i, t := range llmTags {
		bare := bareTagName(strings.TrimPrefix(t, "#"))
		if h, ok := hintMap[bare]; ok {
			llmTags[i] = h
			delete(hintMap, bare)
		}
	}
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

func wordCount(s string) int {
	return len(strings.Fields(s))
}

func normalizeWhitespace(s string) string {
	fields := strings.Fields(s)
	return strings.Join(fields, " ")
}

func stateValuesDebug(s *extractedState) string {
	var parts []string
	for k, ev := range s.Values {
		ess := ""
		if ev.Essential {
			ess = "*"
		}
		parts = append(parts, fmt.Sprintf("%s%s=%.2f", k, ess, ev.V))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func stateTagsDebug(s *extractedState) string {
	var parts []string
	for scope, entry := range s.Tags {
		ess := ""
		if entry.Essential {
			ess = "*"
		}
		parts = append(parts, fmt.Sprintf("%s%s=[%s]", scope, ess, strings.Join(entry.Tags, ",")))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
