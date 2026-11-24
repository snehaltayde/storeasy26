-- Phase 1 line 2: signup creates the store's Turso database in a job
-- (docs/plans/phase-1.md). Nothing destructive: six added columns and an index.

-- The provision_store job for this signup (key provision_store:<signup id>).
ALTER TABLE signups ADD COLUMN job_id TEXT;
-- Retries spent on a slow or failing hosting provider (resets on Try again).
ALTER TABLE signups ADD COLUMN provision_attempts INTEGER NOT NULL DEFAULT 0;
-- When the next retry is due (the job's own delays, not the queue's backoff).
ALTER TABLE signups ADD COLUMN next_attempt_at TEXT;
-- Why a failed signup failed: retry_exhausted | needs_operator | lapsed.
ALTER TABLE signups ADD COLUMN failure_kind TEXT;
-- The one live handoff invite (an earlier unused one is deleted on each poll).
ALTER TABLE signups ADD COLUMN handoff_invite_id TEXT;
-- When the store, user and owner membership were all made.
ALTER TABLE signups ADD COLUMN done_at TEXT;
CREATE INDEX IF NOT EXISTS idx_signups_status ON signups(status, updated_at);
