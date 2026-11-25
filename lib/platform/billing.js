// Billing & entitlements core (S40 / BE11 + BE33). CONTROL-PLANE module
// (platformDb), plain-Node importable.
//
// Truths, in order:
//   1. The provider-event LEDGER (billing_events) is append-only and deduped
//      by provider event id — money numbers are sums over it, never derived
//      twice.
//   2. Subscription status comes ONLY from applied provider events (or a
//      local, price-zero plan). Out-of-order delivery can't regress state:
//      a watermark (last_event_at) guards status writes, and terminal states
//      (cancelled/completed/expired) only move between themselves.
//   3. Entitlements = pinned plan features ← operator override (per-field,
//      time-limited). No subscription at all = the free plan.
//   4. Every applied change pushes a SNAPSHOT into tenants.config.billing so
//      the edge storefront/console read service state with zero extra calls
//      (lib/billing-state.js derives grace/degraded from it).
// Edge-compatible: Web Crypto for ids and the provider client (node-only —
// Buffer + HMAC) loaded lazily inside the one function that needs it, so the
// edge-rendered billing page can import this module's READ paths.
import { platformDb, getTenant, patchTenant } from "./control.js";
import { GRACE_DAYS_DEFAULT } from "../billing-state.js";
import { audit, operatorActor } from "./audit.js";
import { slog } from "../log.js";

const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};
const graceDays = () => Number(process.env.PLATFORM_BILLING_GRACE_DAYS || GRACE_DAYS_DEFAULT);

// ---- plan catalog (versioned) ------------------------------------------------

export const DEFAULT_PLANS = [
  { id: "free", name: "Free", price: 0, features: { orders_per_month: 50, staff_seats: 2, campaigns: true } },
  { id: "starter", name: "Starter", price: 99900, features: { orders_per_month: 500, staff_seats: 5, campaigns: true } },
  { id: "growth", name: "Growth", price: 299900, features: { orders_per_month: 5000, staff_seats: 15, campaigns: true } },
];

const shapePlan = (r) => ({ ...r, price: Number(r.price), version: Number(r.version), features: parse(r.features, {}) });

export async function ensureDefaultPlans() {
  const db = platformDb();
  for (const p of DEFAULT_PLANS) {
    await db.execute({
      sql: `INSERT INTO plans (id, version, name, price, currency, interval, features, status, created_at)
            VALUES (?, 1, ?, ?, 'INR', 'month', ?, 'active', ?)
            ON CONFLICT(id, version) DO NOTHING`,
      args: [p.id, p.name, p.price, JSON.stringify(p.features), nowIso()],
    });
  }
}

export async function listPlans({ activeOnly = true } = {}) {
  const r = await platformDb().execute(
    `SELECT * FROM plans ${activeOnly ? "WHERE status = 'active'" : ""} ORDER BY price ASC, id, version DESC`,
  );
  return r.rows.map(shapePlan);
}

// Latest active version unless a version is pinned.
export async function getPlan(id, version = null) {
  const r = version
    ? await platformDb().execute({ sql: "SELECT * FROM plans WHERE id = ? AND version = ?", args: [id, version] })
    : await platformDb().execute({ sql: "SELECT * FROM plans WHERE id = ? AND status = 'active' ORDER BY version DESC LIMIT 1", args: [id] });
  return r.rows[0] ? shapePlan(r.rows[0]) : null;
}

// A change to a plan is a NEW version (old rows stay for pinned subscribers).
export const PLAN_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const FEATURE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Features are flat key → number | true/false | short text (Phase 3 line 3).
export function validPlanFeatures(features) {
  if (!features || typeof features !== "object" || Array.isArray(features)) throw new Error("features must be key/value rows");
  const out = {};
  for (const [k, v] of Object.entries(features)) {
    if (!FEATURE_KEY_RE.test(k)) throw new Error(`feature "${String(k).slice(0, 40)}": use lowercase letters, digits and _`);
    if (typeof v === "number" ? !Number.isFinite(v) : typeof v === "string" ? v.length > 80 : typeof v !== "boolean") throw new Error(`feature "${k}": a number, true/false, or text up to 80 characters`);
    out[k] = v;
  }
  if (Object.keys(out).length > 40) throw new Error("at most 40 features");
  return out;
}

