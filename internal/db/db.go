package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed migrations
var migrations embed.FS

// Open opens a SQLite database with WAL mode and foreign keys enabled.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("wal mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("foreign keys: %w", err)
	}
	return db, nil
}

// Migrate runs embedded SQL migration files against db.
// migrationFiles is a list of filenames (e.g. "001_init.sql") to apply.
func Migrate(db *sql.DB, files ...string) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS _migrations (
		filename TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	if len(files) == 0 {
		entries, err := fs.ReadDir(migrations, "migrations")
		if err != nil {
			return fmt.Errorf("read migrations dir: %w", err)
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
				files = append(files, e.Name())
			}
		}
		sort.Strings(files)
	}

	for _, name := range files {
		var applied int
		err := db.QueryRow("SELECT COUNT(*) FROM _migrations WHERE filename=?", name).Scan(&applied)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if applied > 0 {
			continue
		}

		content, err := fs.ReadFile(migrations, "migrations/"+name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("begin tx for %s: %w", name, err)
		}
		if _, err := tx.Exec(string(content)); err != nil {
			tx.Rollback()
			return fmt.Errorf("exec migration %s: %w", name, err)
		}
		if _, err := tx.Exec("INSERT INTO _migrations (filename) VALUES (?)", name); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}
