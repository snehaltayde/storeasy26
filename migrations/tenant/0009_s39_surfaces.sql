-- S39 (BE23 + SF15 + SF17 + MC05 + MC06): notification intents, contact
-- messages, catalog presentation overrides, campaign page scheduling.

-- BE23: durable notification intents. One row per message; the jobs queue
-- carries delivery (type send_notification), so a provider blip retries with
-- backoff and the final state here is honest: queued | sent | failed.
-- consent_class separates transactional from marketing at the schema level —
-- marketing sends additionally require a consent reference (lib/notifications).
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,            -- ntf_<hex>
  type            TEXT NOT NULL,               -- contact_message | …
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
  error           TEXT,
  provider_id     TEXT,                        -- provider message id ('mock' when unsent dev mock)
  consent_class   TEXT NOT NULL DEFAULT 'transactional', -- transactional | marketing
  consent_ref     TEXT,                        -- required for marketing
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idem ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);

-- SF15: shopper contact messages (the storefront form). The merchant copy
-- goes out as a notification; the row here is the console's inbox.
CREATE TABLE IF NOT EXISTS contact_messages (
  id              TEXT PRIMARY KEY,            -- msg_<hex>
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  message         TEXT NOT NULL,
  notification_id TEXT,                        -- the merchant-notify intent
  created_at      TEXT NOT NULL
);

-- MC05: per-product presentation overrides (catalog values stay Shopify's;
-- these are additive storefront presentation, live-on-save like placements).
CREATE TABLE IF NOT EXISTS product_overrides (
  product_id TEXT PRIMARY KEY,                 -- Shopify product GID
  modules    TEXT NOT NULL DEFAULT '[]',       -- [{title, html (sanitized at save)}]
  badge      TEXT,                             -- short PDP badge, e.g. "Lab tested"
  updated_at TEXT
);

-- MC06: per-collection merchandising — pinned products lead the "featured"
-- sort; everything else keeps Shopify's position.
CREATE TABLE IF NOT EXISTS collection_overrides (
  collection_id TEXT PRIMARY KEY,              -- Shopify collection GID
  pinned        TEXT NOT NULL DEFAULT '[]',    -- [product gid, …] in display order
  updated_at    TEXT
);

-- SF17: campaign landing pages are cms_pages rows with family='campaign',
-- served at /campaigns/<slug> inside their UTC visibility window.
ALTER TABLE cms_pages ADD COLUMN family TEXT NOT NULL DEFAULT 'page';
ALTER TABLE cms_pages ADD COLUMN window_start TEXT;
ALTER TABLE cms_pages ADD COLUMN window_end TEXT;
