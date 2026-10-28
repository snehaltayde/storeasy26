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
import { platformDb, getTenant, patchTenant } from "./control.js";
import { createProviderPlan, createProviderSubscription, billingProviderConfigured } from "./razorpay-billing.js";
import { GRACE_DAYS_DEFAULT } from "../billing-state.js";
import { audit } from "./audit.js";
import { slog } from "../log.js";
import crypto from "node:crypto";

const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomBytes(9).toString("hex")}`;
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
export async function createPlanVersion(id, { name, price, currency = "INR", interval = "month", features = {} }) {
  const db = platformDb();
  const cur = await db.execute({ sql: "SELECT MAX(version) v FROM plans WHERE id = ?", args: [id] });
  const version = Number(cur.rows[0]?.v || 0) + 1;
  if (!name || !Number.isFinite(Number(price)) || Number(price) < 0) throw new Error("plan needs a name and a non-negative price (minor units)");
  if (!["month", "year"].includes(interval)) throw new Error("interval must be month or year");
  await db.execute({
    sql: "INSERT INTO plans (id, version, name, price, currency, interval, features, status, created_at) VALUES (?,?,?,?,?,?,?, 'active', ?)",
    args: [id, version, name, Number(price), currency, interval, JSON.stringify(features), nowIso()],
  });
  if (version > 1) await db.execute({ sql: "UPDATE plans SET status = 'retired' WHERE id = ? AND version < ?", args: [id, version] });
  return getPlan(id, version);
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
export async function startSubscription(tenantId, planId) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  const plan = await getPlan(planId);
  if (!plan) throw new Error(`unknown plan "${planId}"`);

  const db = platformDb();
  const id = newId("sub");
  const now = nowIso();

  if (plan.price === 0) {
    await db.execute({
      sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, current_start, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      args: [id, tenantId, plan.id, plan.version, now, now, now],
    });
    await syncTenantBillingSnapshot(tenantId);
    slog("billing_subscribed", { tenant: tenantId, plan: plan.id, local: true });
    return { id, plan: plan.id, status: "active", local: true };
  }

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
  await syncTenantBillingSnapshot(tenantId);
  slog("billing_subscribed", { tenant: tenantId, plan: plan.id, provider_sub: sub.id });
  return { id, plan: plan.id, status: sub.status || "created", shortUrl: sub.shortUrl };
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
  if (!reason?.trim()) throw new Error("an override needs a reason");
  if (!features || typeof features !== "object") throw new Error("features must be an object");
  await platformDb().execute({
    sql: `INSERT INTO entitlement_overrides (tenant_id, features, reason, set_by, expires_at, created_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(tenant_id) DO UPDATE SET features = excluded.features, reason = excluded.reason, set_by = excluded.set_by, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    args: [tenantId, JSON.stringify(features), reason.trim().slice(0, 300), setBy, expiresAt, nowIso()],
  });
  await audit({ actor: { kind: "operator", id: setBy || "operator" }, action: "settings.write", resource: `entitlement_override:${tenantId}`, diff: { reason: reason.slice(0, 100), expiresAt } });
}

export async function clearOverride(tenantId, { setBy = null } = {}) {
  await platformDb().execute({ sql: "DELETE FROM entitlement_overrides WHERE tenant_id = ?", args: [tenantId] });
  await audit({ actor: { kind: "operator", id: setBy || "operator" }, action: "settings.write", resource: `entitlement_override:${tenantId}`, diff: { cleared: true } });
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
