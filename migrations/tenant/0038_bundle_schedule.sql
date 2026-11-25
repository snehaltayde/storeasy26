-- 0038_bundle_schedule (Phase 8 line 5, decision 3): a bundle's schedule
-- window, UTC ISO 8601. starts_at is inclusive, ends_at exclusive; NULL means
-- no bound. lib/bundles.js syncOffer mirrors the window onto the bundle's
-- `bundle-<id>` offers row, and lib/commerce/bundle-read.js shows a mismatch
-- as offer_differs. Additive; readers use hasColumns (MIG-05). The ALTERs are
-- not re-runnable (README rule 3).
ALTER TABLE bundles ADD COLUMN starts_at TEXT;
ALTER TABLE bundles ADD COLUMN ends_at TEXT;
