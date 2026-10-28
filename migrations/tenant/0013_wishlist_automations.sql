-- S49 (SF22 + MC28): wishlist + merchant automations (the optional W6 pair).

-- SF22: the wishlist is LOCAL-FIRST (browser storage, per store origin) —
-- this table holds only what a signed-in customer EXPLICITLY merged into
-- their account. No implicit identity joining anywhere.
CREATE TABLE IF NOT EXISTS customer_wishlists (
  customer_id TEXT NOT NULL,
  handle      TEXT NOT NULL,                   -- product handle (identity for dedupe)
  variant_id  TEXT,                            -- optional specific variant
  created_at  TEXT NOT NULL,
  PRIMARY KEY (customer_id, handle)
);

-- MC28: bounded trigger/condition/action rules. Everything an automation
-- may do is enumerated in lib/automations.js — no scripts, no webhooks out.
CREATE TABLE IF NOT EXISTS automations (
  id            TEXT PRIMARY KEY,              -- aut-<hex>
  name          TEXT NOT NULL,
  trigger       TEXT NOT NULL,                 -- order_placed | return_requested
  conditions    TEXT NOT NULL DEFAULT '{}',    -- JSON {min_total?, payment_method?}
  action        TEXT NOT NULL,                 -- JSON {kind: notify_merchant|email_customer, subject?, text}
  enabled       INTEGER NOT NULL DEFAULT 0,
  cap_per_day   INTEGER NOT NULL DEFAULT 25,   -- frequency cap (completed runs / 24h)
  quiet_start   TEXT,                          -- "HH:MM" merchant-local, inclusive
  quiet_end     TEXT,                          -- "HH:MM" merchant-local, exclusive
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Run history doubles as the DEDUPLICATION ledger: one row per
-- (automation, event) — replaying the same event can never act twice.
CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,              -- run-<hex>
  automation_id TEXT NOT NULL,
  event_key     TEXT NOT NULL,                 -- "<trigger>:<entity id>" (dry runs get dry:<hex>)
  status        TEXT NOT NULL,                 -- done | skipped | failed | dry_run
  reason        TEXT,                          -- why skipped/failed; what was sent when done
  created_at    TEXT NOT NULL,
  UNIQUE (automation_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, created_at);

-- Tiny merchant-local flag store (the MC28 disable-all switch lives here —
-- tenant-DB state, no control-plane dependency).
CREATE TABLE IF NOT EXISTS automation_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
