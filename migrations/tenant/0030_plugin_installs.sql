-- 0030_plugin_installs (Phase 4 line 1): a store's installed plugins. One live
-- install per plugin (the partial unique index); uninstalling archives the row
-- (status 'uninstalled'), nothing is deleted. secrets_enc holds a plugin's
-- secret settings, encrypted (encryptJson), and is never sent to a browser.
-- Additive and re-runnable: a new table and its indexes only.
CREATE TABLE IF NOT EXISTS plugin_installs (
  id             TEXT PRIMARY KEY,
  plugin_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  name           TEXT,
  version        TEXT NOT NULL,
  status         TEXT NOT NULL,
  granted_scopes TEXT NOT NULL DEFAULT '[]',
  settings       TEXT NOT NULL DEFAULT '{}',
  secrets_enc    TEXT,
  installed_by   TEXT NOT NULL,
  installed_at   TEXT NOT NULL,
  updated_by     TEXT,
  updated_at     TEXT NOT NULL,
  disabled_at    TEXT,
  disabled_by    TEXT,
  uninstalled_at TEXT,
  uninstalled_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_installs_live ON plugin_installs(plugin_id) WHERE status <> 'uninstalled';
CREATE INDEX IF NOT EXISTS idx_plugin_installs_status ON plugin_installs(status);
