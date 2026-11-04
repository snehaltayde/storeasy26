-- P4-SCAFFOLD (OVL-02, MIG-01, MIG-03, MIG-04; spec 8.2, phase 4 plan
-- decision 2): the live product and collection content tables, the search
-- outbox, and the cutover and reversal bookkeeping.
-- Additive only, and safe to re-run: CREATE … IF NOT EXISTS.
--
-- The DDL is PINNED here. A later column need is a new 0026 file with a named
-- owner in a plan update, never an edit to this file.
--
-- Nothing reads these tables yet, and their presence selects no behaviour:
-- a tenant with or without them renders and saves exactly the same.

-- What shoppers see for an edited product. Null means follow Shopify.
-- Spec 8.2 columns, plus pairs_title and layout_template (plan section 2).
CREATE TABLE IF NOT EXISTS product_content_live (
  product_id          TEXT PRIMARY KEY,   -- Shopify id
  document_id         TEXT NOT NULL,
  version_id          TEXT NOT NULL,
  title               TEXT,
  description         TEXT,
  description_html    TEXT,
  featured_image      TEXT,
  featured_image_alt  TEXT,
  gallery             TEXT,               -- JSON list of {url, alt}
  seo_title           TEXT,
  seo_description     TEXT,
  og_image            TEXT,
  display_vendor      TEXT,
  display_type        TEXT,
  badge               TEXT,
  modules             TEXT,               -- JSON; selected only by the product page
  layout_document_id  TEXT,
  pairs               TEXT,               -- JSON list of product ids
  keep_variant_images INTEGER,            -- OVL-10
  published_at        TEXT NOT NULL,
  pairs_title         TEXT,
  layout_template     TEXT
);
CREATE INDEX IF NOT EXISTS product_content_live_document ON product_content_live(document_id);

-- The same for collections: pins and layout. Spec 8.2 plus layout_template.
CREATE TABLE IF NOT EXISTS collection_content_live (
  collection_id       TEXT PRIMARY KEY,
  document_id         TEXT NOT NULL,
  version_id          TEXT NOT NULL,
  pinned              TEXT,
  layout_document_id  TEXT,
  published_at        TEXT NOT NULL,
  layout_template     TEXT
);

-- Products whose search entry must change (OVL-17, plan decision 15).
CREATE TABLE IF NOT EXISTS search_outbox (
  product_id  TEXT NOT NULL,
  handle      TEXT,                       -- for deleting a product that no longer exists
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS search_outbox_pending ON search_outbox(created_at) WHERE done_at IS NULL;

-- The resumable state and lock of one cutover or reversal (MIG-03, MIG-04).
-- Not in spec 8.2 (plan section 2).
CREATE TABLE IF NOT EXISTS cms_migration_runs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('cutover', 'reverse')),
  step            TEXT NOT NULL,
  source_hash     TEXT,
  dry_run_digest  TEXT,
  backup_ref      TEXT,
  report          TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  outcome         TEXT
);

-- Where a reversal (MIG-04) copies live rows aside before deleting them.
-- A fixed table instead of the spec's _reversed_<date> (plan section 2).
CREATE TABLE IF NOT EXISTS content_live_reversed (
  run_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  row_json     TEXT NOT NULL,
  reversed_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, entity_id)
);
