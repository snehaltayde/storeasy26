-- Order projection dimensions (Session 31 / BE10): financial and fulfillment
-- state live in their OWN columns/tables, mirrored from Shopify by
-- authoritative reconciliation (lib/order-projection.js) — the local `status`
-- state machine (payment capture + push) no longer doubles as either.
-- NOTE: ALTERs are not re-runnable (migrations/README.md rule 3).
CREATE TABLE IF NOT EXISTS order_fulfillments (
  id               TEXT PRIMARY KEY,     -- Shopify fulfillment id/gid
  order_id         TEXT NOT NULL,        -- our BL- id
  status           TEXT,                 -- SUCCESS | CANCELLED | …
  tracking_company TEXT,
  tracking_number  TEXT,
  tracking_url     TEXT,
  updated_at       TEXT                  -- provider timestamp
);
CREATE INDEX IF NOT EXISTS idx_fulfillments_order ON order_fulfillments(order_id);

CREATE TABLE IF NOT EXISTS order_refunds (
  id         TEXT PRIMARY KEY,           -- Shopify refund id/gid (natural dedup)
  order_id   TEXT NOT NULL,
  amount     REAL NOT NULL,              -- major units, same as orders.total
  currency   TEXT,
  note       TEXT,
  created_at TEXT                        -- provider timestamp
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON order_refunds(order_id);

ALTER TABLE orders ADD COLUMN financial_status TEXT;      -- pending|paid|partially_refunded|refunded|voided (provider-mirrored)
ALTER TABLE orders ADD COLUMN fulfillment_status TEXT;    -- unfulfilled|partially_fulfilled|fulfilled|… (provider-mirrored)
ALTER TABLE orders ADD COLUMN refunded_total REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN provider_updated_at TEXT;   -- out-of-order watermark
