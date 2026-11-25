// Merchant automations (Session 49 / MC28). SERVER-ONLY, tenant-scoped.
//
// BOUNDED by construction: triggers and actions are enumerated here — there
// are no scripts, no outbound webhooks, no price/money paths. The guards the
// record demands are all in runOne(), in this order, each with a recorded
// reason: disable-all → per-rule pause → DEDUPE (unique event key: a
// replayed event can never act twice) → conditions → CONSENT (an email to a
// shopper requires the marketing consent captured on THAT order) → quiet
// hours (merchant-local) → frequency cap. Actions ride the BE23 notification
// queue (durable, idempotent, honest dev-mock labeling).
import { db } from "./db.js";
import { tenantCfg } from "./tenant-context.js";
import { consentAllows } from "./track/names.js";
import { slog } from "./log.js";

const rid = (p) => `${p}-` + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export const AUTOMATION_TRIGGERS = ["order_placed", "return_requested"];
export const AUTOMATION_ACTIONS = ["notify_merchant", "email_customer"];

// ---- flags (the disable-all switch) --------------------------------------------

export async function automationsDisabled() {
  try {
    const r = await db.selectFrom("automation_flags").select("value").where("key", "=", "disable_all").executeTakeFirst();
    return r?.value === "1";
  } catch {
    return true; // pre-migration tenant: nothing runs
  }
}

export async function setAutomationsDisabled(disabled) {
  await db
    .insertInto("automation_flags")
    .values({ key: "disable_all", value: disabled ? "1" : "0" })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: disabled ? "1" : "0" }))
    .execute();
  slog("automations_disable_all", { disabled: !!disabled });
  return { disabled: !!disabled };
}

// ---- validation + CRUD ---------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateAutomation({ name, trigger, conditions = {}, action, cap_per_day = 25, quiet_start = null, quiet_end = null }) {
  const errors = [];
  if (!name?.trim()) errors.push("name required");
  if (!AUTOMATION_TRIGGERS.includes(trigger)) errors.push(`trigger must be one of: ${AUTOMATION_TRIGGERS.join(", ")}`);
  const cond = {};
  if (conditions.min_total != null) {
    const v = Number(conditions.min_total);
    if (!Number.isFinite(v) || v < 0) errors.push("min_total: a non-negative number");
    else cond.min_total = v;
  }
  if (conditions.payment_method != null && String(conditions.payment_method).trim()) {
    const v = String(conditions.payment_method).trim();
    if (!["cod", "razorpay"].includes(v)) errors.push("payment_method: cod or razorpay");
    else cond.payment_method = v;
  }
  if (!AUTOMATION_ACTIONS.includes(action?.kind)) errors.push(`action must be one of: ${AUTOMATION_ACTIONS.join(", ")}`);
  const text = String(action?.text || "").trim().slice(0, 2000);
  if (!text) errors.push("action text required (what the message says)");
  if (action?.kind === "email_customer" && trigger !== "order_placed") errors.push("email_customer runs only on order_placed — the consent lives on the order");
  const cap = Number(cap_per_day);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) errors.push("cap per day: an integer 1–500");
  if ((quiet_start && !quiet_end) || (!quiet_start && quiet_end)) errors.push("quiet hours need both start and end");
  if (quiet_start && (!HHMM.test(quiet_start) || !HHMM.test(quiet_end))) errors.push("quiet hours: HH:MM, 24h, merchant-local");
  return {
    ok: !errors.length,
    errors,
    value: {
      name: name?.trim().slice(0, 120),
      trigger,
      conditions: cond,
      action: { kind: action?.kind, subject: String(action?.subject || "").trim().slice(0, 200), text },
      cap_per_day: cap,
      quiet_start: quiet_start || null,
      quiet_end: quiet_end || null,
    },
  };
}

export async function upsertAutomation(input, { id = null, enabled = false } = {}) {
  const v = validateAutomation(input);
  if (!v.ok) {
    const err = new Error(v.errors.join(" · "));
    err.errors = v.errors;
    throw err;
  }
  const existing = id ? await db.selectFrom("automations").selectAll().where("id", "=", id).executeTakeFirst() : null;
  const row = {
    id: existing?.id || rid("aut"),
    name: v.value.name,
    trigger: v.value.trigger,
    conditions: JSON.stringify(v.value.conditions),
    action: JSON.stringify(v.value.action),
    enabled: enabled ? 1 : 0,
    cap_per_day: v.value.cap_per_day,
    quiet_start: v.value.quiet_start,
    quiet_end: v.value.quiet_end,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };
  await db
    .insertInto("automations")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet(row))
    .execute();
  return { ...row, conditions: v.value.conditions, action: v.value.action, enabled: !!row.enabled };
}

