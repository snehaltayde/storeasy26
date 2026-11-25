-- 0034_theme_packages (Phase 5 step 0): uploaded theme packages, format
-- storeasy-theme/1 (lib/themes/package-format.js). A row is immutable once
-- written; archiving keeps it (status, archived_by, archived_at), never deleted.
-- Additive and re-runnable: a new table and its indexes only.
CREATE TABLE IF NOT EXISTS theme_packages (
  id TEXT PRIMARY KEY,             -- "thm_" + 16 hex; immutable once written
  slug TEXT NOT NULL, version TEXT NOT NULL, name TEXT NOT NULL,
  author TEXT, description TEXT, base_kit TEXT NOT NULL,
  package TEXT NOT NULL,           -- normalised, validated JSON
  sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed',  -- installed | archived (never deleted)
  uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, archived_by TEXT, archived_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_theme_packages_slug_ver ON theme_packages(slug, version);
CREATE INDEX IF NOT EXISTS idx_theme_packages_status ON theme_packages(status, uploaded_at);
