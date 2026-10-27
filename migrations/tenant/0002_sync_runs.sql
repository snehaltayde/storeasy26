-- Catalog sync generations (Session 30 / BE04). Every full sync is a recorded
-- run; rows it writes carry its generation, and pruning of stale rows happens
-- ONLY after a COMPLETE successful run (webhook-raced rows are protected by
-- their fresh synced_at). NOTE: the ALTERs are not re-runnable — if this file
-- ever fails midway, repair the column state by hand before retrying
-- (migrations/README.md rule 3).
CREATE TABLE IF NOT EXISTS sync_runs (
  id                 TEXT PRIMARY KEY,                 -- "sync_" + 16 hex = the generation
  kind               TEXT NOT NULL DEFAULT 'full',
  status             TEXT NOT NULL DEFAULT 'running',  -- running | complete | failed
  cursor             TEXT,                             -- last page cursor seen (diagnostics)
  products_fetched   INTEGER NOT NULL DEFAULT 0,
  products           INTEGER NOT NULL DEFAULT 0,
  collections        INTEGER NOT NULL DEFAULT 0,
  pruned_products    INTEGER NOT NULL DEFAULT 0,
  pruned_collections INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  started_at         TEXT,
  finished_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);

ALTER TABLE products ADD COLUMN sync_generation TEXT;
ALTER TABLE collections ADD COLUMN sync_generation TEXT;
CREATE INDEX IF NOT EXISTS idx_products_generation ON products(sync_generation);
CREATE INDEX IF NOT EXISTS idx_collections_generation ON collections(sync_generation);
