-- Phase 1.1: Retire Legacy CMS.
-- All stores run on the unified Documents CMS (`documents` mode).
-- Additive/idempotent: updates cms_state if present and drops obsolete
-- legacy-only preview_candidates table.
UPDATE cms_state SET mode = 'documents', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1 AND mode <> 'documents';
DROP TABLE IF EXISTS preview_candidates;
