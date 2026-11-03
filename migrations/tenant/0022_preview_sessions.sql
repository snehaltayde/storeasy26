-- P2-PREVIEW (PV-03): preview sessions for stores in documents mode (spec 8.8).
-- Additive only, and safe to re-run: CREATE … IF NOT EXISTS.
-- A store without this table simply gets no draft overlay in its preview
-- (live content only). Legacy stores never read it: they keep the releases
-- preview and its old-format token.
--
-- The preview cookie holds p.<exp>.<sid>.<hmac>, signed over tenant|exp|sid.
-- The row says whether that session is still good (not expired, not revoked)
-- and whether it also shows the unpublished design (show_design).
CREATE TABLE IF NOT EXISTS preview_sessions (
  id          TEXT PRIMARY KEY,           -- the sid in the token: ps_<16 hex>
  tenant_id   TEXT NOT NULL,              -- the store the session was made for
  created_by  TEXT NOT NULL,              -- <actor kind>:<actor id>
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  show_design INTEGER NOT NULL DEFAULT 0  -- 1: the design document's draft is shown too
);
-- "a newer session exists for the same user" (the other-tab note)
CREATE INDEX IF NOT EXISTS preview_sessions_user ON preview_sessions(created_by, created_at);
