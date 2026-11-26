// Phase 9 line 5: the copilot's daily token budget per store (ai_usage_ledger,
// migration 0043). SERVER-ONLY, inside withTenant.
//
//   dailyBudget()                       tenantCfg("ai_daily_tokens"), operator-set; 100,000
//   storeDay(now)                       "YYYY-MM-DD" in the store's timezone
//   reserve({ task, provider, model, tokens, actor, now }) -> { id, day }
//                                       ONE conditional INSERT … SELECT: the row
//                                       is written only when what the day has
//                                       spent and holds, plus `tokens`, fits the
//                                       budget. Runs at once can never pass it
//                                       (SQLite runs one write at a time and the
//                                       check is inside the write). Refused ->
//                                       BudgetError (AI_BUDGET), nothing stored.
//   settle(id, { tokensIn, tokensOut, refs, now })
//                                       the real tokens; also platform
//                                       recordUsage(ai_tokens), best effort
//   release(id, { now })                a run that failed before any token was
//                                       spent frees its reservation
//   usageToday(now) -> { day, budget, spent, held, remaining, resetsAt }
//   listRuns({ limit }) -> the last runs, newest first
//
// A day's spend counts a reserved row at its reservation and a settled row at
// its real tokens; a failed row counts 0.
import { libsql } from "../db.js";
import { tenantCfg, tenantId } from "../tenant-context.js";
import { dayInTz, merchantTz } from "../reporting.js";
import { recordUsage } from "../platform/billing.js";
import { newId } from "../platform/sessions.js";
import { slog } from "../log.js";

export const DEFAULT_DAILY_TOKENS = 100000;

export function dailyBudget() {
  const n = Number(tenantCfg("ai_daily_tokens", null, DEFAULT_DAILY_TOKENS));
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_TOKENS;
}

export const storeDay = (now = new Date()) => dayInTz(now.toISOString(), merchantTz());

const SPENT_SQL =
  "SELECT COALESCE(SUM(CASE status WHEN 'reserved' THEN tokens_reserved WHEN 'settled' THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) ELSE 0 END), 0) FROM ai_usage_ledger WHERE day = ?";

export class BudgetError extends Error {
  constructor(usage, asked) {
    super(
      `This would go over today's AI budget (${usage.spent.toLocaleString("en-IN")} of ${usage.budget.toLocaleString("en-IN")} tokens used, and this task can use up to ${asked.toLocaleString("en-IN")}). Nothing was sent. It resets at midnight, or ask Storeasy to raise it.`,
    );
    this.code = "AI_BUDGET";
    this.usage = usage;
  }
}

export async function usageToday(now = new Date()) {
  const day = storeDay(now);
  const r = await libsql.execute({
    sql: "SELECT COALESCE(SUM(CASE status WHEN 'reserved' THEN tokens_reserved ELSE 0 END), 0) AS held, COALESCE(SUM(CASE status WHEN 'settled' THEN COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) ELSE 0 END), 0) AS used FROM ai_usage_ledger WHERE day = ?",
    args: [day],
  });
  const held = Number(r.rows[0]?.held) || 0;
  const used = Number(r.rows[0]?.used) || 0;
  const budget = dailyBudget();
  return { day, budget, spent: used + held, held, remaining: Math.max(0, budget - used - held), resetsAt: "midnight" };
}

export async function reserve({ task, provider, model, tokens, actor = null, now = new Date() }) {
  if (!(Number.isInteger(tokens) && tokens > 0)) throw new Error("reserve: tokens must be a positive integer");
  const id = newId("aiu");
  const day = storeDay(now);
  const budget = dailyBudget();
  const r = await libsql.execute({
    sql: `INSERT INTO ai_usage_ledger (id, day, task, provider, model, status, tokens_reserved, result_refs, actor, created_at)
          SELECT ?, ?, ?, ?, ?, 'reserved', ?, '[]', ?, ? WHERE (${SPENT_SQL}) + ? <= ?`,
    args: [id, day, task, provider, model, tokens, actor, now.toISOString(), day, tokens, budget],
  });
  if (r.rowsAffected !== 1) {
    const usage = await usageToday(now);
    slog("ai_budget_refused", { task, asked: tokens, spent: usage.spent, budget });
    throw new BudgetError(usage, tokens);
  }
  return { id, day };
}

export async function settle(id, { tokensIn = 0, tokensOut = 0, refs = [], now = new Date() } = {}) {
  await libsql.execute({
    sql: "UPDATE ai_usage_ledger SET status = 'settled', tokens_in = ?, tokens_out = ?, result_refs = ?, settled_at = ? WHERE id = ? AND status = 'reserved'",
    args: [tokensIn, tokensOut, JSON.stringify(refs), now.toISOString(), id],
  });
  await recordUsage(tenantId(), "ai_tokens", tokensIn + tokensOut, `ai_${id}`).catch(() => {});
}

export async function release(id, { now = new Date() } = {}) {
  await libsql.execute({ sql: "UPDATE ai_usage_ledger SET status = 'failed', settled_at = ? WHERE id = ? AND status = 'reserved'", args: [now.toISOString(), id] });
}

const parse = (s) => {
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export async function listRuns({ limit = 30 } = {}) {
  const r = await libsql.execute({
    sql: "SELECT id, day, task, provider, model, status, tokens_reserved, tokens_in, tokens_out, result_refs, actor, created_at FROM ai_usage_ledger ORDER BY created_at DESC, rowid DESC LIMIT ?",
    args: [limit],
  });
  return r.rows.map((x) => ({
    id: String(x.id),
    day: String(x.day),
    task: String(x.task),
    status: String(x.status),
    tokens: x.status === "settled" ? (Number(x.tokens_in) || 0) + (Number(x.tokens_out) || 0) : x.status === "reserved" ? Number(x.tokens_reserved) || 0 : 0,
    refs: parse(x.result_refs),
    actor: x.actor == null ? null : String(x.actor),
    createdAt: String(x.created_at),
  }));
}
