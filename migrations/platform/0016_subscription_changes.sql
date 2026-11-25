-- Phase 3 line 3 (review): a store has at most one current subscription.
-- A plan change marks every live row it ends with replaced_by (the new row's
-- id), in the same batch as the new row, and a unique partial index refuses a
-- second current row, so two changes at once cannot both win. A replaced
-- Razorpay subscription keeps its own status until its cycle-end webhook; its
-- cancel at Razorpay is tracked in cancel_state, and a failed one is retried by
-- the next change and shown in the operator's exception queue.
-- Additive: two nullable columns and one index. The backfill only marks older
-- live rows of a store that already has two (the merchant subscribe path made
-- them before this); it deletes nothing and is safe to run again.

ALTER TABLE subscriptions ADD COLUMN replaced_by TEXT;   -- sub_ id of the row that replaced this one
ALTER TABLE subscriptions ADD COLUMN cancel_state TEXT;  -- NULL | pending | cycle_end | now | failed (provider rows)
ALTER TABLE subscriptions ADD COLUMN cancel_error TEXT;  -- the provider's error text (operator-only)

UPDATE subscriptions
SET replaced_by = (
      SELECT s2.id FROM subscriptions s2
      WHERE s2.tenant_id = subscriptions.tenant_id AND s2.status NOT IN ('cancelled', 'completed', 'expired')
      ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
    ),
    cancel_state = CASE WHEN razorpay_subscription_id IS NOT NULL THEN 'failed' END,
    cancel_error = CASE WHEN razorpay_subscription_id IS NOT NULL THEN 'still live when migration 0016 ran: cancel it' END
WHERE replaced_by IS NULL
  AND status NOT IN ('cancelled', 'completed', 'expired')
  AND id <> (
      SELECT s3.id FROM subscriptions s3
      WHERE s3.tenant_id = subscriptions.tenant_id AND s3.status NOT IN ('cancelled', 'completed', 'expired')
      ORDER BY s3.created_at DESC, s3.id DESC LIMIT 1
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_current ON subscriptions(tenant_id)
  WHERE replaced_by IS NULL AND status NOT IN ('cancelled', 'completed', 'expired');
