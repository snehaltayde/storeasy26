-- S38 (BE15 + SF14): tenant media library + policy-page effective dates.
--
-- Media blobs live in the TENANT's own database: uploads are tenant-bound by
-- construction (the admin session resolves the tenant, the write lands in that
-- tenant's DB, and /api/media/<id> can only ever read the resolving host's
-- rows). Files are small by policy (lib/media.js caps + client-side resize),
-- content-addressed (sha256 dedupe) and immutable once written — derivatives
-- are separate rows pointing at their original via parent_id.
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,              -- med_<hex>, random
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,                 -- allowlisted (lib/media.js)
  size       INTEGER NOT NULL,              -- bytes, capped at write
  width      INTEGER,                       -- px, as reported by the uploader
  height     INTEGER,
  alt        TEXT NOT NULL DEFAULT '',
  variant    TEXT,                          -- NULL = original; 'thumb' = derivative
  parent_id  TEXT,                          -- original this row is a variant of
  sha256     TEXT NOT NULL,                 -- dedupe key (per variant)
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_parent ON media(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha ON media(sha256, ifnull(variant, ''));

-- SF14: policy pages carry an optional effective date (shown on the page).
ALTER TABLE cms_pages ADD COLUMN effective_at TEXT;
