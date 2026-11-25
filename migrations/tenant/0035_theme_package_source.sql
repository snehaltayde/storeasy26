-- 0035_theme_package_source (Phase 7 line 1): where a theme package came
-- from. 'upload' (a founder's file, Phase 5) or 'storeasy' (a flagship theme
-- from lib/themes/flagships.js, installed on first use). Only uploads count
-- toward the 30-package limit and obey the kill switch ff_theme-packages.
-- Additive: every existing row is an upload. The ALTER is not re-runnable
-- (README rule 3); the index is.
ALTER TABLE theme_packages ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'; -- upload | storeasy
CREATE INDEX IF NOT EXISTS idx_theme_packages_source ON theme_packages(source, status);
