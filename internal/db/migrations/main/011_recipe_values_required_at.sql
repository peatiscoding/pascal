-- Replace boolean required with per-status required_at (JSON array of status indices)
ALTER TABLE recipe_values ADD COLUMN required_at TEXT NOT NULL DEFAULT '[]';

-- Migrate: required=1 → all statuses [0,1,2,3], required=0 → []
UPDATE recipe_values SET required_at = CASE WHEN required = 1 THEN '[0,1,2,3]' ELSE '[]' END;
