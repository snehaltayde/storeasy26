-- Phase 9 line 3: WhatsApp order updates and an abandoned-cart reminder,
-- consent-gated. Additive.
--   messaging_consents  one opt-in per row (purpose updates | marketing), the
--                       exact wording and its version, bound to the cart and/or
--                       the customer it was given from; revoked rows stay
--                       (revoked_at, revoked_via) until a privacy erase deletes them
--   whatsapp_templates  the four message kinds; only status 'approved' sends,
--                       and any edit returns a template to 'draft'
--   whatsapp_reminders  one abandoned-cart reminder per cart, ever (the PK)
CREATE TABLE IF NOT EXISTS messaging_consents (id TEXT PRIMARY KEY, channel TEXT NOT NULL, purpose TEXT NOT NULL,
  phone_e164 TEXT NOT NULL, phone_hash TEXT NOT NULL, customer_id TEXT, cart_id TEXT, source TEXT NOT NULL,
  wording TEXT NOT NULL, wording_version INTEGER NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT, revoked_via TEXT);
CREATE INDEX IF NOT EXISTS idx_mc_phone ON messaging_consents(phone_hash, purpose, revoked_at);
CREATE INDEX IF NOT EXISTS idx_mc_cart ON messaging_consents(cart_id);
CREATE INDEX IF NOT EXISTS idx_mc_customer ON messaging_consents(customer_id);
CREATE TABLE IF NOT EXISTS whatsapp_templates (kind TEXT PRIMARY KEY, provider_template TEXT, language TEXT NOT NULL DEFAULT 'en',
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', approved_by TEXT, approved_at TEXT, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS whatsapp_reminders (cart_id TEXT PRIMARY KEY, consent_id TEXT NOT NULL, sent_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient, consent_class, created_at);