export async function createPlanVersion(id, { name, price, currency = "INR", interval = "month", features = {} }) {
  if (!PLAN_ID_RE.test(String(id || ""))) throw new Error("plan id: 2–31 lowercase letters, digits or -, starting with a letter");
  if (!name || !String(name).trim() || !Number.isInteger(Number(price)) || Number(price) < 0) throw new Error("plan needs a name and a non-negative price (whole paise)");
  if (!["month", "year"].includes(interval)) throw new Error("interval must be month or year");
  if (currency !== "INR") throw new Error("plans are billed in INR");
  features = validPlanFeatures(features);
  name = String(name).trim().slice(0, 60);
  const db = platformDb();
  const cur = await db.execute({ sql: "SELECT MAX(version) v FROM plans WHERE id = ?", args: [id] });
  const version = Number(cur.rows[0]?.v || 0) + 1;
  await db.execute({
    sql: "INSERT INTO plans (id, version, name, price, currency, interval, features, status, created_at) VALUES (?,?,?,?,?,?,?, 'active', ?)",
    args: [id, version, name, Number(price), currency, interval, JSON.stringify(features), nowIso()],
  });
  if (version > 1) await db.execute({ sql: "UPDATE plans SET status = 'retired' WHERE id = ? AND version < ?", args: [id, version] });
  return getPlan(id, version);
}

// Retire one version: no new sales on it; subscribers pinned to it keep it
// (their rows name the version, entitlementsFor reads it pinned).
export async function retirePlanVersion(id, version) {
  const plan = await getPlan(String(id || ""), Number(version) || 0);
  if (!plan) throw new Error("unknown plan version");
  if (plan.status === "retired") throw new Error(`${plan.name} v${plan.version} is already retired`);
  await platformDb().execute({ sql: "UPDATE plans SET status = 'retired' WHERE id = ? AND version = ?", args: [plan.id, plan.version] });
  return { ...plan, status: "retired" };
}

// Every version with the number of live (not ended) subscriptions on it.
export async function listPlansWithSubscribers() {
  const plans = await listPlans({ activeOnly: false });
  const r = await platformDb().execute(
    "SELECT plan_id, plan_version, COUNT(*) n FROM subscriptions WHERE status NOT IN ('cancelled','completed','expired') GROUP BY plan_id, plan_version",
  );
  const n = new Map(r.rows.map((row) => [`${row.plan_id}@${Number(row.plan_version)}`, Number(row.n)]));
  return plans.map((p) => ({ ...p, subscribers: n.get(`${p.id}@${p.version}`) || 0 }));
}

// ---- subscriptions -----------------------------------------------------------

const shapeSub = (r) => (r ? { ...r, plan_version: Number(r.plan_version) } : null);

export async function subscriptionFor(tenantId) {
  const r = await platformDb().execute({
    sql: "SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    args: [tenantId],
  });
  return shapeSub(r.rows[0] || null);
}

