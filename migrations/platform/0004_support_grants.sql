-- Operator support-access grants (Session 34 / OP10): time-limited, reasoned,
-- audited access to ONE tenant's merchant console (support role — read-only,
-- PII-redacted). The merchant sees a banner while a grant is active.
CREATE TABLE IF NOT EXISTS support_grants (
  id         TEXT PRIMARY KEY,   -- "sg_" + 16 hex
  tenant_id  TEXT NOT NULL,
  operator   TEXT NOT NULL,      -- operator user id or "bootstrap"
  reason     TEXT NOT NULL,
  created_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_grants_tenant ON support_grants(tenant_id, expires_at);
