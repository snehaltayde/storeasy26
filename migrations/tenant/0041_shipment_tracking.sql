-- Phase 9 line 4 (Shiprocket): a parcel's tracking as Storeasy last fetched it
-- from the courier (never a webhook body: lib/couriers/sync.js refetches by
-- AWB), the courier API token cache (encrypted) and the per-PIN
-- serviceability cache (12 h). Additive: new tables only.
CREATE TABLE IF NOT EXISTS shipment_tracking (awb TEXT PRIMARY KEY, order_id TEXT NOT NULL, courier TEXT, status TEXT NOT NULL,
  status_label TEXT, etd TEXT, delivered_at TEXT, return_awb TEXT, scans TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL,
  last_event_at TEXT, fetched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_shipment_order ON shipment_tracking(order_id);
CREATE INDEX IF NOT EXISTS idx_shipment_open ON shipment_tracking(status, fetched_at);
CREATE TABLE IF NOT EXISTS courier_auth (provider TEXT PRIMARY KEY, token_enc TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS courier_pin_cache (pin TEXT PRIMARY KEY, serviceable INTEGER, cod INTEGER, min_days INTEGER,
  max_days INTEGER, fetched_at TEXT NOT NULL);
