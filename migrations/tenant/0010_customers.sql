-- S45 (BE30 + SF10–12): shopper customer accounts — SELF-MANAGED per store,
-- in the TENANT's own database (cross-store same-email isolation is
-- structural: another store's accounts live in another database entirely).
-- Passwordless: email OTP (hashed at rest), revocable sessions (hashed
-- tokens). Guest purchase is untouched — accounts are optional, and orders
-- bind to an account ONLY after the email is verified by OTP.
CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY,            -- cus_<hex>
  email           TEXT NOT NULL UNIQUE,        -- lowercased
  name            TEXT,
  phone           TEXT,
  default_address TEXT,                        -- JSON (same shape as order shipping)
  created_at      TEXT NOT NULL,
  last_login_at   TEXT
);

CREATE TABLE IF NOT EXISTS customer_otps (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,                   -- sha256(code|order-link secret)
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_otps_email ON customer_otps(email, created_at);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash  TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_cust ON customer_sessions(customer_id);

-- subject binding: set ONLY after OTP verification of the matching email
ALTER TABLE orders ADD COLUMN customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
