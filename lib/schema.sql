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
