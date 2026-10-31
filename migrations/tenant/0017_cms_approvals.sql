-- S60: candidate approvals. A reviewer approves EXACTLY ONE draft candidate
-- (its content hash) — any later draft edit changes the hash, so the
-- approval silently stops applying instead of blessing content nobody read.
-- Informational in v1: publishing records but does not require it.
CREATE TABLE IF NOT EXISTS cms_approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_hash TEXT NOT NULL,
  actor      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cms_approvals_hash ON cms_approvals (draft_hash, created_at DESC);
