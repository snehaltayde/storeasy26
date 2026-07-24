-- Local catalog cache, synced from the Shopify Storefront API.
-- Pages read from here (sub-ms SQLite reads) instead of hitting Shopify.

CREATE TABLE IF NOT EXISTS products (
  id                 TEXT PRIMARY KEY,        -- Shopify product GID
  handle             TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  description        TEXT,                     -- plain text (search + meta)
  description_html   TEXT,                     -- rich text (PDP body)
  product_type       TEXT,
  vendor             TEXT,
  tags               TEXT,                     -- JSON array of strings
  price_min          REAL,
  price_max          REAL,
  compare_at_min     REAL,
  currency           TEXT,
  available          INTEGER NOT NULL DEFAULT 0,
  total_inventory    INTEGER,
  featured_image     TEXT,
  featured_image_alt TEXT,
  options            TEXT,                     -- JSON [{name, values: []}]
  created_at         TEXT,
  updated_at         TEXT,
  synced_at          TEXT
);

CREATE TABLE IF NOT EXISTS product_images (
  id          TEXT PRIMARY KEY,               -- synthesized: <productId>::img::<i>
  product_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  alt         TEXT,
  width       INTEGER,
  height      INTEGER,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS variants (
  id               TEXT PRIMARY KEY,          -- Shopify variant GID
  product_id       TEXT NOT NULL,
  title            TEXT,
  sku              TEXT,
  price            REAL,
  compare_at_price REAL,
  currency         TEXT,
  available        INTEGER NOT NULL DEFAULT 0,
  selected_options TEXT,                       -- JSON [{name, value}]
  image_url        TEXT,
  position         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,               -- Shopify collection GID
  handle      TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT,
  image       TEXT,
  image_alt   TEXT,
  updated_at  TEXT,
  synced_at   TEXT
);

CREATE TABLE IF NOT EXISTS collection_products (
  collection_id TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_images_product       ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_product             ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_collection_products_coll     ON collection_products(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_products_product  ON collection_products(product_id);
CREATE INDEX IF NOT EXISTS idx_products_type                ON products(product_type);

-- DB-backed cart sessions (keyed by an httpOnly cookie). IDs are stored as FULL
-- Shopify GIDs to match products.id / variants.id, so the offer engine
-- (Session 4) can join cart items straight onto the catalog with no conversion.
CREATE TABLE IF NOT EXISTS carts (
  id          TEXT PRIMARY KEY,        -- session id (== cookie value)
  coupon_code TEXT,
  created_at  TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id    TEXT NOT NULL,
  variant_id TEXT NOT NULL,            -- gid://shopify/ProductVariant/...
  product_id TEXT NOT NULL,            -- gid://shopify/Product/...
  quantity   INTEGER NOT NULL,
  added_at   TEXT,
  PRIMARY KEY (cart_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);

-- Orders from the custom guest checkout (Session 10: first-class, durable,
-- idempotent). One row per PAYMENT ATTEMPT, keyed by idempotency_key — a retry
-- or duplicate callback re-reads the existing row instead of inserting twice.
--
--   status  = workflow position (state machine, see lib/orders.js):
--             pending_payment | cod_pending → paid → syncing_shopify → synced
--             (+ sync_failed retry loop, + cancelled)
--   payment_status = money state shown to the user: pending | paid | cod
--   snapshot = full JSON record (items, gifts, applied offers, coupon, totals,
--              shipping, address, payment refs) so the Session-12 Shopify push
--              can reproduce the exact discount representation.
CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,       -- e.g. BL-1A2B3C4D
  idempotency_key     TEXT,                   -- one per checkout intent (UNIQUE below)
  cart_id             TEXT,                   -- source cart, so the webhook can clear it
  email               TEXT,
  phone               TEXT,
  name                TEXT,
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  state               TEXT,
  pincode             TEXT,
  country             TEXT,
  subtotal            REAL,
  discount_total      REAL,
  shipping_total      REAL NOT NULL DEFAULT 0,
  total               REAL,
  currency            TEXT,
  coupon_code         TEXT,
  applied_offers      TEXT,                   -- JSON snapshot (also inside snapshot)
  snapshot            TEXT,                   -- full JSON snapshot (see above)
  payment_method      TEXT,                   -- cod | razorpay
  payment_status      TEXT,                   -- pending | paid | cod
  status              TEXT NOT NULL DEFAULT 'pending_payment',
  razorpay_order_id   TEXT,
  razorpay_payment_id TEXT,
  shopify_order_id    TEXT,                   -- set on synced (Session 12)
  sync_attempts       INTEGER NOT NULL DEFAULT 0,
  sync_error          TEXT,                   -- last sync failure (also in order_events)
  created_at          TEXT,
  updated_at          TEXT,
  paid_at             TEXT,
  synced_at           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_razorpay ON orders(razorpay_order_id);

CREATE TABLE IF NOT EXISTS order_items (
  order_id      TEXT NOT NULL,
  variant_id    TEXT,
  product_id    TEXT,
  title         TEXT,
  variant_title TEXT,
  image         TEXT,
  unit_price    REAL,
  quantity      INTEGER,
  line_total    REAL,
  line_discount REAL,
  is_gift       INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- First-party event pipeline (Session 14). Every funnel event is persisted
-- HERE before any forwarding (store-then-forward): a GA4/Meta blip never drops
-- an event — the sweep replays pending rows with bounded backoff. event_id is
-- UNIQUE (client retries + server/client purchase copies collapse into one
-- row); payload holds value/currency/items/params + HASHED user_data only —
-- raw PII is never stored. cart_id links events to the buyer's cart so the
-- server-side purchase inherits the browser's first-party identity.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL,
  name            TEXT NOT NULL,          -- GA4-style: view_item … purchase
  client_id       TEXT,                   -- first-party _fp_cid (or _ga-derived)
  fbp             TEXT,
  fbc             TEXT,
  gclid           TEXT,
  ip              TEXT,
  user_agent      TEXT,
  url             TEXT,
  referrer        TEXT,
  cart_id         TEXT,
  order_id        TEXT,
  payload         TEXT NOT NULL,          -- JSON (hashed PII only)
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | forwarded | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TEXT,
  ga4_sent_at     TEXT,
  meta_sent_at    TEXT,
  created_at      TEXT NOT NULL,
  forwarded_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_cart ON events(cart_id);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);

-- Offer configuration (Session 19): BeastLife edits offers WITHOUT a deploy.
-- `config` holds the full engine-shaped offer object (lib/offers/engine.js);
-- enabled + schedule window are promoted columns so the cart's per-read query
-- stays a simple indexed filter. Seeded once from lib/offers/config.js.
CREATE TABLE IF NOT EXISTS offers (
  id         TEXT PRIMARY KEY,         -- slug, e.g. "tiered-whey"
  type       TEXT NOT NULL,            -- BXGY | TIERED_QTY | FREE_GIFT | COUPON
  label      TEXT NOT NULL,            -- admin display (engine title lives in config)
  enabled    INTEGER NOT NULL DEFAULT 1,
  starts_at  TEXT,                     -- ISO; NULL = no lower bound
  ends_at    TEXT,                     -- ISO; NULL = no upper bound
  config     TEXT NOT NULL,            -- JSON engine offer object
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_offers_enabled ON offers(enabled);

-- First-party error tracking (Session 17). Errors are FINGERPRINTED (source +
-- name + message + top frame) and upserted — one row per distinct error with a
-- running count, so a repeating error is one alert (throttled hourly), not a
-- flood. Swap in Sentry later by forwarding from lib/errors.js; the sink stays.
CREATE TABLE IF NOT EXISTS app_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL,
  source          TEXT NOT NULL,          -- server | edge | client
  name            TEXT,
  message         TEXT,
  stack           TEXT,                   -- first ~2KB
  url             TEXT,
  digest          TEXT,                   -- Next error digest (matches error.js UI)
  count           INTEGER NOT NULL DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  last_alerted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_errors_fingerprint ON app_errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_app_errors_last_seen ON app_errors(last_seen);

-- Persisted status transitions — an append-only audit trail per order.
-- from_status NULL = order creation.
CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  meta        TEXT,                           -- JSON: payment ids, sync attempt, errors
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
