-- Phase 9 line 5: the AI copilot's daily token ledger, one row per run. A run
-- reserves its worst case (the prompt estimate plus max_tokens, thinking
-- included) as status 'reserved' in ONE conditional INSERT … SELECT, so runs at
-- once can never pass the store's daily budget; it is settled with the real
-- tokens ('settled') or freed ('failed', counted as 0). `day` is the store's own
-- day (its timezone), so the budget resets at the store's midnight.
-- result_refs: JSON [{ kind, id, label }] of the drafts the run made. Additive.
CREATE TABLE IF NOT EXISTS ai_usage_ledger (id TEXT PRIMARY KEY, day TEXT NOT NULL, task TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT NOT NULL, status TEXT NOT NULL, tokens_reserved INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER,
  result_refs TEXT NOT NULL DEFAULT '[]', actor TEXT, created_at TEXT NOT NULL, settled_at TEXT);
CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage_ledger(day, status);
