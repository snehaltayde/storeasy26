-- Phase 1 line 1: a founder signs up on their own (docs/plans/phase-1.md).
-- Nothing destructive: one added column, two new tables.

-- When a signup proved the address (null for every account made before).
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- A self-serve signup before and while its store is created. Nothing here is
-- a user or a store until the email code is verified.
CREATE TABLE IF NOT EXISTS signups (
  id TEXT PRIMARY KEY,               -- sgn_<16hex>
  email TEXT NOT NULL, name TEXT NOT NULL, store_name TEXT NOT NULL, slug TEXT NOT NULL,
  password_hash TEXT,                -- null for 'existing'; cleared once done
  browser_hash TEXT NOT NULL,        -- sha256 of se_signup cookie
  code_hash TEXT, code_expires_at TEXT, code_attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 0, last_sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|existing|verified|provisioning|failed|done|expired|superseded
  user_id TEXT, tenant_id TEXT, provision_run_id TEXT, error TEXT, ip TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_slug_live ON signups(slug)
  WHERE status IN ('pending','verified','provisioning','failed');
CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_browser ON signups(browser_hash);

-- Mail the platform itself sends (signup codes). The body is kept only when
-- mail is mocked (local and tests read the code from it); a real send nulls it.
CREATE TABLE IF NOT EXISTS platform_mail (
  id TEXT PRIMARY KEY,               -- pml_<16hex>
  kind TEXT NOT NULL,                -- signup_code | signup_existing
  recipient TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT,                         -- kept only when mail is mocked; null after a real send
  status TEXT NOT NULL,              -- sent | mock | failed
  provider_id TEXT, error TEXT, ref TEXT,  -- ref = signup id
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_mail_recipient ON platform_mail(recipient, created_at);
