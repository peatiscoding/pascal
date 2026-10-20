package db

import (
	"database/sql"
	"fmt"
	"strings"
)

type StatResult struct {
	Group string  `json:"group"`
	Count int     `json:"count"`
	Sum   float64 `json:"sum"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
}

type StatFilter struct {
	GroupBy  string  // "sc", "tag", or strftime expression
	ValueKey *string // master_value key to aggregate
	Scope    *string
	Tag      *string
	From     *string
	To       *string
}

func QueryStats(db *sql.DB, f StatFilter) ([]StatResult, error) {
	var groupExpr string
	var joinClause string

	switch f.GroupBy {
	case "sc":
		groupExpr = "r.sc"
	case "tag":
		groupExpr = "rt.tag"
		joinClause = " JOIN record_tags rt ON r.id = rt.record_id"
	default:
		// Assume strftime expression like "%Y-%m" for monthly
		groupExpr = fmt.Sprintf("strftime('%s', r.ct)", f.GroupBy)
	}

	var args []any
	var where []string

	query := `SELECT ` + groupExpr + ` as grp, COUNT(*) as cnt`

	if f.ValueKey != nil {
		query += `, COALESCE(SUM(rv.v),0), COALESCE(MIN(rv.v),0), COALESCE(MAX(rv.v),0), COALESCE(AVG(rv.v),0)`
		joinClause += ` LEFT JOIN record_values rv ON r.id = rv.id AND rv.k = ?`
		args = append(args, *f.ValueKey)
	} else {
		query += `, 0, 0, 0, 0`
	}

	query += ` FROM record r` + joinClause

	if f.Scope != nil {
		where = append(where, "r.sc LIKE ?")
		args = append(args, *f.Scope+"%")
	}
	if f.Tag != nil && f.GroupBy != "tag" {
		query += ` JOIN record_tags rt2 ON r.id = rt2.record_id`
		where = append(where, "rt2.tag = ?")
		args = append(args, *f.Tag)
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
		query += " WHERE " + strings.Join(where, " AND ")
	}

	query += " GROUP BY grp ORDER BY grp"

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []StatResult
	for rows.Next() {
		var s StatResult
		if err := rows.Scan(&s.Group, &s.Count, &s.Sum, &s.Min, &s.Max, &s.Avg); err != nil {
			return nil, err
		}
		results = append(results, s)
	}
	return results, nil
}
