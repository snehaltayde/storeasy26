-- Phase 1 line 9: an operator creates a store for a founder in one form
-- (docs/plans/phase-1.md, Line 9). An operator-made store is a signups row with
-- source 'operator', run through the same provision_store job; when the job
-- finishes it emails an owner invite instead of making a user.
-- Nothing destructive: added columns and two indexes.

ALTER TABLE signups ADD COLUMN source TEXT NOT NULL DEFAULT 'signup'; -- signup | operator
ALTER TABLE signups ADD COLUMN created_by TEXT;          -- the operator's user id
ALTER TABLE signups ADD COLUMN shop_domain TEXT;         -- normalised x.myshopify.com
ALTER TABLE signups ADD COLUMN shopify_client_id TEXT;
ALTER TABLE signups ADD COLUMN shopify_secret_enc TEXT;  -- encryptSecret k1:, NULL once done
ALTER TABLE signups ADD COLUMN invite_id TEXT;
ALTER TABLE signups ADD COLUMN invite_status TEXT;       -- sent | mock | failed

-- one live operator-made store per Shopify store (a double submit is refused)
CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_shop_live ON signups(shop_domain)
  WHERE shop_domain IS NOT NULL AND status IN ('verified','provisioning','failed');
CREATE INDEX IF NOT EXISTS idx_signups_source ON signups(source, created_at);
