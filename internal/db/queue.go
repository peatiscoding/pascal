package db

import (
	"database/sql"
	"fmt"
)

type QueueItem struct {
	ID          int     `json:"id"`
	Payload     string  `json:"payload"`
	Source      string  `json:"source"`
	RecipeU     *string `json:"recipe_u,omitempty"`
	HintTags    *string `json:"hint_tags,omitempty"`
	HintValues  *string `json:"hint_values,omitempty"`
	Result      *string `json:"result,omitempty"`
	Status      string  `json:"status"`
	Attempts    int     `json:"attempts"`
	Error       *string `json:"error,omitempty"`
	CreatedAt   string  `json:"created_at"`
	ProcessedAt *string `json:"processed_at,omitempty"`
}

func GetQueueItem(db *sql.DB, id int) (*QueueItem, error) {
	item := &QueueItem{}
	err := db.QueryRow(
		`SELECT id, payload, source, recipe_u, hint_tags, hint_values, result, status, attempts, error, created_at, processed_at
		 FROM ingest_queue WHERE id=?`, id,
	).Scan(&item.ID, &item.Payload, &item.Source, &item.RecipeU, &item.HintTags, &item.HintValues, &item.Result, &item.Status, &item.Attempts, &item.Error, &item.CreatedAt, &item.ProcessedAt)
	if err != nil {
		return nil, err
	}
	return item, nil
}

func ListActiveQueue(db *sql.DB) ([]QueueItem, error) {
	rows, err := db.Query(
		`SELECT id, payload, source, recipe_u, hint_tags, hint_values, result, status, attempts, error, created_at, processed_at
		 FROM ingest_queue WHERE status IN ('pending','processing','needs_input','ambiguous')
		 ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []QueueItem
	for rows.Next() {
		var item QueueItem
		if err := rows.Scan(&item.ID, &item.Payload, &item.Source, &item.RecipeU, &item.HintTags, &item.HintValues, &item.Result, &item.Status, &item.Attempts, &item.Error, &item.CreatedAt, &item.ProcessedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func Enqueue(db *sql.DB, payload, source string, recipeU *string, hintTags *string, hintValues *string) (int64, error) {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ingest_queue WHERE status='pending'`).Scan(&count); err != nil {
		return 0, err
	}
	if count >= 1000 {
		return 0, fmt.Errorf("queue full")
	}

	res, err := db.Exec(
		`INSERT INTO ingest_queue (payload, source, recipe_u, hint_tags, hint_values) VALUES (?, ?, ?, ?, ?)`,
		payload, source, recipeU, hintTags, hintValues,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func DequeueNext(db *sql.DB) (*QueueItem, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	item := &QueueItem{}
	err = tx.QueryRow(
		`SELECT id, payload, source, recipe_u, hint_tags, hint_values, result, status, attempts, error, created_at
		 FROM ingest_queue
		 WHERE status='pending'
		 ORDER BY created_at
		 LIMIT 1`,
	).Scan(&item.ID, &item.Payload, &item.Source, &item.RecipeU, &item.HintTags, &item.HintValues, &item.Result, &item.Status, &item.Attempts, &item.Error, &item.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(`UPDATE ingest_queue SET status='processing' WHERE id=?`, item.ID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	item.Status = "processing"
	return item, nil
}

func MarkDone(db *sql.DB, id int) error {
	_, err := db.Exec(
		`UPDATE ingest_queue SET status='done', processed_at=datetime('now') WHERE id=?`, id,
	)
	return err
}

func MarkFailed(db *sql.DB, id int, errMsg string) error {
	_, err := db.Exec(
		`UPDATE ingest_queue SET
			status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'pending' END,
			attempts = attempts + 1,
			error = ?
		 WHERE id = ?`,
		errMsg, id,
	)
	return err
}

// SetQueueResult sets a queue item's status and result JSON in one update.
func SetQueueResult(db *sql.DB, id int, status, result string) error {
	_, err := db.Exec(
		`UPDATE ingest_queue SET status=?, result=?, processed_at=datetime('now') WHERE id=?`,
		status, result, id,
	)
	return err
}

// Master data query helpers used by the worker for prompt context.

type TagWithScope struct {
	Name      string
	Desc      string  // tag.d — display name / description
	ScopeName *string
}

func ListTagsWithScope(db *sql.DB) ([]TagWithScope, error) {
	rows, err := db.Query(`SELECT t.t, t.d, s.name FROM tag t LEFT JOIN scope s ON t.s = s.id ORDER BY t.t`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []TagWithScope
	for rows.Next() {
		var t TagWithScope
		if err := rows.Scan(&t.Name, &t.Desc, &t.ScopeName); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

// DisplayName returns tag.d if non-empty, otherwise the slug.
func (t TagWithScope) DisplayName() string {
	if t.Desc != "" {
		return t.Desc
	}
	return t.Name
}

// FormatTagHash returns #tag or #scope:tag for prompt display.
func (t TagWithScope) FormatTagHash() string {
	if t.ScopeName != nil {
		return "#" + *t.ScopeName + ":" + t.Name
	}
	return "#" + t.Name
}

func ListScopeNames(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT name FROM scope ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, nil
}

type MasterValue struct {
	Key  string
	Desc string
}

func ListMasterValues(db *sql.DB) ([]MasterValue, error) {
	rows, err := db.Query(`SELECT k, d FROM master_value ORDER BY k`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var vals []MasterValue
	for rows.Next() {
		var v MasterValue
		if err := rows.Scan(&v.Key, &v.Desc); err != nil {
			return nil, err
		}
		vals = append(vals, v)
	}
	return vals, nil
}