export async function setAutomationEnabled(id, enabled) {
  await db.updateTable("automations").set({ enabled: enabled ? 1 : 0, updated_at: nowIso() }).where("id", "=", id).execute();
  return { id, enabled: !!enabled };
}

export async function deleteAutomation(id) {
  await db.deleteFrom("automations").where("id", "=", id).execute();
}

export async function listAutomations() {
  try {
    const rows = await db.selectFrom("automations").selectAll().orderBy("created_at", "asc").execute();
    return rows.map((r) => ({ ...r, enabled: !!r.enabled, conditions: parse(r.conditions, {}), action: parse(r.action, {}) }));
  } catch {
    return []; // pre-migration tenant
  }
}

export async function automationRuns({ automationId = null, limit = 30 } = {}) {
  try {
    let q = db.selectFrom("automation_runs").selectAll();
    if (automationId) q = q.where("automation_id", "=", automationId);
    const rows = await q.orderBy("created_at", "desc").limit(Math.min(limit, 200)).execute();
    return rows.map((r) => ({ ...r }));
  } catch {
    return [];
  }
}

// ---- the engine ----------------------------------------------------------------

// Merchant-local "HH:MM" now, for quiet-hour checks (injectable for tests).
export function localHHMM(now = Date.now(), tz = null) {
  const timeZone = tz || tenantCfg("merchant_timezone", null, "Asia/Kolkata");
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
}

