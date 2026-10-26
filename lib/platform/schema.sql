-- Storeasy CONTROL PLANE (Session 20). One small database for the platform
-- itself; every tenant's commerce data lives in that tenant's OWN Turso DB
-- (the existing lib/schema.sql, unchanged — isolation by construction).
--
-- `config`  = plain JSON (non-secret: store domain, public ids, site identity…)
-- `secrets_enc` = AES-GCM-encrypted JSON (admin tokens, key secrets, passwords)
-- `db_token_enc` = encrypted auth token for the tenant's own database.
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,          -- slug, e.g. "beastlife"
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  domains       TEXT NOT NULL DEFAULT '[]',      -- JSON array of hostnames
  db_url        TEXT NOT NULL,                   -- tenant's own Turso/libsql URL
  db_token_enc  TEXT,
  config        TEXT NOT NULL DEFAULT '{}',
  secrets_enc   TEXT,
  created_at    TEXT,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
