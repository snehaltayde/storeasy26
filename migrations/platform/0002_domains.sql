-- Domain registry (Session 28 / BE12): unique normalized hosts with ownership
-- challenges. Resolution still reads tenants.domains — verification/activation
-- writes back into it (lib/platform/domains.js); this table is the lifecycle
-- + platform-wide uniqueness record.
CREATE TABLE IF NOT EXISTS domains (
  host        TEXT PRIMARY KEY,            -- lowercased; may carry :port in dev
  tenant_id   TEXT NOT NULL,
  challenge   TEXT,                        -- expected TXT value (storeasy-verify=<hex>)
  method      TEXT,                        -- dns-txt | operator
  is_primary  INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_domains_tenant ON domains(tenant_id);
