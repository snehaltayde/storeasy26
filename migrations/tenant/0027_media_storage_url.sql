-- 0027_media_storage_url: optional external object storage URL/key (Cloudflare R2 / S3).
-- Additive and backward-compatible: existing SQLite/Turso BLOB rows have storage_url = NULL
-- and continue serving from media.data until migrated or replaced.
ALTER TABLE media ADD COLUMN storage_url TEXT;
