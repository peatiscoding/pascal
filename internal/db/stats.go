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
	GroupBy  string  // "scope", "tag", or strftime expression
	ValueKey *string // master_value key to aggregate
	Scope    *string
	Tag      *string
	From     *string
	To       *string
}

func QueryStats(db *sql.DB, f StatFilter) ([]StatResult, error) {
	var groupExpr string
	var joinClauses []string

	switch f.GroupBy {
	case "scope", "sc":
		groupExpr = "rt_grp.scope_path"
		joinClauses = append(joinClauses, "JOIN record_tags rt_grp ON r.id = rt_grp.record_id AND rt_grp.scope_path IS NOT NULL")
	case "tag":
		groupExpr = "rt_grp.tag"
		joinClauses = append(joinClauses, "JOIN record_tags rt_grp ON r.id = rt_grp.record_id")
	default:
		// Assume strftime expression like "%Y-%m" for monthly
		groupExpr = fmt.Sprintf("strftime('%s', r.ct)", f.GroupBy)
	}

	var args []any
	var where []string

	query := `SELECT ` + groupExpr + ` as grp, COUNT(DISTINCT r.id) as cnt`

	if f.ValueKey != nil {
		query += `, COALESCE(SUM(rv.v),0), COALESCE(MIN(rv.v),0), COALESCE(MAX(rv.v),0), COALESCE(AVG(rv.v),0)`
		joinClauses = append(joinClauses, `LEFT JOIN record_values rv ON r.id = rv.id AND rv.k = ?`)
		args = append(args, *f.ValueKey)
	} else {
		query += `, 0, 0, 0, 0`
	}

	query += ` FROM record r`
	for _, j := range joinClauses {
		query += " " + j
	}

	if f.Scope != nil {
		joinClauses = append(joinClauses, "")
		// Use separate join if not already grouping by scope
		if f.GroupBy != "scope" && f.GroupBy != "sc" {
			query += ` JOIN record_tags rt_sc ON r.id = rt_sc.record_id`
			where = append(where, "rt_sc.scope_path LIKE ?")
		} else {
			where = append(where, "rt_grp.scope_path LIKE ?")
		}
		args = append(args, *f.Scope+"%")
	}
	if f.Tag != nil {
		if f.GroupBy != "tag" {
			query += ` JOIN record_tags rt_ft ON r.id = rt_ft.record_id`
			where = append(where, "rt_ft.tag = ?")
		} else {
			where = append(where, "rt_grp.tag = ?")
		}
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
