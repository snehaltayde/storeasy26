-- S41 (BE26): provisioning as recorded, resumable, compensable runs.
--
-- One row per provisioning attempt. steps is the ordered step record
-- [{name, status: pending|done|failed|skipped, detail, startedAt, finishedAt}];
-- refs holds NON-SECRET resource references accumulated by done steps (db url,
-- created flags, subscription id) so a RESUME re-enters with what already
-- exists and never duplicates a resource. Secrets (generated passwords, db
-- tokens) are NEVER stored here — they live only in the control-plane
-- tenant row's encrypted envelope.
CREATE TABLE IF NOT EXISTS provision_runs (
  id         TEXT PRIMARY KEY,                -- prov_<hex>
  tenant_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running', -- running | done | failed | compensated
  steps      TEXT NOT NULL DEFAULT '[]',      -- JSON step records
  refs       TEXT NOT NULL DEFAULT '{}',      -- JSON non-secret resource refs
  params     TEXT NOT NULL DEFAULT '{}',      -- JSON redacted inputs (no secrets)
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provision_runs_tenant ON provision_runs(tenant_id, created_at);
