-- S59: live unsaved-edit preview. One candidate per PREVIEW SESSION (keyed
-- by a hash of the preview token): the designer pushes its unsaved blocks
-- here and that browser's cookie-gated preview overlays them. Ephemeral —
-- rows prune after 24h, publishing never reads this table.
CREATE TABLE IF NOT EXISTS cms_preview_candidates (
  token_hash TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
