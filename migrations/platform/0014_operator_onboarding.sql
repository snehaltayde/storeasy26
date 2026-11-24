-- Phase 1 line 8: the operator sees every signup and each store's onboarding
-- step, and helps a stuck store from one screen (docs/plans/phase-1.md).
-- Nothing destructive: two new tables, their indexes, two added columns.

-- The operator's cache of each store's onboarding steps (the founder's page
-- always reads live). steps holds [{id,state,problem?,blockedBy?}] only: no
-- facts, actions or domain.
CREATE TABLE IF NOT EXISTS onboarding_progress (
  tenant_id TEXT PRIMARY KEY,
  supported INTEGER NOT NULL DEFAULT 1,
  open INTEGER,                      -- 1 | 0 | null unknown
  current_step TEXT,                 -- connect|import|brand|open|null
  done_count INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL DEFAULT '[]',
  step_since TEXT,                   -- when current_step+state last changed
  step_since_exact INTEGER NOT NULL DEFAULT 0, -- 0: first seen at check time ("at least")
  checked_at TEXT NOT NULL,
  check_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_stuck ON onboarding_progress(open, step_since);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_checked ON onboarding_progress(checked_at);

-- Append-only operator notes on a signup or a store.
CREATE TABLE IF NOT EXISTS operator_notes (
  id TEXT PRIMARY KEY,               -- opn_<16hex>
  subject TEXT NOT NULL,             -- 'signup:<id>' | 'tenant:<id>'
  body TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_notes_subject ON operator_notes(subject, created_at);

CREATE INDEX IF NOT EXISTS idx_signups_created ON signups(created_at);
CREATE INDEX IF NOT EXISTS idx_signups_tenant ON signups(tenant_id);

-- An operator freed a lapsed signup's address (status 'released').
ALTER TABLE signups ADD COLUMN released_at TEXT;
ALTER TABLE signups ADD COLUMN released_by TEXT;
