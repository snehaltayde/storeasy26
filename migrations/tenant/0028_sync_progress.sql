-- 0028_sync_progress (Phase 1 line 5): progress of N for collections, and the
-- products and collections a run skipped. Additive: older runs read NULL / 0.
-- NOTE: the ALTERs are not re-runnable (migrations/README.md rule 3); code
-- detects these columns (lib/sync.js hasProgressColumns) and syncs without them.
ALTER TABLE sync_runs ADD COLUMN collections_total INTEGER;
ALTER TABLE sync_runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
-- JSON [{ type: "product" | "collection", id, handle, title, reason, kept? }],
-- at most 50, deduplicated by id
ALTER TABLE sync_runs ADD COLUMN skipped TEXT;
-- bit 1 products, 2 collections: a skip without a usable Shopify id held that
-- table's prune for this run (the next clean run prunes)
ALTER TABLE sync_runs ADD COLUMN no_prune INTEGER NOT NULL DEFAULT 0;
