-- S47 (BE22 + BE32): experimentation + AI insights.

-- BE22: experiments. The ANALYSIS PLAN IS FROZEN AT START (hypothesis,
-- metric, min sample, allocation, salt) — edits to a running experiment are
-- refused, so there is no quiet goal-moving. Assignment is a pure hash of
-- (salt | slug | unit): stable, server-evaluated, reproducible.
CREATE TABLE IF NOT EXISTS experiments (
  id             TEXT PRIMARY KEY,              -- exp-<hex>
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  hypothesis     TEXT,
  target_kind    TEXT NOT NULL DEFAULT 'hero',  -- allowlisted serving target
  variants       TEXT NOT NULL,                 -- JSON [{key, weight, payload|null}] — control first
  primary_metric TEXT NOT NULL DEFAULT 'conversion',
  min_sample     INTEGER NOT NULL DEFAULT 200,  -- per variant, before any winner talk
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | running | paused | completed
  salt           TEXT,                          -- set at start; part of the frozen plan
  started_at     TEXT,
  ended_at       TEXT,
  adopted_variant TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- First exposure per unit is THE exposure (INSERT OR IGNORE): re-views never
-- double-count, and the recorded variant is the served one forever.
CREATE TABLE IF NOT EXISTS experiment_exposures (
  experiment_id    TEXT NOT NULL,
  unit_id          TEXT NOT NULL,
  variant          TEXT NOT NULL,
  first_exposed_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, unit_id)
);

-- Conversions join exposures by unit (reproducible: both tables keep the
-- raw keys). One row per (experiment, order) — duplicate webhooks/retries
-- can't inflate a variant.
CREATE TABLE IF NOT EXISTS experiment_conversions (
  experiment_id TEXT NOT NULL,
  unit_id       TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  total         REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (experiment_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_exp_conv_unit ON experiment_conversions(experiment_id, unit_id);

-- BE32: AI insight proposals — structured, evidence-linked, validated before
-- storage. Drafts apply through the NORMAL CMS draft + release path; the AI
-- never publishes anything.
CREATE TABLE IF NOT EXISTS ai_insights (
  id         TEXT PRIMARY KEY,                  -- ins-<hex>
  status     TEXT NOT NULL DEFAULT 'proposed',  -- proposed | dismissed | applied
  model      TEXT,
  proposals  TEXT NOT NULL,                     -- JSON validated proposals
  facts      TEXT NOT NULL,                     -- JSON facts snapshot the evidence ids point into
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