export function inQuietHours(hhmm, start, end) {
  if (!start || !end) return false;
  // window may wrap midnight ("22:00" → "07:00")
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

async function record(automationId, eventKey, status, reason) {
  const row = { id: rid("run"), automation_id: automationId, event_key: eventKey, status, reason: String(reason || "").slice(0, 500), created_at: nowIso() };
  const res = await db
    .insertInto("automation_runs")
    .values(row)
    .onConflict((oc) => oc.columns(["automation_id", "event_key"]).doNothing())
    .execute();
  const inserted = Number(res[0]?.numInsertedOrUpdatedRows ?? res.numAffectedRows ?? 1);
  return { ...row, deduped: !inserted };
}

// Evaluate + (unless dryRun) act for ONE rule and ONE event. The event is
// {key, order?} — order rows come from the normal orders table.
export async function runOne(automation, event, { dryRun = false, now = Date.now() } = {}) {
  const a = automation;
  const eventKey = dryRun ? `dry:${rid("x")}` : event.key;
  const finish = async (status, reason) => {
    const r = await record(a.id, eventKey, status, reason);
    if (r.deduped) return { status: "skipped", reason: "duplicate event — this rule already handled it", deduped: true };
    return { status, reason };
  };

  // a dry run records nothing, the kill switch included
  if (await automationsDisabled()) return dryRun ? { status: "dry_run", reason: "disable-all is active — nothing runs", wouldBe: "skipped" } : finish("skipped", "disable-all is active — nothing runs");
  if (!a.enabled && !dryRun) return finish("skipped", "rule is paused");

  // DEDUPE comes before any action: claim the (rule, event) slot atomically.
  // A replayed event finds the row and stops right here.
  if (!dryRun) {
    const claimed = await record(a.id, eventKey, "pending", "claimed");
    if (claimed.deduped) return { status: "skipped", reason: "duplicate event — this rule already handled it", deduped: true };
  }
  const settle = async (status, reason) => {
    if (dryRun) return { status: "dry_run", reason, wouldBe: status };
    await db.updateTable("automation_runs").set({ status, reason: String(reason || "").slice(0, 500) }).where("automation_id", "=", a.id).where("event_key", "=", eventKey).execute();
    return { status, reason };
  };

  const order = event.order || null;
  const cond = typeof a.conditions === "string" ? parse(a.conditions, {}) : a.conditions || {};
  if (cond.min_total != null && Number(order?.total || 0) < cond.min_total) return settle("skipped", `condition: total ${order?.total} under min ${cond.min_total}`);
  if (cond.payment_method && order?.payment_method !== cond.payment_method) return settle("skipped", `condition: payment ${order?.payment_method} ≠ ${cond.payment_method}`);

  const action = typeof a.action === "string" ? parse(a.action, {}) : a.action;

  // CONSENT: a shopper email needs the marketing consent captured on the
  // triggering order itself — no consent, no send, recorded as such.
  let consentRef = null;
  if (action.kind === "email_customer") {
    const snap = parse(order?.snapshot, {});
    if (!consentAllows(snap?.consent, "marketing")) return settle("skipped", "no marketing consent on this order — not sent");
    consentRef = `order:${order.id}:consent@checkout`;
    if (!order?.email) return settle("skipped", "order has no email");
  }

  // QUIET HOURS (merchant-local) — skipped, honestly, not silently deferred.
  const hhmm = localHHMM(now);
  if (inQuietHours(hhmm, a.quiet_start, a.quiet_end)) return settle("skipped", `quiet hours (${a.quiet_start}–${a.quiet_end}, now ${hhmm} local)`);

  // FREQUENCY CAP: completed sends in the last 24h.
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  const done = await db
    .selectFrom("automation_runs")
    .select(({ fn }) => fn.countAll().as("n"))
    .where("automation_id", "=", a.id)
    .where("status", "=", "done")
    .where("created_at", ">=", since)
    .executeTakeFirst();
  if (Number(done?.n || 0) >= Number(a.cap_per_day)) return settle("skipped", `frequency cap reached (${a.cap_per_day}/day)`);

  const to = action.kind === "email_customer" ? order.email : tenantCfg("site", null, null)?.support_email || "";
  const subject = action.subject || (action.kind === "email_customer" ? "A note from the store" : `Automation: ${a.name}`);
  // GEN-03: the rule name is a note for the store, never for its shoppers.
  const text =
    action.kind === "email_customer"
      ? `${action.text}${order ? `\n\nOrder ${order.id}` : ""}`
      : `${action.text}\n\n— automated rule "${a.name}"${order ? ` · ${order.id}` : ""}`;
  if (dryRun) {
    return { status: "dry_run", reason: `WOULD send ${action.kind} to ${to || "(no recipient configured)"}: "${subject}"`, wouldBe: "done" };
  }
  try {
    const { notify } = await import("./notifications.js");
    const r = await notify({
      type: `automation_${action.kind}`,
      to,
      subject,
      text,
      idempotencyKey: `aut_${a.id}_${event.key}`,
      ...(consentRef ? { consentClass: "marketing", consentRef } : {}),
    });
    return settle("done", `${action.kind} → ${to} (${r.status || "queued"})`);
  } catch (e) {
    return settle("failed", `action error: ${String(e?.message || e).slice(0, 200)}`);
  }
}

// Fire every enabled rule for a trigger — called BEST-EFFORT after the real
// work committed (post-money; a broken rule can never break an order).
export async function runAutomationsFor(trigger, event, { now = Date.now() } = {}) {
  try {
    const rules = (await listAutomations()).filter((r) => r.trigger === trigger && r.enabled);
    const out = [];
    for (const rule of rules) out.push({ rule: rule.id, ...(await runOne(rule, event, { now })) });
    if (out.length) slog("automations_ran", { trigger, rules: out.length });
    return out;
  } catch {
    return []; // pre-migration tenant / never block the caller
  }
}

// Retry ONE failed run (diagnostics path): re-executes the action against
// the same event key — the run row flips failed → done on success.
export async function retryRun(runId) {
  const run = await db.selectFrom("automation_runs").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!run) throw new Error("run not found");
  if (run.status !== "failed") throw new Error(`only failed runs retry (this one is ${run.status})`);
  const rule = (await listAutomations()).find((r) => r.id === run.automation_id);
  if (!rule) throw new Error("its rule no longer exists");
  const orderId = run.event_key.split(":")[1];
  const order = orderId ? await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst() : null;
  // delete the failed claim so runOne can re-claim the same key atomically
  await db.deleteFrom("automation_runs").where("id", "=", runId).execute();
  return runOne(rule, { key: run.event_key, order }, {});
}
