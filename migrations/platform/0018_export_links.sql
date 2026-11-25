-- Phase 3 audit P3-A (docs/cms-reviews/PHASE-3-AUDIT.md): a store export link
-- is single-use and valid for 15 minutes. Each minted link has a row keyed by
-- its jti; the download spends it with one conditional UPDATE (used_at IS NULL
-- and not past expires_at), so of two concurrent uses exactly one wins.
-- operator_id is who minted it, for the tenant.export_downloaded audit row.
-- Additive: one new table and an index.

CREATE TABLE IF NOT EXISTS export_links (
  jti         TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  operator_id TEXT,
  operator_kind TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_export_links_expires ON export_links(expires_at);
