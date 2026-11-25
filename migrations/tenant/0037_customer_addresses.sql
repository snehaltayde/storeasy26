-- Phase 8 line 3: a signed-in shopper's saved addresses (docs/plans/phase-8.md,
-- decision 2). Additive, plus one data copy: each customer's old
-- default_address becomes their default row. The old column stays and is no
-- longer read. Shopper data with no console read (decision 7).
-- address_key is every field but the label, lower(trim()) and joined by '|'
-- (lib/addresses.js addressKey builds the same string), unique per
-- shopper, so the same address can't be saved twice even by parallel saves.
-- A default_address without a city, state or pincode is not copied.
CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, label TEXT,
  name TEXT NOT NULL, phone TEXT NOT NULL, line1 TEXT NOT NULL, line2 TEXT,
  city TEXT NOT NULL, state TEXT NOT NULL, pincode TEXT NOT NULL, country_code TEXT NOT NULL DEFAULT 'IN',
  is_default INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  address_key TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id, is_default, last_used_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_addresses_key ON customer_addresses(customer_id, address_key);
INSERT INTO customer_addresses (id, customer_id, name, phone, line1, line2, city, state, pincode, is_default, created_at, updated_at, address_key)
  SELECT 'adr_' || lower(hex(randomblob(8))), x.id, x.name, x.phone, x.line1, x.line2, x.city, x.state, x.pincode, 1, x.created_at, x.created_at,
    lower(trim(x.name)) || '|' || lower(trim(x.phone)) || '|' || lower(trim(x.line1)) || '|' || lower(trim(COALESCE(x.line2, ''))) || '|' ||
    lower(trim(x.city)) || '|' || lower(trim(x.state)) || '|' || lower(trim(x.pincode)) || '|in'
  FROM (SELECT c.id, c.created_at, COALESCE(json_extract(c.default_address,'$.name'), c.name, '') AS name, COALESCE(json_extract(c.default_address,'$.phone'), c.phone, '') AS phone,
      json_extract(c.default_address,'$.line1') AS line1, json_extract(c.default_address,'$.line2') AS line2, json_extract(c.default_address,'$.city') AS city,
      json_extract(c.default_address,'$.state') AS state, json_extract(c.default_address,'$.pincode') AS pincode
    FROM customers c WHERE json_valid(c.default_address) AND json_extract(c.default_address,'$.line1') IS NOT NULL
      AND COALESCE(json_extract(c.default_address,'$.city'),'') <> '' AND COALESCE(json_extract(c.default_address,'$.state'),'') <> ''
      AND COALESCE(json_extract(c.default_address,'$.pincode'),'') <> ''
      AND NOT EXISTS (SELECT 1 FROM customer_addresses a WHERE a.customer_id = c.id)) x;
