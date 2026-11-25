-- Phase 8 line 2: the prepaid nudge and the cash-on-delivery OTP (additive).
-- cod_otps holds one challenge per cart, idempotency key, phone and amount;
-- the code is stored only as sha256(code|challengeId|store link secret) and the
-- phone only as sha256(e164|secret). orders gain the prepaid discount they were
-- charged with and when a COD order's phone was confirmed by code.
CREATE TABLE IF NOT EXISTS cod_otps (
  id TEXT PRIMARY KEY,            -- otp_<hex>
  cart_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  phone_hash TEXT NOT NULL,       -- sha256(e164|secret)
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  channel TEXT NOT NULL,          -- sms | email
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 1, last_sent_at TEXT NOT NULL,
  verified_at TEXT, order_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cod_otps_cart ON cod_otps(cart_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cod_otps_phone ON cod_otps(phone_hash, created_at);
ALTER TABLE orders ADD COLUMN payment_discount REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN cod_verified_at TEXT;
