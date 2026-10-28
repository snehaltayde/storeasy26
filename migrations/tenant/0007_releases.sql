-- S36 (BE09): immutable content releases. A release is a frozen snapshot of
-- the tenant's content set (cms blocks + pages + brand tokens) with a content
-- hash; release_state is the SINGLE live pointer — publishing and rollback
-- are one atomic UPDATE of that row, and drafts (cms_blocks/cms_pages) are
-- never touched by either. No live pointer = pre-first-publish: the
-- storefront keeps serving drafts exactly as before this migration.
CREATE TABLE IF NOT EXISTS releases (
  id            TEXT PRIMARY KEY,      -- "rel_" + 16 hex
  content       TEXT NOT NULL,         -- canonical JSON {v, blocks, pages, brand}
  content_hash  TEXT NOT NULL,         -- sha256 hex of the canonical content
  note          TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  scheduled_for TEXT,                  -- publish-at instant (UTC ISO) | null
  published_at  TEXT                   -- stamped when the pointer first flips here
);
CREATE INDEX IF NOT EXISTS idx_releases_created ON releases (created_at DESC);

CREATE TABLE IF NOT EXISTS release_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  live_release_id TEXT,
  updated_at      TEXT
);
INSERT OR IGNORE INTO release_state (id, live_release_id, updated_at) VALUES (1, NULL, NULL);
