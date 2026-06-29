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
