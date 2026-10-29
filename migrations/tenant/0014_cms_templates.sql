-- S54 (audit slice 2): tenant-saved page templates. A template is a NAMED,
-- reusable section composition for one page family — a starting point the
-- editor instantiates as an independent COPY (instance ids re-minted), never
-- a live-linked layout. Templates are authoring assets: they are not
-- rendered and not part of release snapshots.
CREATE TABLE IF NOT EXISTS cms_templates (
  id          TEXT PRIMARY KEY,               -- tpl_<hex>
  name        TEXT NOT NULL,
  family      TEXT NOT NULL DEFAULT 'page',   -- page | campaign | journal
  sections    TEXT NOT NULL,                  -- JSON section list (validated, ids stripped)
  version     INTEGER NOT NULL DEFAULT 1,     -- schema version of the stored sections
  revision    INTEGER NOT NULL DEFAULT 1,     -- CAS counter (same discipline as cms_pages)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
