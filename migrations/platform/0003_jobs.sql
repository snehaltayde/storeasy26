-- Durable jobs + webhook inbox (Session 29 / BE14). Control-plane tables:
-- job payloads carry small references (order ids, event ids, inbox ids) —
-- tenant PII stays in tenant databases; the inbox stores raw webhook bodies
-- for replay (the inspector never serializes them).
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id           TEXT PRIMARY KEY,                 -- "wh_" + 16 hex
  source       TEXT NOT NULL,                    -- shopify | razorpay
  topic        TEXT,
  shop_domain  TEXT,
  tenant_id    TEXT,                             -- fan-out target (one row per delivery × tenant)
  body_hash    TEXT,                             -- sha-256 of the raw body
  payload      TEXT,                             -- raw JSON body (replay source)
  headers      TEXT,                             -- safe subset (topic/webhook/event ids) as JSON
  hmac_ok      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done | dead | ignored
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  received_at  TEXT,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON webhook_inbox(status, received_at);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,                 -- "job_" + 16 hex
  type            TEXT NOT NULL,                    -- shopify_push | forward_event | webhook_apply
  tenant_id       TEXT,                             -- null = env-default/legacy context
  payload         TEXT NOT NULL DEFAULT '{}',       -- small refs only, no PII
  idempotency_key TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | leased | done | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  run_after       TEXT,                             -- backoff-with-jitter schedule
  lease_until     TEXT,                             -- crash recovery: expired leases re-lease
  last_error      TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  done_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id, status);