// Start a subscription on the latest version of a plan. Price-zero plans
// activate LOCALLY (no provider); paid plans need the platform's Razorpay
// account and hand back the authorization short_url — status moves only via
// webhooks after that.
//
// Changing plan (Phase 3 line 3): the store's current live subscription is
// ended once the new one exists: a local one now, a provider one at Razorpay
// at the end of its cycle (so the founder keeps what they paid for). If the
// old one is the provider's and the provider is not configured, nothing
// starts. result.previous says what happened to the old one.
export async function startSubscription(tenantId, planId) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  const plan = await getPlan(planId);
  if (!plan) throw new Error(`unknown plan "${planId}"`);

  const db = platformDb();
  const id = newId("sub");
  const now = nowIso();
  const current = await subscriptionFor(tenantId);
  const previous = current && !TERMINAL.has(current.status) ? current : null;
  if (previous && previous.plan_id === plan.id && ["active", "authenticated"].includes(previous.status)) throw new Error(`the store is already on ${plan.name}`);
  if ((plan.price > 0 || previous?.razorpay_subscription_id) && !(await import("./razorpay-billing.js")).billingProviderConfigured()) {
    const err = new Error("Billing provider is not configured (PLATFORM_RAZORPAY_* env) — paid plans can't start or change yet");
    err.code = "BILLING_UNCONFIGURED";
    throw err;
  }
  const endPrevious = async () => (previous ? endForChange(previous) : null);

  if (plan.price === 0) {
    await db.execute({
      sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, current_start, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      args: [id, tenantId, plan.id, plan.version, now, now, now],
    });
    const prev = await endPrevious();
    await syncTenantBillingSnapshot(tenantId);
    slog("billing_subscribed", { tenant: tenantId, plan: plan.id, local: true });
    return { id, plan: plan.id, status: "active", local: true, previous: prev };
  }

  const { billingProviderConfigured, createProviderPlan, createProviderSubscription } = await import("./razorpay-billing.js");
  if (!billingProviderConfigured()) {
    const err = new Error("Billing provider is not configured (PLATFORM_RAZORPAY_* env) — paid plans can't start yet");
    err.code = "BILLING_UNCONFIGURED";
    throw err;
  }
  // mirror the plan into the provider once per version
  let rpPlanId = plan.razorpay_plan_id;
  if (!rpPlanId) {
    const created = await createProviderPlan(plan);
    rpPlanId = created.razorpayPlanId;
    await db.execute({ sql: "UPDATE plans SET razorpay_plan_id = ? WHERE id = ? AND version = ?", args: [rpPlanId, plan.id, plan.version] });
  }
  const sub = await createProviderSubscription({ ...plan, razorpay_plan_id: rpPlanId }, { tenantId });
  await db.execute({
    sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, razorpay_subscription_id, status, short_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, tenantId, plan.id, plan.version, sub.id, sub.status || "created", sub.shortUrl, now, now],
  });
  const prev = await endPrevious();
  await syncTenantBillingSnapshot(tenantId);
  slog("billing_subscribed", { tenant: tenantId, plan: plan.id, provider_sub: sub.id });
  return { id, plan: plan.id, status: sub.status || "created", shortUrl: sub.shortUrl, previous: prev };
}

// The old subscription on a plan change: a local one ends now (it is replaced,
// so no grace clock); a provider one is cancelled at its cycle end. A provider
// failure here does not undo the new subscription: it is reported back.
async function endForChange(sub) {
  if (!sub.razorpay_subscription_id) {
    const now = nowIso();
    await platformDb().execute({
      sql: "UPDATE subscriptions SET status = 'cancelled', current_end = ?, grace_until = NULL, updated_at = ? WHERE id = ?",
      args: [now, now, sub.id],
    });
    return { id: sub.id, ended: "now" };
  }
  try {
    const { cancelProviderSubscription } = await import("./razorpay-billing.js");
    await cancelProviderSubscription(sub.razorpay_subscription_id, { atCycleEnd: true });
    return { id: sub.id, ended: "cycle_end" };
  } catch (e) {
    slog("billing_change_cancel_failed", { subscription: sub.id, error: String(e?.message || e).slice(0, 200) });
    return { id: sub.id, ended: null, error: String(e?.message || e).slice(0, 200) };
  }
}

export const GRACE_EXTEND_MAX_DAYS = 30;
const subById = async (id) => shapeSub((await platformDb().execute({ sql: "SELECT * FROM subscriptions WHERE id = ?", args: [String(id || "")] })).rows[0] || null);

