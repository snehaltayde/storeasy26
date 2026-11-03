-- P2-ATOM (DOC-01, PUB-01): the document store, as in spec 8.2.
-- Additive only, and safe to re-run: CREATE … IF NOT EXISTS and INSERT OR IGNORE.
-- Nothing reads these tables on a legacy tenant. cms_state is seeded 'legacy',
-- so every tenant stays on today's releases, editors and preview.
--
-- Not here on purpose (later items): document_refs, document_schedules,
-- product_content_live, collection_content_live, search_outbox, preview_sessions.

-- One row per document. Holds the working draft.
CREATE TABLE IF NOT EXISTS documents (
  id                   TEXT PRIMARY KEY,    -- doc_<type> (singletons), doc_<16 base32> (editor-made), doc_p_<hash> (backfill)
  type                 TEXT NOT NULL,       -- registered document type
  slug                 TEXT,                -- route documents only: a cache of the draft's meta.slug
  entity_id            TEXT,                -- Shopify id, for product_content and collection_content
  label                TEXT NOT NULL,       -- console name
  draft                TEXT NOT NULL,       -- JSON tree, may be incomplete, always sanitized
  draft_hash           TEXT NOT NULL,       -- canonical body with section and block ids stripped
  revision             INTEGER NOT NULL DEFAULT 1,
  schema_version       INTEGER NOT NULL,
  published_version_id TEXT,                -- null if never published
  published_hash       TEXT,                -- same rule as draft_hash
  undone_version_id    TEXT,                -- set when Undo took a first publish offline
  archived_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT
);
-- One live draft per slug. An archived document gives its slug back.
CREATE UNIQUE INDEX IF NOT EXISTS documents_slug ON documents(slug) WHERE slug IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS documents_entity ON documents(type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_dirty ON documents(id)
  WHERE archived_at IS NULL AND type NOT IN ('blueprint') AND draft_hash IS NOT published_hash;

-- Frozen copies. Never updated. Only checkpoints may be deleted (retention).
CREATE TABLE IF NOT EXISTS document_versions (
  id             TEXT PRIMARY KEY,          -- ver_<16 hex>
  document_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,             -- published | checkpoint | migrated | undo_saved
  body           TEXT NOT NULL,             -- canonical JSON
  body_hash      TEXT NOT NULL,             -- with ids, for integrity
  schema_version INTEGER NOT NULL,
  note           TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_versions_doc ON document_versions(document_id, created_at);

CREATE TRIGGER IF NOT EXISTS document_versions_frozen
BEFORE UPDATE ON document_versions
BEGIN
  SELECT RAISE(ABORT, 'versions are frozen');
END;

CREATE TRIGGER IF NOT EXISTS document_versions_kept
BEFORE DELETE ON document_versions
WHEN OLD.kind <> 'checkpoint'
BEGIN
  SELECT RAISE(ABORT, 'only checkpoint versions can be deleted');
END;

-- Append only: Undo adds a row and never updates one.
CREATE TABLE IF NOT EXISTS publish_log (
  id               TEXT PRIMARY KEY,
  set_id           TEXT NOT NULL,           -- groups a multi-document publish
  document_id      TEXT NOT NULL,
  action           TEXT NOT NULL,           -- publish | unpublish | undo | scheduled | restore | migrated
  from_version_id  TEXT,
  to_version_id    TEXT,
  release_id       TEXT,                    -- null for product and collection content
  undoes_log_id    TEXT,
  saved_version_id TEXT,
  actor            TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS publish_log_doc ON publish_log(document_id, created_at);

-- The tenant's CMS mode. A missing table also means legacy.
CREATE TABLE IF NOT EXISTS cms_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  mode               TEXT NOT NULL,         -- legacy | migrating | documents
  cutover_release_id TEXT,
  updated_at         TEXT NOT NULL
);
INSERT OR IGNORE INTO cms_state (id, mode, cutover_release_id, updated_at)
VALUES (1, 'legacy', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
