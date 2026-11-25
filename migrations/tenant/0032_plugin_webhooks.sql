-- 0032_plugin_webhooks (Phase 4 line 3): store webhooks for plugins.
--   plugin_endpoints   one per custom app: its HTTPS address, the single host
--                      approved when it was saved (that app's egress allowlist),
--                      its topics and its signing secret (encrypted; the
--                      previous one keeps signing for 24 h after a rotation).
--                      Never sent to a browser: secret_enc stays server-side,
--                      and is cleared (NULL) when the app is uninstalled.
--   plugin_events      the outbox: one row per store event, deduplicated by
--                      idempotency_key. Payloads never carry customer names,
--                      emails, phones or addresses (owner decision, Phase 4).
--   plugin_deliveries  one row per event and subscriber, with its own attempt
--                      count and retry schedule; its id is the webhook-id header.
-- Additive and re-runnable: new tables and indexes only.
CREATE TABLE IF NOT EXISTS plugin_endpoints (
  id                TEXT PRIMARY KEY,
  install_id        TEXT NOT NULL UNIQUE,
  url               TEXT NOT NULL,
  host              TEXT NOT NULL,
  topics            TEXT NOT NULL DEFAULT '[]',
  secret_enc        TEXT,
  prev_secret_enc   TEXT,
  prev_secret_until TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  paused_reason     TEXT,
  paused_at         TEXT,
  failing_since     TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_by        TEXT,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_events (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  resource        TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  fanned_out_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_events_created ON plugin_events(created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_events_resource ON plugin_events(resource);
CREATE TABLE IF NOT EXISTS plugin_deliveries (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  install_id      TEXT NOT NULL,
  target          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  last_status     INTEGER,
  last_error      TEXT,
  last_ms         INTEGER,
  delivered_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(event_id, install_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_deliveries_install ON plugin_deliveries(install_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_deliveries_status ON plugin_deliveries(status, next_attempt_at);