// Extend a subscription's grace (Phase 3 line 3): only while it has one to
// extend (payment trouble or ended), by 1–30 days from the later of now and
// the current grace end, with a reason (the caller audits it).
export async function extendGrace(subscriptionId, { days, reason }) {
  const sub = await subById(subscriptionId);
  if (!sub) throw new Error("unknown subscription");
  if (!["halted", "cancelled", "expired", "paused"].includes(sub.status)) throw new Error("only a subscription in payment trouble or ended has a grace period");
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > GRACE_EXTEND_MAX_DAYS) throw new Error(`grace: 1 to ${GRACE_EXTEND_MAX_DAYS} days`);
  if (!String(reason || "").trim()) throw new Error("extending grace needs a reason");
  const base = Math.max(Date.now(), sub.grace_until ? new Date(sub.grace_until).getTime() : 0);
  const graceUntil = new Date(base + d * 86400000).toISOString();
  await platformDb().execute({ sql: "UPDATE subscriptions SET grace_until = ?, updated_at = ? WHERE id = ?", args: [graceUntil, nowIso(), sub.id] });
  await syncTenantBillingSnapshot(sub.tenant_id);
  return { id: sub.id, tenant: sub.tenant_id, previous: sub.grace_until || null, grace_until: graceUntil };
}

// Cancel a subscription (Phase 3 line 3). A local one ends now and the
// platform's usual grace clock starts (as a provider cancellation does). A
// provider one is cancelled at Razorpay, at its cycle end unless atCycleEnd is
// false; its status then moves only through the provider's webhook. Neither can
// be undone.
export async function cancelSubscription(subscriptionId, { atCycleEnd = true } = {}) {
  const sub = await subById(subscriptionId);
  if (!sub) throw new Error("unknown subscription");
  if (TERMINAL.has(sub.status)) throw new Error("this subscription has already ended");
  if (!sub.razorpay_subscription_id) {
    const now = nowIso();
    const grace = new Date(Date.now() + graceDays() * 86400000).toISOString();
    await platformDb().execute({
      sql: "UPDATE subscriptions SET status = 'cancelled', current_end = ?, grace_until = ?, updated_at = ? WHERE id = ?",
      args: [now, grace, now, sub.id],
    });
    await syncTenantBillingSnapshot(sub.tenant_id);
    return { id: sub.id, tenant: sub.tenant_id, local: true, ended: "now", grace_until: grace };
  }
  const { billingProviderConfigured, cancelProviderSubscription } = await import("./razorpay-billing.js");
  if (!billingProviderConfigured()) {
    const err = new Error("Billing provider is not configured, so a Razorpay subscription can't be cancelled from here");
    err.code = "BILLING_UNCONFIGURED";
    throw err;
  }
  const r = await cancelProviderSubscription(sub.razorpay_subscription_id, { atCycleEnd: atCycleEnd !== false });
  return { id: sub.id, tenant: sub.tenant_id, local: false, ended: atCycleEnd !== false ? "cycle_end" : "now", provider_status: r.status };
}

const SUB_STATUSES = ["created", "authenticated", "active", "paused", "halted", "cancelled", "completed", "expired"];

