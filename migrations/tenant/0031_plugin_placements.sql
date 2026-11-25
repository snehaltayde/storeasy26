-- 0031_plugin_placements (Phase 4 line 2): where an installed plugin's blocks
-- show on the storefront. One row per (install, manifest block), created Off
-- when the plugin is installed; the founder picks the slot, its order in that
-- slot, the block's own settings, and turns it Live. Nothing is deleted: an
-- uninstalled install's rows stay, and the storefront read joins only enabled
-- installs. Additive and re-runnable: a new table and its indexes only; it
-- references no other migration's table by constraint.
CREATE TABLE IF NOT EXISTS plugin_placements (
  id         TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  block_id   TEXT NOT NULL,
  slot       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'off',
  settings   TEXT NOT NULL DEFAULT '{}',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_placements_block ON plugin_placements(install_id, block_id);
CREATE INDEX IF NOT EXISTS idx_plugin_placements_live ON plugin_placements(state, slot);
