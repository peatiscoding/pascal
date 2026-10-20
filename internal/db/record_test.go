package db

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func setupTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatalf("fk: %v", err)
	}

	// Apply migrations inline (same as 001_init + 003_drop_cg + 004_tag_scope)
	schema := `
		CREATE TABLE scope (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			parent_id INTEGER REFERENCES scope(id),
			UNIQUE(name, parent_id)
		);
		CREATE TABLE tag (
			t TEXT PRIMARY KEY,
			s INTEGER REFERENCES scope(id),
			d TEXT NOT NULL
		);
		CREATE TABLE master_value (
			k TEXT PRIMARY KEY,
			d TEXT NOT NULL
		);
		CREATE TABLE recipe (
			u TEXT PRIMARY KEY,
			d TEXT NOT NULL
		);
		CREATE TABLE record (
			id BLOB PRIMARY KEY,
			tl TEXT NOT NULL,
			dt TEXT,
			st INTEGER NOT NULL DEFAULT 1,
			ct TEXT NOT NULL DEFAULT (datetime('now')),
			sc TEXT NOT NULL,
			r TEXT REFERENCES recipe(u)
		);
		CREATE TABLE record_tags (
			record_id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
			tag TEXT NOT NULL REFERENCES tag(t),
			PRIMARY KEY (record_id, tag)
		);
		CREATE TABLE record_values (
			id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
			k TEXT NOT NULL REFERENCES master_value(k),
			v REAL NOT NULL,
			PRIMARY KEY (id, k)
		);
		CREATE TABLE record_log (
			id BLOB NOT NULL REFERENCES record(id) ON DELETE CASCADE,
			sst INTEGER NOT NULL,
			inf TEXT NOT NULL DEFAULT '',
			at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func seedScopes(t *testing.T, db *sql.DB) {
	t.Helper()
	// scope 1: "type" (acts as exclusive group)
	// scope 2: "priority"
	db.Exec(`INSERT INTO scope (id, name) VALUES (1, 'type')`)
	db.Exec(`INSERT INTO scope (id, name) VALUES (2, 'priority')`)
}

func seedTags(t *testing.T, db *sql.DB) {
	t.Helper()
	// Tags under scope "type" (exclusive)
	db.Exec(`INSERT INTO tag (t, s, d) VALUES ('expense', 1, 'expense record')`)
	db.Exec(`INSERT INTO tag (t, s, d) VALUES ('workout', 1, 'workout record')`)
	// Tags under scope "priority" (exclusive)
	db.Exec(`INSERT INTO tag (t, s, d) VALUES ('high', 2, 'high priority')`)
	db.Exec(`INSERT INTO tag (t, s, d) VALUES ('low', 2, 'low priority')`)
	// Free tags (no scope)
	db.Exec(`INSERT INTO tag (t, d) VALUES ('urgent', 'needs attention')`)
	db.Exec(`INSERT INTO tag (t, d) VALUES ('review', 'needs review')`)
}

func seedValues(t *testing.T, db *sql.DB) {
	t.Helper()
	db.Exec(`INSERT INTO master_value (k, d) VALUES ('THB', 'Thai Baht')`)
}

func makeID(b byte) []byte {
	id := make([]byte, 16)
	id[0] = b
	return id
}

func TestInsertRecord_FreeTags(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)

	rec := &RecordFull{
		Record: Record{ID: makeID(1), Title: "test", Status: 1, Scope: "Work"},
		Tags:   []string{"urgent", "review"}, // both free, should work
	}
	if err := InsertRecord(db, rec); err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

func TestInsertRecord_ScopedTags_OnePerScope(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)

	// One tag per scope group — should work
	rec := &RecordFull{
		Record: Record{ID: makeID(2), Title: "test", Status: 1, Scope: "Work"},
		Tags:   []string{"expense", "high"}, // different scopes
	}
	if err := InsertRecord(db, rec); err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

func TestInsertRecord_ScopedTags_Conflict(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)

	// Two tags from same scope "type" — should fail
	rec := &RecordFull{
		Record: Record{ID: makeID(3), Title: "test", Status: 1, Scope: "Work"},
		Tags:   []string{"expense", "workout"}, // both scope 1
	}
	err := InsertRecord(db, rec)
	if err == nil {
		t.Fatal("expected conflict error, got nil")
	}
	if got := err.Error(); !contains(got, "tag conflict") {
		t.Fatalf("expected 'tag conflict' error, got: %s", got)
	}
}

func TestInsertRecord_MixedTags_ConflictInScope(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)

	// Mix of free + scoped, but two from same scope
	rec := &RecordFull{
		Record: Record{ID: makeID(4), Title: "test", Status: 1, Scope: "Work"},
		Tags:   []string{"urgent", "high", "low"}, // high+low both scope 2
	}
	err := InsertRecord(db, rec)
	if err == nil {
		t.Fatal("expected conflict error, got nil")
	}
	if got := err.Error(); !contains(got, "tag conflict") {
		t.Fatalf("expected 'tag conflict' error, got: %s", got)
	}
}

func TestInsertRecord_MixedTags_NoConflict(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)
	seedValues(t, db)

	// Free tags + one per scope — should work
	rec := &RecordFull{
		Record: Record{ID: makeID(5), Title: "test", Status: 1, Scope: "Work"},
		Tags:   []string{"urgent", "review", "expense", "high"},
		Values: []RecordValue{{Key: "THB", Value: 100}},
	}
	if err := InsertRecord(db, rec); err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}

	// Verify record was created with all tags
	full, err := GetRecord(db, makeID(5))
	if err != nil {
		t.Fatalf("get record: %v", err)
	}
	if len(full.Tags) != 4 {
		t.Fatalf("expected 4 tags, got %d", len(full.Tags))
	}
	if len(full.Values) != 1 {
		t.Fatalf("expected 1 value, got %d", len(full.Values))
	}
	if full.Values[0].Value != 100 {
		t.Fatalf("expected value 100, got %f", full.Values[0].Value)
	}
}

func TestInsertRecord_NoTags(t *testing.T) {
	db := setupTestDB(t)

	rec := &RecordFull{
		Record: Record{ID: makeID(6), Title: "no tags", Status: 1, Scope: "Personal"},
	}
	if err := InsertRecord(db, rec); err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

func TestDeleteRecord(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)

	rec := &RecordFull{
		Record: Record{ID: makeID(7), Title: "to delete", Status: 1, Scope: "Work"},
		Tags:   []string{"urgent"},
	}
	if err := InsertRecord(db, rec); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := DeleteRecord(db, makeID(7)); err != nil {
		t.Fatalf("delete: %v", err)
	}
	_, err := GetRecord(db, makeID(7))
	if err == nil {
		t.Fatal("expected not found after delete")
	}
}

func TestTagInUse(t *testing.T) {
	db := setupTestDB(t)
	seedScopes(t, db)
	seedTags(t, db)

	// No records yet
	used, err := TagInUse(db, "urgent")
	if err != nil {
		t.Fatalf("tag in use: %v", err)
	}
	if used {
		t.Fatal("expected not in use")
	}

	// Add record with tag
	rec := &RecordFull{
		Record: Record{ID: makeID(8), Title: "test", Status: 1, Scope: "Work"},
		Tags:   []string{"urgent"},
	}
	InsertRecord(db, rec)

	used, err = TagInUse(db, "urgent")
	if err != nil {
		t.Fatalf("tag in use: %v", err)
	}
	if !used {
		t.Fatal("expected in use")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