// Every subscription row (newest first) with its store's name, the provider
// cancel scheduled on it (from the audit trail), and the stores to start a
// plan for. Filters: q (store id or name), status, plan, store (exact id).
// Offset pages of 50. Never returns a store's database URL.
export async function listSubscriptions({ q = "", status = "", plan = "", store = "", offset = 0, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (q) {
    where.push("(s.tenant_id LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')");
    const like = `%${String(q).slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like);
  }
  if (SUB_STATUSES.includes(status)) {
    where.push("s.status = ?");
    args.push(status);
  }
  if (plan) {
    where.push("s.plan_id = ?");
    args.push(String(plan));
  }
  if (store) {
    where.push("s.tenant_id = ?");
    args.push(String(store));
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const lim = Math.min(Math.max(1, Number(limit) || 50), 100);
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const db = platformDb();
  const total = Number((await db.execute({ sql: `SELECT COUNT(*) n FROM subscriptions s LEFT JOIN tenants t ON t.id = s.tenant_id ${w}`, args })).rows[0]?.n || 0);
  const rows = (
    await db.execute({
      sql: `SELECT s.id, s.tenant_id, t.name AS store_name, s.plan_id, s.plan_version, s.razorpay_subscription_id, s.status, s.current_start, s.current_end,
                   s.grace_until, s.created_at, s.updated_at
            FROM subscriptions s LEFT JOIN tenants t ON t.id = s.tenant_id ${w}
            ORDER BY s.created_at DESC, s.id DESC LIMIT ${lim} OFFSET ${off}`,
      args,
    })
  ).rows.map((r) => ({ ...shapeSub({ ...r }), provider: Boolean(r.razorpay_subscription_id) }));
  const ids = rows.filter((r) => r.provider).map((r) => `subscription:${r.id}`);
  if (ids.length) {
    const cancels = await db.execute({
      sql: `SELECT resource, at, diff FROM audit_log WHERE action = 'billing.cancel' AND resource IN (${ids.map(() => "?").join(",")}) ORDER BY at DESC`,
      args: ids,
    });
    for (const c of cancels.rows) {
      const row = rows.find((r) => `subscription:${r.id}` === c.resource);
      if (row && !row.cancel_requested) row.cancel_requested = { at: c.at, ended: parse(c.diff, {})?.ended || null };
    }
  }
  const stores = (await db.execute("SELECT id, name FROM tenants ORDER BY name COLLATE NOCASE")).rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
  return { rows, total, offset: off, limit: lim, stores, statuses: SUB_STATUSES };
}

// The billing ledger, newest first, 50 a page: filters store (an id, or
// "orphan" for events no store matched), type and month (YYYY-MM).
export async function listBillingEvents({ store = "", type = "", month = "", offset = 0, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (store === "orphan") where.push("e.tenant_id IS NULL");
  else if (store) {
    where.push("e.tenant_id = ?");
    args.push(String(store));
  }
  if (type) {
    where.push("e.type = ?");
    args.push(String(type));
  }
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month must be YYYY-MM");
    where.push("substr(e.occurred_at, 1, 7) = ?");
    args.push(month);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const lim = Math.min(Math.max(1, Number(limit) || 50), 100);
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const db = platformDb();
  const total = Number((await db.execute({ sql: `SELECT COUNT(*) n FROM billing_events e ${w}`, args })).rows[0]?.n || 0);
  const rows = (
    await db.execute({
      sql: `SELECT e.id, e.provider_event_id, e.subscription_id, e.tenant_id, t.name AS store_name, e.type, e.amount, e.payment_id, e.occurred_at, e.note
            FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id ${w}
            ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${lim} OFFSET ${off}`,
      args,
    })
  ).rows.map((r) => ({ ...r, amount: Number(r.amount), orphan: r.tenant_id == null }));
  const types = (await db.execute("SELECT DISTINCT type FROM billing_events ORDER BY type")).rows.map((r) => String(r.type));
  return { rows, total, offset: off, limit: lim, types };
}

// ---- provider events (webhook reconciliation) --------------------------------

// Razorpay subscription.* event → our status. charged implies active.
const EVENT_STATUS = {
  "subscription.authenticated": "authenticated",
  "subscription.activated": "active",
  "subscription.charged": "active",
  "subscription.paused": "paused",
  "subscription.resumed": "active",
  "subscription.pending": "halted", // charge retrying — payment trouble starts here
  "subscription.halted": "halted",
  "subscription.cancelled": "cancelled",
  "subscription.completed": "completed",
  "subscription.expired": "expired",
};
const TERMINAL = new Set(["cancelled", "completed", "expired"]);

// Apply one provider event. Idempotent (provider_event_id dedupe) and
// out-of-order safe: an event older than the subscription's watermark still
// LANDS IN THE LEDGER (money is append-only) but can't regress status; a
// terminal status is never overwritten by a non-terminal one.
export async function applyBillingEvent({ eventId = null, type, occurredAt, subscription = {}, payment = null }) {
  const db = platformDb();
  if (!EVENT_STATUS[type] && type !== "refund.processed") return { ignored: `unhandled type ${type}` };

  if (eventId) {
    const seen = await db.execute({ sql: "SELECT id FROM billing_events WHERE provider_event_id = ?", args: [eventId] });
    if (seen.rows.length) return { deduped: true };
  }
  const at = occurredAt || nowIso();

  // refunds match the original charge by payment id (ledger-only)
  if (type === "refund.processed") {
    const pid = payment?.id || null;
    const orig = pid
      ? await db.execute({ sql: "SELECT tenant_id, subscription_id FROM billing_events WHERE payment_id = ? AND amount > 0 LIMIT 1", args: [pid] })
      : { rows: [] };
    const row = orig.rows[0] || {};
    await db.execute({
      sql: "INSERT INTO billing_events (id, provider_event_id, subscription_id, tenant_id, type, amount, payment_id, occurred_at, applied_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [newId("bev"), eventId, row.subscription_id || null, row.tenant_id || null, type, -Math.abs(Number(payment?.amount || 0)), pid, at, nowIso(), row.tenant_id ? null : "unmatched refund"],
    });
    if (row.tenant_id) return { applied: type, tenant: row.tenant_id };
    return { applied: type, orphan: true };
  }

  const rpSubId = subscription?.id;
  const subRow = rpSubId
    ? shapeSub((await db.execute({ sql: "SELECT * FROM subscriptions WHERE razorpay_subscription_id = ?", args: [rpSubId] })).rows[0] || null)
    : null;

  // ledger first — even for orphan events (OP08's exception queue finds them)
  await db.execute({
    sql: "INSERT INTO billing_events (id, provider_event_id, subscription_id, tenant_id, type, amount, payment_id, occurred_at, applied_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [
      newId("bev"),
      eventId,
      subRow?.id || null,
      subRow?.tenant_id || null,
      type,
      type === "subscription.charged" ? Math.abs(Number(payment?.amount || 0)) : 0,
      payment?.id || null,
      at,
      nowIso(),
      subRow ? null : "no matching subscription",
    ],
  });
  if (!subRow) return { applied: type, orphan: true };

  const next = EVENT_STATUS[type];
  const stale = subRow.last_event_at && at < subRow.last_event_at;
  const regressesTerminal = TERMINAL.has(subRow.status) && !TERMINAL.has(next);
  if (!stale && !regressesTerminal) {
    const cs = subscription.current_start ? new Date(subscription.current_start * 1000 || subscription.current_start).toISOString() : subRow.current_start;
    const ce = subscription.current_end ? new Date(subscription.current_end * 1000 || subscription.current_end).toISOString() : subRow.current_end;
    // grace clock starts when payment trouble/termination does
    let grace = subRow.grace_until;
    if (["halted", "cancelled", "expired"].includes(next)) {
      const base = Math.max(new Date(at).getTime(), ce ? new Date(ce).getTime() : 0);
      grace = new Date(base + graceDays() * 86400000).toISOString();
    } else if (next === "active" || next === "authenticated") {
      grace = null; // recovered
    }
    await db.execute({
      sql: "UPDATE subscriptions SET status = ?, current_start = ?, current_end = ?, grace_until = ?, last_event_at = ?, updated_at = ? WHERE id = ?",
      args: [next, cs, ce, grace, at, nowIso(), subRow.id],
    });
  }
  await syncTenantBillingSnapshot(subRow.tenant_id);
  slog("billing_event_applied", { type, tenant: subRow.tenant_id, stale: !!stale });
  return { applied: type, tenant: subRow.tenant_id, stale: !!stale };
}

// Parse a raw Razorpay webhook body into applyBillingEvent's shape.
export function parseBillingWebhook(body) {
  return {
    eventId: body?.event_id || body?.id || null,
    type: body?.event,
    occurredAt: body?.created_at ? new Date(body.created_at * 1000).toISOString() : null,
    subscription: body?.payload?.subscription?.entity || {},
    payment: body?.payload?.payment?.entity || null,
  };
}

// ---- entitlements ------------------------------------------------------------

export async function getOverride(tenantId) {
  const r = await platformDb().execute({ sql: "SELECT * FROM entitlement_overrides WHERE tenant_id = ?", args: [tenantId] });
  const row = r.rows[0];
  if (!row) return null;
  if (row.expires_at && row.expires_at < nowIso()) return null; // expired = gone
  return { tenantId: row.tenant_id, features: parse(row.features, {}), reason: row.reason, setBy: row.set_by, expiresAt: row.expires_at };
}

export async function setOverride(tenantId, { features, reason, setBy = null, expiresAt = null }) {
  if (!String(reason || "").trim()) throw new Error("an override needs a reason");
  features = validPlanFeatures(features);
  if (!Object.keys(features).length) throw new Error("an override needs at least one feature");
  if (!(await getTenant(String(tenantId || "")))) throw new Error("unknown store");
  if (expiresAt != null) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) throw new Error("the expiry must be a date");
    expiresAt = t.toISOString();
  }
  await platformDb().execute({
    sql: `INSERT INTO entitlement_overrides (tenant_id, features, reason, set_by, expires_at, created_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(tenant_id) DO UPDATE SET features = excluded.features, reason = excluded.reason, set_by = excluded.set_by, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    args: [tenantId, JSON.stringify(features), String(reason).trim().slice(0, 300), setBy == null ? null : operatorActor(setBy).id, expiresAt, nowIso()],
  });
  await audit({ actor: operatorActor(setBy || "operator"), action: "billing.override", resource: `entitlement_override:${tenantId}`, tenantId, diff: { features, reason: String(reason).slice(0, 100), expiresAt } });
}

export async function clearOverride(tenantId, { setBy = null } = {}) {
  await platformDb().execute({ sql: "DELETE FROM entitlement_overrides WHERE tenant_id = ?", args: [tenantId] });
  await audit({ actor: operatorActor(setBy || "operator"), action: "billing.override_cleared", resource: `entitlement_override:${tenantId}`, tenantId, diff: { cleared: true } });
}

// Plan features (pinned version) ← operator override, per-field.
export async function entitlementsFor(tenantId) {
  const sub = await subscriptionFor(tenantId);
  const plan = sub ? await getPlan(sub.plan_id, sub.plan_version) : await getPlan("free");
  const override = await getOverride(tenantId);
  return {
    plan: plan?.id || "free",
    planVersion: plan?.version || 1,
    source: sub ? "subscription" : "default-free",
    features: { ...(plan?.features || {}), ...(override?.features || {}) },
    override: override ? { reason: override.reason, expiresAt: override.expiresAt, fields: Object.keys(override.features) } : null,
  };
}

// Push the derived snapshot into tenants.config.billing (edge hot path reads
// only this; lib/billing-state.js interprets it).
export async function syncTenantBillingSnapshot(tenantId) {
  const sub = await subscriptionFor(tenantId);
  const billing = sub
    ? {
        plan: sub.plan_id,
        plan_version: sub.plan_version,
        status: sub.status,
        grace_until: sub.grace_until,
        current_end: sub.current_end,
        updated_at: nowIso(),
      }
    : null;
  await patchTenant(tenantId, { config: { billing } });
  return billing;
}

// ---- usage (BE33) ------------------------------------------------------------

export const periodOf = (d = new Date()) => d.toISOString().slice(0, 7); // YYYY-MM UTC

export async function recordUsage(tenantId, metric, qty = 1, idempotencyKey = null) {
  const r = await platformDb().execute({
    sql: `INSERT INTO usage_events (id, tenant_id, metric, qty, period, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(idempotency_key) DO NOTHING`,
    args: [newId("use"), tenantId, metric, Math.max(1, Math.floor(qty)), periodOf(), idempotencyKey, nowIso()],
  });
  return { recorded: Number(r.rowsAffected) > 0 };
}

export async function usageTotals(tenantId, period = periodOf()) {
  const r = await platformDb().execute({
    sql: "SELECT metric, SUM(qty) total FROM usage_events WHERE tenant_id = ? AND period = ? GROUP BY metric",
    args: [tenantId, period],
  });
  return Object.fromEntries(r.rows.map((row) => [row.metric, Number(row.total)]));
}

// ---- operator reconciliation (OP08) ------------------------------------------

export async function revenueByMonth({ months = 6 } = {}) {
  const r = await platformDb().execute(
    `SELECT substr(occurred_at, 1, 7) month,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) gross,
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) refunds,
            SUM(amount) net
     FROM billing_events GROUP BY month ORDER BY month DESC LIMIT ${Math.min(months, 24)}`,
  );
  return r.rows.map((row) => ({ month: row.month, gross: Number(row.gross), refunds: Number(row.refunds), net: Number(row.net) }));
}

export async function billingOverview() {
  const db = platformDb();
  const subs = (await db.execute("SELECT * FROM subscriptions ORDER BY created_at DESC")).rows.map(shapeSub);
  const latestByTenant = new Map();
  for (const s of subs) if (!latestByTenant.has(s.tenant_id)) latestByTenant.set(s.tenant_id, s);
  const plans = await listPlans({ activeOnly: false });
  const planOf = (s) => plans.find((p) => p.id === s.plan_id && p.version === s.plan_version);

  let mrr = 0;
  const tenants = [];
  const now = Date.now();
  for (const s of latestByTenant.values()) {
    const plan = planOf(s);
    const monthly = plan ? (plan.interval === "year" ? Math.round(plan.price / 12) : plan.price) : 0;
    if (["active", "authenticated"].includes(s.status)) mrr += monthly;
    tenants.push({
      tenant: s.tenant_id,
      plan: s.plan_id,
      version: s.plan_version,
      status: s.status,
      grace_until: s.grace_until,
      current_end: s.current_end,
      monthly,
      pastGrace: ["halted", "cancelled", "expired"].includes(s.status) && s.grace_until && now > new Date(s.grace_until).getTime(),
    });
  }

  const orphans = (await db.execute("SELECT id, provider_event_id, type, amount, occurred_at, note FROM billing_events WHERE tenant_id IS NULL ORDER BY occurred_at DESC LIMIT 20")).rows.map((r) => ({ ...r }));
  const overrides = (await db.execute("SELECT * FROM entitlement_overrides")).rows.map((r) => ({ tenant: r.tenant_id, features: parse(r.features, {}), reason: r.reason, expires_at: r.expires_at, set_by: r.set_by }));
  // exceptions: payment trouble, past-grace, and events we couldn't attach
  const exceptions = [
    ...tenants.filter((t) => ["halted", "paused"].includes(t.status)).map((t) => ({ kind: "payment_trouble", tenant: t.tenant, detail: `status ${t.status}, grace until ${t.grace_until || "—"}` })),
    ...tenants.filter((t) => t.pastGrace).map((t) => ({ kind: "past_grace", tenant: t.tenant, detail: "degraded — checkout paused" })),
    ...orphans.map((o) => ({ kind: "orphan_event", tenant: null, detail: `${o.type} ${o.provider_event_id || o.id} (${o.note || "unmatched"})` })),
  ];
  return { tenants, mrr, revenue: await revenueByMonth(), exceptions, overrides };
}
