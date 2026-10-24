package db

import (
	"database/sql"
	"fmt"
	"strings"
)

type Record struct {
	ID      []byte  `json:"id"`
	Title   string  `json:"tl"`
	Detail  *string `json:"dt,omitempty"`
	Status  int     `json:"st"`
	Created string  `json:"ct"`
	Recipe  *string `json:"r,omitempty"`
}

type RecordValue struct {
	Key   string  `json:"k"`
	Value float64 `json:"v"`
}

type RecordFull struct {
	Record
	Tags       []string      `json:"tags"`
	Values     []RecordValue `json:"values"`
	ScopePaths []string      `json:"scope_paths,omitempty"`
}

// InsertRecord inserts a record with tags and values.
// Enforces tag exclusivity: only one child tag per parent group.
// Computes scope_path for each scoped tag.
func InsertRecord(db *sql.DB, r *RecordFull) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO record (id, tl, dt, st, r) VALUES (?, ?, ?, ?, ?)`,
		r.ID, r.Title, r.Detail, r.Status, r.Recipe,
	)
	if err != nil {
		return fmt.Errorf("insert record: %w", err)
	}

	if err := insertTagsExclusive(tx, r.ID, r.Tags); err != nil {
		return err
	}

	for _, v := range r.Values {
		if _, err := tx.Exec(`INSERT INTO record_values (id, k, v) VALUES (?, ?, ?)`, r.ID, v.Key, v.Value); err != nil {
			return fmt.Errorf("insert value %s: %w", v.Key, err)
		}
	}

	// Initial status log
	if _, err := tx.Exec(`INSERT INTO record_log (id, sst) VALUES (?, ?)`, r.ID, r.Status); err != nil {
		return fmt.Errorf("insert log: %w", err)
	}

	return tx.Commit()
}

// BuildScopePath walks scope.parent_id chain to build materialized path.
func BuildScopePath(tx *sql.Tx, scopeID int) (string, error) {
	var parts []string
	current := scopeID
	for {
		var name string
		var parentID sql.NullInt64
		err := tx.QueryRow("SELECT name, parent_id FROM scope WHERE id=?", current).Scan(&name, &parentID)
		if err != nil {
			return "", fmt.Errorf("scope %d: %w", current, err)
		}
		parts = append([]string{name}, parts...)
		if !parentID.Valid {
			break
		}
		current = int(parentID.Int64)
	}
	return strings.Join(parts, "|"), nil
}

// insertTagsExclusive inserts tags enforcing: max one tag per scope group.
// Computes scope_path for scoped tags.
func insertTagsExclusive(tx *sql.Tx, recordID []byte, tags []string) error {
	scopeSeen := map[int]string{} // scope_id -> tag already used
	for _, tag := range tags {
		var scopeID sql.NullInt64
		err := tx.QueryRow(`SELECT s FROM tag WHERE t=?`, tag).Scan(&scopeID)
		if err != nil {
			return fmt.Errorf("lookup tag %s: %w", tag, err)
		}

		var scopePath *string
		if scopeID.Valid {
			sid := int(scopeID.Int64)
			if existing, ok := scopeSeen[sid]; ok {
				return fmt.Errorf("tag conflict: '%s' and '%s' share scope (only one per scope allowed)", existing, tag)
			}
			scopeSeen[sid] = tag
			path, err := BuildScopePath(tx, sid)
			if err != nil {
				return fmt.Errorf("build scope path for tag %s: %w", tag, err)
			}
			scopePath = &path
		}

		if _, err := tx.Exec(`INSERT INTO record_tags (record_id, tag, scope_path) VALUES (?, ?, ?)`, recordID, tag, scopePath); err != nil {
			return fmt.Errorf("insert tag %s: %w", tag, err)
		}
	}
	return nil
}

func UpdateRecordStatus(db *sql.DB, id []byte, status int, info string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`UPDATE record SET st=? WHERE id=?`, status, id)
	if err != nil {
		return fmt.Errorf("update status: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("record not found")
	}

	if _, err := tx.Exec(`INSERT INTO record_log (id, sst, inf) VALUES (?, ?, ?)`, id, status, info); err != nil {
		return fmt.Errorf("insert log: %w", err)
	}

	return tx.Commit()
}

func GetRecord(db *sql.DB, id []byte) (*RecordFull, error) {
	r := &RecordFull{}
	err := db.QueryRow(
		`SELECT id, tl, dt, st, ct, r FROM record WHERE id=?`, id,
	).Scan(&r.ID, &r.Title, &r.Detail, &r.Status, &r.Created, &r.Recipe)
	if err != nil {
		return nil, err
	}
	return hydrateRecord(db, r)
}

type RecordFilter struct {
	Scope  *string
	Status *int
	Tag    *string
	From   *string
	To     *string
	Limit  int
	Offset int
}

func ListRecords(db *sql.DB, f RecordFilter) ([]RecordFull, error) {
	query := `SELECT DISTINCT r.id, r.tl, r.dt, r.st, r.ct, r.r FROM record r`
	var args []any
	var where []string
	var joins []string

	if f.Tag != nil {
		joins = append(joins, `JOIN record_tags rt ON r.id = rt.record_id`)
		where = append(where, "rt.tag = ?")
		args = append(args, *f.Tag)
	}
	if f.Scope != nil {
		if f.Tag == nil {
			joins = append(joins, `JOIN record_tags rt_sc ON r.id = rt_sc.record_id`)
			where = append(where, "rt_sc.scope_path LIKE ?")
		} else {
			where = append(where, "rt.scope_path LIKE ?")
		}
		args = append(args, *f.Scope+"%")
	}
	if f.Status != nil {
		where = append(where, "r.st = ?")
		args = append(args, *f.Status)
	}
	if f.From != nil {
		where = append(where, "r.ct >= ?")
		args = append(args, *f.From)
	}
	if f.To != nil {
		where = append(where, "r.ct <= ?")
		args = append(args, *f.To)
	}

	for _, j := range joins {
		query += " " + j
	}
	if len(where) > 0 {
		query += " WHERE " + joinAnd(where)
	}
	query += " ORDER BY r.ct DESC"

	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, f.Offset)

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []RecordFull
	for rows.Next() {
		var r RecordFull
		if err := rows.Scan(&r.ID, &r.Title, &r.Detail, &r.Status, &r.Created, &r.Recipe); err != nil {
			return nil, err
		}
		records = append(records, r)
	}

	for i := range records {
		full, err := hydrateRecord(db, &records[i])
		if err != nil {
			return nil, err
		}
		records[i] = *full
	}

	return records, nil
}

func hydrateRecord(d *sql.DB, r *RecordFull) (*RecordFull, error) {
	rows, err := d.Query(`SELECT tag, scope_path FROM record_tags WHERE record_id=?`, r.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		var sp sql.NullString
		if err := rows.Scan(&t, &sp); err != nil {
			return nil, err
		}
		r.Tags = append(r.Tags, t)
		if sp.Valid {
			r.ScopePaths = append(r.ScopePaths, sp.String)
		}
	}

	vrows, err := d.Query(`SELECT k, v FROM record_values WHERE id=?`, r.ID)
	if err != nil {
		return nil, err
	}
	defer vrows.Close()
	for vrows.Next() {
		var rv RecordValue
		if err := vrows.Scan(&rv.Key, &rv.Value); err != nil {
			return nil, err
		}
		r.Values = append(r.Values, rv)
	}

	return r, nil
}

func DeleteRecord(db *sql.DB, id []byte) error {
	res, err := db.Exec(`DELETE FROM record WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("record not found")
	}
	return nil
}

// TagInUse returns true if the tag is referenced by any record.
func TagInUse(db *sql.DB, tag string) (bool, error) {
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM record_tags WHERE tag=?`, tag).Scan(&count)
	return count > 0, err
}

func joinAnd(clauses []string) string {
	result := clauses[0]
	for _, c := range clauses[1:] {
		result += " AND " + c
	}
	return result
}
