-- Phase 4 line 4: an app's API call list reads its own audit rows
-- (tenant_id, actor = the install id, newest first). Additive: one index.
CREATE INDEX IF NOT EXISTS idx_audit_tenant_actor_at ON audit_log(tenant_id, actor, at);
