-- 0033_plugin_tokens (Phase 4 line 4): scoped API tokens for custom apps.
-- The token string is "sea_<id>.<64 hex secret>"; only sha256(secret) is kept
-- (secret_hash), compared in constant time. scopes is the subset of the
-- install's granted_scopes chosen at mint time; every call uses scopes ∩ the
-- install's current approval. Revoking keeps the row (revoked_at, revoked_by).
-- Additive and re-runnable: a new table and its index only.
CREATE TABLE IF NOT EXISTS plugin_tokens (
  id           TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_tokens_install ON plugin_tokens(install_id, created_at);
