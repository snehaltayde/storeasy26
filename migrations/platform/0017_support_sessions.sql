-- Phase 3 line 5: support access across hosts (docs/plans/phase-3.md, Line 5).
-- An operator enters a store's console through a single-use, 60-second
-- `support_entry` session and then holds a host-only `support` session; both
-- name the support grant they belong to, so closing or expiring the grant
-- ends them. The new kinds live in sessions.kind (TEXT): no schema change.
-- Nothing destructive: two added columns and an index.

ALTER TABLE sessions ADD COLUMN grant_id TEXT;
-- the operator console's origin a support_entry token was minted on: the
-- store's entry route takes the token only from a form posted by that origin
ALTER TABLE sessions ADD COLUMN entry_origin TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_grant ON sessions(grant_id);
