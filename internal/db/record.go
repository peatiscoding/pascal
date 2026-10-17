package db

import (
	"database/sql"
	"fmt"
)

type Record struct {
	ID       []byte  `json:"id"`
	Title    string  `json:"tl"`
	Detail   *string `json:"dt,omitempty"`
	Status   int     `json:"st"`
	Created  string  `json:"ct"`
	Scope    string  `json:"sc"`
	Category string  `json:"cg"`
	Recipe   *string `json:"r,omitempty"`
}

type RecordValue struct {
	Key   string  `json:"k"`
	Value float64 `json:"v"`
}

type RecordFull struct {
	Record
	Tags   []string      `json:"tags"`
	Values []RecordValue `json:"values"`
}

func InsertRecord(db *sql.DB, r *RecordFull) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO record (id, tl, dt, st, sc, cg, r) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Title, r.Detail, r.Status, r.Scope, r.Category, r.Recipe,
	)
	if err != nil {
		return fmt.Errorf("insert record: %w", err)
	}

	for _, tag := range r.Tags {
		if _, err := tx.Exec(`INSERT INTO record_tags (record_id, tag) VALUES (?, ?)`, r.ID, tag); err != nil {
			return fmt.Errorf("insert tag %s: %w", tag, err)
		}
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
		`SELECT id, tl, dt, st, ct, sc, cg, r FROM record WHERE id=?`, id,
	).Scan(&r.ID, &r.Title, &r.Detail, &r.Status, &r.Created, &r.Scope, &r.Category, &r.Recipe)
	if err != nil {
		return nil, err
	}

	rows, err := db.Query(`SELECT tag FROM record_tags WHERE record_id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		r.Tags = append(r.Tags, t)
	}

	vrows, err := db.Query(`SELECT k, v FROM record_values WHERE id=?`, id)
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

type RecordFilter struct {
	Scope    *string
	Category *string
	Status   *int
	Tag      *string
	From     *string
	To       *string
	Limit    int
	Offset   int
}

func ListRecords(db *sql.DB, f RecordFilter) ([]RecordFull, error) {
	query := `SELECT DISTINCT r.id, r.tl, r.dt, r.st, r.ct, r.sc, r.cg, r.r FROM record r`
	var args []any
	var where []string

	if f.Tag != nil {
		query += ` JOIN record_tags rt ON r.id = rt.record_id`
		where = append(where, "rt.tag = ?")
		args = append(args, *f.Tag)
	}
	if f.Scope != nil {
		where = append(where, "r.sc LIKE ?")
		args = append(args, *f.Scope+"%")
	}
	if f.Category != nil {
		where = append(where, "r.cg = ?")
		args = append(args, *f.Category)
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
		if err := rows.Scan(&r.ID, &r.Title, &r.Detail, &r.Status, &r.Created, &r.Scope, &r.Category, &r.Recipe); err != nil {
			return nil, err
		}
		records = append(records, r)
	}

	// Hydrate tags and values
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
	rows, err := d.Query(`SELECT tag FROM record_tags WHERE record_id=?`, r.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		r.Tags = append(r.Tags, t)
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

func joinAnd(clauses []string) string {
	result := clauses[0]
	for _, c := range clauses[1:] {
		result += " AND " + c
	}
	return result
}
