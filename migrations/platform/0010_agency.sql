-- S48 (BE28 + AG01–06 + OP14 + MK06): agency platform.

-- Agencies: commercial status (verified, referral-eligible, commission rate)
-- is DELIBERATELY independent from client access — a verified agency with no
-- accepted grants sees zero stores.
CREATE TABLE IF NOT EXISTS agencies (
  id                TEXT PRIMARY KEY,              -- agc_<hex>
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | suspended
  referral_eligible INTEGER NOT NULL DEFAULT 0,
  commission_bps    INTEGER NOT NULL DEFAULT 1500, -- 15% of eligible collected revenue
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_members (
  agency_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,                        -- control-plane users row
  role       TEXT NOT NULL DEFAULT 'member',       -- owner | member
  created_at TEXT NOT NULL,
  PRIMARY KEY (agency_id, user_id)
);

-- Client-accepted per-store grants. A grant invite is bound to the CLIENT'S
-- EMAIL at creation; acceptance happens in the client's own console, by an
-- actor whose email matches and who can manage that store's team — a wrong
-- recipient or an expired token creates nothing. Revocation is immediate:
-- every agency operation re-reads the grant.
CREATE TABLE IF NOT EXISTS agency_grants (
  id           TEXT PRIMARY KEY,                   -- agr_<hex>
  agency_id    TEXT NOT NULL,
  tenant_id    TEXT,                               -- bound at acceptance
  client_email TEXT NOT NULL,                      -- who must accept
  role         TEXT NOT NULL DEFAULT 'staff',      -- support | staff | admin (never owner)
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | accepted | revoked | expired
  token_hash   TEXT UNIQUE,                        -- invite token (pending only)
  expires_at   TEXT NOT NULL,                      -- invite expiry
  accepted_by  TEXT,
  accepted_at  TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agency_grants ON agency_grants(agency_id, status);
CREATE INDEX IF NOT EXISTS idx_agency_grants_tenant ON agency_grants(tenant_id, status);

-- Agency-private kits: scrubbed layout/structure only (the scrubber excludes
-- customer data, secrets, domains, private media paths and catalog ids).
CREATE TABLE IF NOT EXISTS agency_kits (
  id         TEXT PRIMARY KEY,                     -- akit_<hex>
  agency_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  source_note TEXT,                                -- which client it came from (name only)
  payload    TEXT NOT NULL,                        -- scrubbed JSON
  created_at TEXT NOT NULL
);

-- Client approvals: bound to an IMMUTABLE content hash — approving hash A
-- never authorizes a changed draft (hash B).
CREATE TABLE IF NOT EXISTS client_approvals (
  id           TEXT PRIMARY KEY,                   -- apr_<hex>
  agency_id    TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  note         TEXT,
  token_hash   TEXT UNIQUE,                        -- signed public decision link
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected | expired
  approver     TEXT,                               -- typed identity of the decider
  comment      TEXT,
  expires_at   TEXT NOT NULL,
  decided_at   TEXT,
  created_at   TEXT NOT NULL
);

-- Referral attribution (one agency per store) + the commission ledger.
-- One ledger row per (billing event, kind): recompute runs are idempotent,
-- revenue is never counted twice, refunds reverse exactly once.
CREATE TABLE IF NOT EXISTS agency_referrals (
  tenant_id  TEXT PRIMARY KEY,
  agency_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'attributed',   -- attributed | void
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_commissions (
  id               TEXT PRIMARY KEY,               -- acm_<hex>
  agency_id        TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  billing_event_id TEXT NOT NULL UNIQUE,           -- ties 1:1 to the billing ledger
  kind             TEXT NOT NULL,                  -- earned | reversed
  base_amount      INTEGER NOT NULL,               -- the event's amount (minor units)
  amount           INTEGER NOT NULL,               -- commission (minor units; reversed = negative)
  period           TEXT NOT NULL,                  -- YYYY-MM of the event
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agency_commissions ON agency_commissions(agency_id, period);

-- MK06: case studies — publication is GATED on documented consent and a
-- measurement record; a lift claim without either cannot publish.
CREATE TABLE IF NOT EXISTS case_studies (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  tenant_id    TEXT,                               -- the merchant it is about
  consent_ref  TEXT,                               -- who approved, when, how (required to publish)
  period       TEXT,                               -- measurement window (required to publish)
  baseline     TEXT,                               -- what was measured before
  method       TEXT,                               -- how it was measured (required to publish)
  limitations  TEXT,
  confounders  TEXT,                               -- important concurrent changes
  results      TEXT,                               -- JSON [{metric, before, after, measured: true}]
  quote        TEXT,
  quote_by     TEXT,
  body         TEXT,                               -- narrative
  published    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
