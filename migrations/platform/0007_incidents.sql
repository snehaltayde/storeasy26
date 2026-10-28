-- S43 (OP12): incidents — operator-declared, with INTERNAL notes separated
-- from the PUBLIC message (what merchants see in their console banner).
-- tenant_id NULL = platform-wide. Maintenance mode itself lives in each
-- tenant's config (config.maintenance — edge-fast, no extra lookup).
CREATE TABLE IF NOT EXISTS incidents (
  id             TEXT PRIMARY KEY,              -- inc_<hex>
  tenant_id      TEXT,                          -- NULL = platform-wide
  title          TEXT NOT NULL,
  internal_note  TEXT,                          -- operators only, never serialized to merchants
  public_message TEXT,                          -- shown in affected merchant consoles while open
  status         TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at);
