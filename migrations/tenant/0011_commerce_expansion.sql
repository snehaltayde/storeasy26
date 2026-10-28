-- S46 (BE31 + SF18–21): commerce expansion — bundles, product-finder
-- quizzes, journal slug redirects, return requests.

-- BE31: bundles are LOCAL curated sets priced through the offers engine
-- (each bundle keeps a linked offers row of type BUNDLE in sync — the cart,
-- checkout and push pipelines see just another offer; no new money paths).
-- Selling plans (shopper subscriptions) are NOT part of this schema — they
-- need recurring shopper payments and are recorded as not-built.
CREATE TABLE IF NOT EXISTS bundles (
  id           TEXT PRIMARY KEY,              -- bun-<hex>
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT,
  items        TEXT NOT NULL,                 -- JSON [{variantId, quantity}]
  bundle_price REAL NOT NULL,                 -- what the set costs together
  enabled      INTEGER NOT NULL DEFAULT 0,    -- enable passes compatibility checks
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- SF19: deterministic product-finder quizzes (no AI at runtime — options
-- carry tag weights; scoring is arithmetic; recommendations are a catalog
-- query over the winning tags).
CREATE TABLE IF NOT EXISTS quizzes (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  intro      TEXT,
  questions  TEXT NOT NULL,                   -- JSON [{id, prompt, options:[{id,label,tags:[...]}]}]
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- SF20: journal slug changes keep old URLs alive.
CREATE TABLE IF NOT EXISTS page_redirects (
  from_slug  TEXT PRIMARY KEY,
  to_slug    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- SF21: return requests. APPROVAL IS NOT A REFUND — approving authorizes
-- the return; money moves only through the provider refund flow (S31
-- mirrors it back), and the UI says so everywhere.
CREATE TABLE IF NOT EXISTS return_requests (
  id          TEXT PRIMARY KEY,               -- ret_<hex>
  order_id    TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'requested',  -- requested | approved | rejected | completed
  note        TEXT,                           -- merchant note shown to the shopper
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_return_requests_order ON return_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_return_requests_status ON return_requests(status, created_at);
