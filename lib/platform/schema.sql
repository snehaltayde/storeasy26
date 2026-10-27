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

-- ---------------------------------------------------------------------------
-- Identity (Session 26 / BE02): individual users, revocable sessions,
-- memberships, invitations/password-resets, and a distributed login throttle.
-- Merchant + operator identities share the users table (is_operator flag);
-- authorization is session kind + membership (roles enforced fully in S27).

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,                -- "u_" + 16 hex
  email          TEXT NOT NULL UNIQUE,            -- stored lowercased
  name           TEXT,
  password_hash  TEXT,                            -- scrypt:N:r:p:<salt b64>:<hash b64>
  totp_enc       TEXT,                            -- AES-GCM-encrypted base32 TOTP secret
  totp_confirmed INTEGER NOT NULL DEFAULT 0,
  is_operator    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  created_at     TEXT,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                   -- "s_" + 16 hex
  token_hash  TEXT NOT NULL UNIQUE,               -- sha256 hex of the cookie token
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                      -- merchant | operator
  created_at  TEXT,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  ip          TEXT,
  ua          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'admin',       -- owner | admin | staff | support
  created_at TEXT,
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT PRIMARY KEY,                   -- "i_" + 16 hex
  token_hash  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'invite',     -- invite | reset
  email       TEXT NOT NULL,
  tenant_id   TEXT,                               -- null = operator-scope (unused yet)
  role        TEXT,
  invited_by  TEXT,
  created_at  TEXT,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS login_limits (
  key      TEXT PRIMARY KEY,                      -- e.g. "login:<email>" / "login-ip:<ip>"
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL
);
