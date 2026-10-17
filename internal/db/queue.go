package db

import (
	"database/sql"
	"fmt"
)

type QueueItem struct {
	ID        int    `json:"id"`
	Payload   string `json:"payload"`
	Source    string `json:"source"`
	Status    string `json:"status"`
	Attempts  int    `json:"attempts"`
	Error     *string `json:"error,omitempty"`
	CreatedAt string `json:"created_at"`
}

func Enqueue(db *sql.DB, payload, source string) (int64, error) {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ingest_queue WHERE status='pending'`).Scan(&count); err != nil {
		return 0, err
	}
	if count >= 1000 {
		return 0, fmt.Errorf("queue full")
	}

	res, err := db.Exec(
		`INSERT INTO ingest_queue (payload, source) VALUES (?, ?)`,
		payload, source,
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
		`SELECT id, payload, source, status, attempts, error, created_at
		 FROM ingest_queue
		 WHERE status='pending'
		 ORDER BY created_at
		 LIMIT 1`,
	).Scan(&item.ID, &item.Payload, &item.Source, &item.Status, &item.Attempts, &item.Error, &item.CreatedAt)
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
