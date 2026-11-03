-- GEN-02: a full sync runs as resumable, page-sized steps. Each step writes one
-- page and moves the run's stored position in the SAME atomic batch, so a step
-- killed at any point resumes from the last committed page. `cursor` (0002) is
-- now the products position, read back on resume; `collections_cursor` is the
-- collections position. Prune and search indexing run only in the final phases,
-- after every page of a generation is in.
--   phase          products → collections (⇄ members) → prune → index → done
--   member_tails   JSON {then, tails:[{c, cursor, at}]}: collections whose
--                  membership runs past the first 250, drained one page per
--                  step ('members'), so no single step holds a huge collection
--   pages_done     committed steps; the guard every step's commit checks
--   lease_owner /
--   lease_until    one runner at a time (job, console nudge or CLI); a killed
--                  runner's lease simply expires
--   updated_at     last progress or state change (stalled-run detection)
--   source         admin | storefront | injected — a cursor from one Shopify
--                  API is meaningless to the other, so a resume checks it
--   started_by     connect | manual | operator | scheduled | cli
--   products_total Shopify's count when it gives one (progress "of N")
-- NOTE: the ALTERs are not re-runnable — if this file ever fails midway,
-- repair the column state by hand before retrying (migrations/README.md rule 3).
ALTER TABLE sync_runs ADD COLUMN phase TEXT;
ALTER TABLE sync_runs ADD COLUMN collections_cursor TEXT;
ALTER TABLE sync_runs ADD COLUMN collections_fetched INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN member_tails TEXT;
ALTER TABLE sync_runs ADD COLUMN pages_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN products_total INTEGER;
ALTER TABLE sync_runs ADD COLUMN source TEXT;
ALTER TABLE sync_runs ADD COLUMN started_by TEXT;
ALTER TABLE sync_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE sync_runs ADD COLUMN lease_until TEXT;
ALTER TABLE sync_runs ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status, started_at);
