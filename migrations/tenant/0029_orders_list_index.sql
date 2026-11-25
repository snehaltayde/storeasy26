-- 0029_orders_list_index (Phase 2 line 2): the console's orders list pages by
-- the pair (created_at, id), newest first, with or without a status filter.
-- Additive and re-runnable: indexes only, no column or row changes.
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC, id DESC);
