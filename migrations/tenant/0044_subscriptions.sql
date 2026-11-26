-- Phase 9 line 2: subscriptions (scheduled re-orders, paid at each renewal
-- checkout; nothing is charged automatically). Additive. A subscription is
-- created from a placed order's line (UNIQUE origin order + line, so a replay
-- of the order's effects creates nothing twice), keeps the discount percent it
-- was signed up at (the price follows the product), and is never deleted:
-- cancelled rows stay, privacy erase sets customer_id NULL. One row per cycle
-- in subscription_cycles; order_id UNIQUE, so one order per cycle.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,                 -- sub_<hex>
  customer_id TEXT,                    -- NULL once anonymized
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  interval_days INTEGER NOT NULL,
  discount_percent REAL NOT NULL,      -- locked at signup
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | cancelled
  next_due_at TEXT NOT NULL,           -- ISO 8601 UTC
  paused_until TEXT,                   -- NULL = paused until resumed
  cycle INTEGER NOT NULL DEFAULT 1,    -- the next delivery's cycle number
  missed_in_row INTEGER NOT NULL DEFAULT 0,
  swap_variant_id TEXT,                -- a swap asked for while a delivery was due: applies from the next cycle
  swap_product_id TEXT,
  origin_order_id TEXT NOT NULL,
  origin_line TEXT NOT NULL,           -- the origin order's variant id
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(origin_order_id, origin_line)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(status, next_due_at);

CREATE TABLE IF NOT EXISTS subscription_cycles (
  subscription_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,                -- due | ordered | skipped (the shopper) | skipped_off (no reminder: the plugin was off) | missed
  order_id TEXT UNIQUE,
  reminded_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(subscription_id, cycle)
);

-- a cart line is one-time (NULL) or subscribed every N days
ALTER TABLE cart_items ADD COLUMN subscription_interval INTEGER;
-- 1 = the line "Pay for this delivery" put in a renewal cart (removed once that delivery no longer stands)
ALTER TABLE cart_items ADD COLUMN renewal INTEGER;
-- a renewal cart: built by "Pay for this delivery" for one subscription's cycle
ALTER TABLE carts ADD COLUMN subscription_id TEXT;
ALTER TABLE carts ADD COLUMN subscription_cycle INTEGER;
