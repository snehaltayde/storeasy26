-- P3-COMMIT (PUB-04, PUB-03; spec 8.2, phase 3 plan decision 2): what each
-- published document version links to, plus indexes for Undo and
-- "Recently published". The only phase 3 migration.
-- Additive only, and safe to re-run: CREATE … IF NOT EXISTS.
--
-- document_refs: one row per (published version, thing it refers to), written
-- in the publish batch for every fresh published version (lib/documents/
-- refs.js refRows). ref_type is one of document | collection | product |
-- media | bundle | offer | quiz. A page link names its document id when the
-- link carries one, else "slug:<family>:<slug>". The spec's 'page' is
-- 'document' here. Drafts and the legacy backfill are not written here
-- (MED-03, MIG-01).
--
-- Publishing works without this table: the build probes for it and leaves
-- the refs out (logged 'document_refs_missing') until this has run.
CREATE TABLE IF NOT EXISTS document_refs (
  version_id TEXT NOT NULL,
  ref_type   TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  PRIMARY KEY (version_id, ref_type, ref_id)
);
-- "which live documents link to this one" (the take-offline confirm)
CREATE INDEX IF NOT EXISTS document_refs_target ON document_refs(ref_type, ref_id);

-- Whole-set Undo reads a set's rows; Undo finds the row that undid another.
CREATE INDEX IF NOT EXISTS publish_log_set ON publish_log(set_id) WHERE set_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS publish_log_undoes ON publish_log(undoes_log_id) WHERE undoes_log_id IS NOT NULL;
-- "Recently published", newest first, across documents
CREATE INDEX IF NOT EXISTS publish_log_recent ON publish_log(created_at);
