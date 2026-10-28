-- S47 (OP13 + OP09): feature flags + cost inputs.

-- OP13: server-evaluated release/ops flags — DELIBERATELY SEPARATE from
-- purchased entitlements (S40 billing) and quotas: keys are namespaced
-- ff_*, and nothing in billing reads this table. Critical flags (the
-- checkout kill-switch) are evaluated UNCACHED per request so an emergency
-- disable takes effect immediately across every instance.
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,                -- ^ff_[a-z0-9-]+$
  description TEXT,
  default_on  INTEGER NOT NULL DEFAULT 0,
  tenants     TEXT,                            -- JSON {slug: 0|1} cohort overrides
  critical    INTEGER NOT NULL DEFAULT 0,      -- uncached evaluation
  expires_at  TEXT,                            -- expired flag = off for everyone
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

-- OP09: operator-entered monthly provider totals (the bills), allocated to
-- tenants by MEASURED drivers; whatever no driver covers stays visibly
-- unallocated — it never disappears into made-up per-tenant numbers.
CREATE TABLE IF NOT EXISTS cost_inputs (
  month      TEXT PRIMARY KEY,                 -- YYYY-MM (UTC)
  totals     TEXT NOT NULL,                    -- JSON {compute, db, mail, ai, other} in INR
  note       TEXT,
  updated_at TEXT NOT NULL
);
