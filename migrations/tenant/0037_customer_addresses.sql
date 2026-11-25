-- Phase 8 line 3: a signed-in shopper's saved addresses (docs/plans/phase-8.md,
-- decision 2). Additive, plus one data copy: each customer's old
-- default_address becomes their default row. The old column stays and is no
-- longer read. Shopper data with no console read (decision 7).
CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, label TEXT,
  name TEXT NOT NULL, phone TEXT NOT NULL, line1 TEXT NOT NULL, line2 TEXT,
  city TEXT NOT NULL, state TEXT NOT NULL, pincode TEXT NOT NULL, country_code TEXT NOT NULL DEFAULT 'IN',
  is_default INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id, is_default, last_used_at);
INSERT INTO customer_addresses (id, customer_id, name, phone, line1, line2, city, state, pincode, is_default, created_at, updated_at)
  SELECT 'adr_' || lower(hex(randomblob(8))), c.id, COALESCE(json_extract(c.default_address,'$.name'), c.name, ''), COALESCE(json_extract(c.default_address,'$.phone'), c.phone, ''),
    json_extract(c.default_address,'$.line1'), json_extract(c.default_address,'$.line2'), json_extract(c.default_address,'$.city'),
    json_extract(c.default_address,'$.state'), json_extract(c.default_address,'$.pincode'), 1, c.created_at, c.created_at
  FROM customers c WHERE json_valid(c.default_address) AND json_extract(c.default_address,'$.line1') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM customer_addresses a WHERE a.customer_id = c.id);
