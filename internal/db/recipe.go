package db

import (
	"database/sql"
	"fmt"
)

type RecipeValue struct {
	MasterKey string `json:"master_key"`
	Required  bool   `json:"required"`
}

type RecipeScope struct {
	ScopeID   int    `json:"scope_id"`
	ScopeName string `json:"scope_name,omitempty"`
	Required  bool   `json:"required"`
}

type RecipeFull struct {
	Usecase     string        `json:"u"`
	Description string        `json:"d"`
	Values      []RecipeValue `json:"values"`
	Scopes      []RecipeScope `json:"scopes"`
}

func GetRecipe(db *sql.DB, usecase string) (*RecipeFull, error) {
	r := &RecipeFull{}
	err := db.QueryRow(`SELECT u, d FROM recipe WHERE u=?`, usecase).Scan(&r.Usecase, &r.Description)
	if err != nil {
		return nil, err
	}
	return hydrateRecipe(db, r)
}

func ListRecipesFull(db *sql.DB) ([]RecipeFull, error) {
	rows, err := db.Query(`SELECT u, d FROM recipe ORDER BY u`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var recipes []RecipeFull
	for rows.Next() {
		var r RecipeFull
		if err := rows.Scan(&r.Usecase, &r.Description); err != nil {
			return nil, err
		}
		recipes = append(recipes, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range recipes {
		full, err := hydrateRecipe(db, &recipes[i])
		if err != nil {
			return nil, err
		}
		recipes[i] = *full
	}

	return recipes, nil
}

func hydrateRecipe(d *sql.DB, r *RecipeFull) (*RecipeFull, error) {
	rows, err := d.Query(`SELECT master_key, required FROM recipe_values WHERE recipe_u=?`, r.Usecase)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v RecipeValue
		var req int
		if err := rows.Scan(&v.MasterKey, &req); err != nil {
			return nil, err
		}
		v.Required = req == 1
		r.Values = append(r.Values, v)
	}

	srows, err := d.Query(`SELECT rs.scope_id, s.name, rs.required FROM recipe_scopes rs JOIN scope s ON s.id=rs.scope_id WHERE rs.recipe_u=?`, r.Usecase)
	if err != nil {
		return nil, err
	}
	defer srows.Close()
	for srows.Next() {
		var sc RecipeScope
		var req int
		if err := srows.Scan(&sc.ScopeID, &sc.ScopeName, &req); err != nil {
			return nil, err
		}
		sc.Required = req == 1
		r.Scopes = append(r.Scopes, sc)
	}

	return r, nil
}

func InsertRecipe(db *sql.DB, r *RecipeFull) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`INSERT INTO recipe (u, d) VALUES (?, ?)`, r.Usecase, r.Description); err != nil {
		return fmt.Errorf("insert recipe: %w", err)
	}

	for _, v := range r.Values {
		req := 0
		if v.Required {
			req = 1
		}
		if _, err := tx.Exec(`INSERT INTO recipe_values (recipe_u, master_key, required) VALUES (?, ?, ?)`,
			r.Usecase, v.MasterKey, req); err != nil {
			return fmt.Errorf("insert recipe_value %s: %w", v.MasterKey, err)
		}
	}

	for _, sc := range r.Scopes {
		req := 0
		if sc.Required {
			req = 1
		}
		if _, err := tx.Exec(`INSERT INTO recipe_scopes (recipe_u, scope_id, required) VALUES (?, ?, ?)`,
			r.Usecase, sc.ScopeID, req); err != nil {
			return fmt.Errorf("insert recipe_scope %d: %w", sc.ScopeID, err)
		}
	}

	return tx.Commit()
}

func UpdateRecipe(db *sql.DB, r *RecipeFull) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`UPDATE recipe SET d=? WHERE u=?`, r.Description, r.Usecase)
	if err != nil {
		return fmt.Errorf("update recipe: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("recipe not found")
	}

	if _, err := tx.Exec(`DELETE FROM recipe_values WHERE recipe_u=?`, r.Usecase); err != nil {
		return fmt.Errorf("clear recipe_values: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM recipe_scopes WHERE recipe_u=?`, r.Usecase); err != nil {
		return fmt.Errorf("clear recipe_scopes: %w", err)
	}

	for _, v := range r.Values {
		req := 0
		if v.Required {
			req = 1
		}
		if _, err := tx.Exec(`INSERT INTO recipe_values (recipe_u, master_key, required) VALUES (?, ?, ?)`,
			r.Usecase, v.MasterKey, req); err != nil {
			return fmt.Errorf("insert recipe_value %s: %w", v.MasterKey, err)
		}
	}

	for _, sc := range r.Scopes {
		req := 0
		if sc.Required {
			req = 1
		}
		if _, err := tx.Exec(`INSERT INTO recipe_scopes (recipe_u, scope_id, required) VALUES (?, ?, ?)`,
			r.Usecase, sc.ScopeID, req); err != nil {
			return fmt.Errorf("insert recipe_scope %d: %w", sc.ScopeID, err)
		}
	}

	return tx.Commit()
}

func DeleteRecipe(db *sql.DB, usecase string) error {
	res, err := db.Exec(`DELETE FROM recipe WHERE u=?`, usecase)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("recipe not found")
	}
	return nil
}
