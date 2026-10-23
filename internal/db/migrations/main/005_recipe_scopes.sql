-- Replace recipe_tags with recipe_scopes
DROP TABLE IF EXISTS recipe_tags;

CREATE TABLE IF NOT EXISTS recipe_scopes (
    recipe_u TEXT NOT NULL REFERENCES recipe(u) ON DELETE CASCADE,
    scope_id INTEGER NOT NULL REFERENCES scope(id),
    required INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_u, scope_id)
);
