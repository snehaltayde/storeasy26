-- S35 (BE08): draft-revision safety for CMS content. Every block/page row
-- carries a monotonically increasing revision; console writes are
-- compare-and-swap on the revision the editor loaded, so two people editing
-- the same block get an explicit 409 (both versions preserved — the server
-- keeps its row, the editor keeps their unsaved value) instead of a silent
-- lost update. schema_version records which component schema wrote the value.
ALTER TABLE cms_blocks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cms_blocks ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cms_pages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cms_pages ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
