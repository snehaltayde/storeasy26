-- S44 (MK08): marketing-site lead capture — durable, consent-aware.
-- contact consent is implicit in submitting the form (that's its purpose);
-- marketing_consent is a SEPARATE explicit opt-in and defaults to 0.
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,          -- ld_<hex>
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  store_url         TEXT,
  message           TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  source            TEXT,                      -- page the form was on
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
