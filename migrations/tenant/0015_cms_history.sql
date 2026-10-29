-- S55 (audit slice 5): draft revision history. Every console save of a block
-- or page appends its SAVED value here (capped per key at write time), so a
-- merchant can see who saved what, when — and restore an older version into
-- the editor as an ordinary draft edit. History is an authoring trail, not a
-- release artifact: rollback of LIVE content stays with releases.
CREATE TABLE IF NOT EXISTS cms_history (
  id         TEXT PRIMARY KEY,                -- his_<hex>
  kind       TEXT NOT NULL,                   -- 'block' | 'page'
  key        TEXT NOT NULL,                   -- block key | page slug
  value      TEXT NOT NULL,                   -- the saved JSON value
  revision   INTEGER,                         -- the row revision this save produced
  actor      TEXT,                            -- "<kind>:<id>" best-effort
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cms_history_key ON cms_history(kind, key, created_at);
