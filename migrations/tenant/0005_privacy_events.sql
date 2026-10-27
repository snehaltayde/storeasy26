-- Privacy lifecycle + event contract (Session 33 / BE18+BE20).
-- NOTE: the ALTERs are not re-runnable (migrations/README.md rule 3).
CREATE TABLE IF NOT EXISTS privacy_requests (
  id           TEXT PRIMARY KEY,                 -- "pr_" + 16 hex
  kind         TEXT NOT NULL,                    -- data_request | customer_redact | shop_redact
  email        TEXT,
  phone        TEXT,
  customer_id  TEXT,                             -- Shopify customer id (if given)
  shop_domain  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done | manual
  notes        TEXT,
  created_at   TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_privacy_status ON privacy_requests(status);

ALTER TABLE orders ADD COLUMN redacted_at TEXT;        -- PII scrubbed (money rows retained)
ALTER TABLE events ADD COLUMN contract_version INTEGER; -- BE20: event-contract version at collection
ALTER TABLE events ADD COLUMN consent TEXT;             -- purposes JSON snapshot at collection
