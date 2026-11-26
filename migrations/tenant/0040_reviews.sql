-- Phase 9 line 1: product reviews from a signed invite link (docs/plans/phase-9.md
-- "Line 1"). Additive. One invite per (order, product), made when the order is
-- fulfilled; one review per invite (invite_id UNIQUE, used_at set in the same
-- batch as the review insert). Shoppers read only status 'approved'. No email
-- column anywhere: an opt-out is kept as a hash of the email.
CREATE TABLE IF NOT EXISTS review_invites (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL,
  customer_id TEXT, send_after TEXT NOT NULL, sent_at TEXT, expires_at TEXT NOT NULL, used_at TEXT, review_id TEXT,
  created_at TEXT NOT NULL, UNIQUE(order_id, product_id));
CREATE INDEX IF NOT EXISTS idx_review_invites_due ON review_invites(sent_at, send_after);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, order_id TEXT NOT NULL,
  invite_id TEXT NOT NULL UNIQUE, customer_id TEXT, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT, body TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT, reply TEXT, reply_by TEXT, reply_at TEXT, moderated_by TEXT, moderated_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
CREATE TABLE IF NOT EXISTS review_optouts (email_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL);
