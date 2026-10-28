-- S40 (BE11 + BE33): billing & entitlements — Razorpay Subscriptions.
--
-- The PLATFORM bills merchants with its own Razorpay account (PLATFORM_RAZORPAY_*
-- env), fully separate from each tenant's checkout keys. Entitlements derive
-- ONLY from provider state recorded here + operator overrides — never from
-- unverified client input.

-- Versioned plan catalog: a (id, version) row is immutable once referenced;
-- price/quota changes ship as version+1. Subscriptions pin the version they
-- were sold at.
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT NOT NULL,              -- free | starter | growth | …
  version          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  price            INTEGER NOT NULL,           -- minor units (paise) per interval
  currency         TEXT NOT NULL DEFAULT 'INR',
  interval         TEXT NOT NULL DEFAULT 'month',  -- month | year
  features         TEXT NOT NULL DEFAULT '{}', -- quotas + flags, JSON
  razorpay_plan_id TEXT,                       -- provider mirror (created lazily)
  status           TEXT NOT NULL DEFAULT 'active', -- active | retired
  created_at       TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                        TEXT PRIMARY KEY,  -- sub_<hex>
  tenant_id                 TEXT NOT NULL,
  plan_id                   TEXT NOT NULL,
  plan_version              INTEGER NOT NULL,
  razorpay_subscription_id  TEXT UNIQUE,       -- NULL for local/free subscriptions
  status                    TEXT NOT NULL DEFAULT 'created',
  -- created|authenticated|active|halted|cancelled|completed|expired|paused
  current_start             TEXT,
  current_end               TEXT,
  grace_until               TEXT,              -- halted/cancelled keep service until this
  last_event_at             TEXT,              -- provider watermark (out-of-order repair)
  short_url                 TEXT,              -- provider authorization link
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id, created_at);

-- Append-only provider-event ledger. provider_event_id dedupes webhook
-- replays; signed amounts make gross/refunds/net a straight SUM.
CREATE TABLE IF NOT EXISTS billing_events (
  id                TEXT PRIMARY KEY,          -- bev_<hex>
  provider_event_id TEXT UNIQUE,
  subscription_id   TEXT,
  tenant_id         TEXT,
  type              TEXT NOT NULL,
  amount            INTEGER NOT NULL DEFAULT 0, -- minor units; charges +, refunds −
  payment_id        TEXT,
  occurred_at       TEXT NOT NULL,
  applied_at        TEXT NOT NULL,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_payment ON billing_events(payment_id);

-- Operator entitlement overrides: per-field feature overrides that WIN over
-- the plan (time-limited, reasoned, audited).
CREATE TABLE IF NOT EXISTS entitlement_overrides (
  tenant_id  TEXT PRIMARY KEY,
  features   TEXT NOT NULL DEFAULT '{}',
  reason     TEXT NOT NULL,
  set_by     TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- Idempotent usage events (BE33 metering). The "orders" quota is derived
-- from each tenant's own orders table (authoritative by construction); this
-- table carries any OTHER metered usage going forward.
CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  metric          TEXT NOT NULL,
  qty             INTEGER NOT NULL DEFAULT 1,
  period          TEXT NOT NULL,               -- YYYY-MM (UTC)
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_period ON usage_events(tenant_id, period, metric);
