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
import { audit, operatorActor, OPERATOR_ONLY } from "./audit.js";
import { clampOffset } from "./paging.js";
import { slog } from "../log.js";
import { refuse } from "./refuse.js";

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

// Public tiers (owner, 2026-11-26; docs/DECISIONS.md): Launch ₹9,999, Growth
// ₹24,999, Scale ₹60,000 a month, then Enterprise by conversation. The ids
// `starter` and `growth` are kept from the first catalog: subscriptions pin a
// plan by id and version, so a new public name is a new row, not a new id
// (migrations/platform/0020_plan_tiers.sql adds the new version to a database
// that still sells the first prices). `free` is internal: what a store with
// no subscription is entitled to, and what signup and provisioning start a
// store on. It is never shown on the public pricing (listPublicPlans).
export const DEFAULT_PLANS = [
  { id: "free", name: "Free", price: 0, features: { orders_per_month: 50, staff_seats: 2, campaigns: true } },
  { id: "starter", name: "Launch", price: 999900, features: { orders_per_month: 1000, staff_seats: 5, campaigns: true } },
  { id: "growth", name: "Growth", price: 2499900, features: { orders_per_month: 5000, staff_seats: 15, campaigns: true } },
  { id: "scale", name: "Scale", price: 6000000, features: { orders_per_month: 25000, staff_seats: 40, campaigns: true } },
];

// The tier above Scale has no catalog row and no listed price: it is agreed
// in a conversation (the lead form at `contact`), and an operator then gives
// that store its own plan id with createPlanVersion.
export const ENTERPRISE_PLAN = Object.freeze({ id: "enterprise", name: "Enterprise", price: null, contact: "/contact" });

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

// What the public pricing shows (the landing page and /pricing): every plan
// on sale that costs something, cheapest first. The price-zero plan is
// internal (see DEFAULT_PLANS). Enterprise is added by the page, from
// ENTERPRISE_PLAN, because it has no row.
export async function listPublicPlans() {
  return (await listPlans()).filter((p) => p.price > 0);
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
  if (!features || typeof features !== "object" || Array.isArray(features)) throw refuse(422, "features must be key/value rows");
  const out = {};
  for (const [k, v] of Object.entries(features)) {
    if (!FEATURE_KEY_RE.test(k)) throw refuse(422, `feature "${String(k).slice(0, 40)}": use lowercase letters, digits and _`);
    if (typeof v === "number" ? !Number.isFinite(v) : typeof v === "string" ? v.length > 80 : typeof v !== "boolean") throw refuse(422, `feature "${k}": a number, true/false, or text up to 80 characters`);
    out[k] = v;
  }
  if (Object.keys(out).length > 40) throw refuse(422, "at most 40 features");
  return out;
}

export async function createPlanVersion(id, { name, price, currency = "INR", interval = "month", features = {} }) {
  if (!PLAN_ID_RE.test(String(id || ""))) throw refuse(422, "plan id: 2–31 lowercase letters, digits or -, starting with a letter");
  if (!name || !String(name).trim() || !Number.isInteger(Number(price)) || Number(price) < 0) throw refuse(422, "plan needs a name and a non-negative price (whole paise)");
  if (!["month", "year"].includes(interval)) throw refuse(422, "interval must be month or year");
  if (currency !== "INR") throw refuse(422, "plans are billed in INR");
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
  if (!plan) throw refuse(422, "unknown plan version");
  if (plan.status === "retired") throw refuse(422, `${plan.name} v${plan.version} is already retired`);
  await platformDb().execute({ sql: "UPDATE plans SET status = 'retired' WHERE id = ? AND version = ?", args: [plan.id, plan.version] });
  return { ...plan, status: "retired" };
}

// Every version with the number of live (not ended) subscriptions on it.
export async function listPlansWithSubscribers() {
  const plans = await listPlans({ activeOnly: false });
  const r = await platformDb().execute(
    "SELECT plan_id, plan_version, COUNT(*) n FROM subscriptions WHERE replaced_by IS NULL AND status NOT IN ('cancelled','completed','expired') GROUP BY plan_id, plan_version",
  );
  const n = new Map(r.rows.map((row) => [`${row.plan_id}@${Number(row.plan_version)}`, Number(row.n)]));
  return plans.map((p) => ({ ...p, subscribers: n.get(`${p.id}@${p.version}`) || 0 }));
}

// ---- subscriptions -----------------------------------------------------------
//
// One CURRENT subscription per store: the newest live row no plan change has
// replaced (replaced_by IS NULL). migrations/platform/0016 enforces it with a
// unique partial index, so two plan changes at once cannot both win. A
// replaced Razorpay row keeps its provider status until its cycle-end webhook
// (the founder keeps what they paid for); cancel_state tracks its cancel at
// Razorpay, and a failed one is retried by the next change.

const shapeSub = (r) => (r ? { ...r, plan_version: Number(r.plan_version) } : null);
const LIVE = "status NOT IN ('cancelled','completed','expired')";

// The store's subscription for display and grace: its current row (no plan
// change replaced it), newest first; with none, the newest row of any kind. A
// kept race loser or a replaced row is never preferred over the current one.
export async function subscriptionFor(tenantId) {
  const r = await platformDb().execute({
    sql: "SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY (replaced_by IS NOT NULL), created_at DESC, id DESC LIMIT 1",
    args: [tenantId],
  });
  return shapeSub(r.rows[0] || null);
}

const rowsFor = async (tenantId, where = "1 = 1") =>
  (await platformDb().execute({ sql: `SELECT * FROM subscriptions WHERE tenant_id = ? AND ${where} ORDER BY created_at DESC, id DESC LIMIT 50`, args: [tenantId] })).rows.map(shapeSub);

// The row the store's features and service state come from: among the rows
// that are paid up (active) or still in a paid period (current_end ahead),
// the highest-priced, newest first on a tie. So an unpaid upgrade unlocks
// nothing, and a downgrade from paid to free keeps the paid plan until its
// cycle ends. With none in force, the current row while it is in grace (the
// store keeps full service in grace, lib/billing-state.js). null = free plan.
const monthlyOf = (p) => (p ? (p.interval === "year" ? Math.round(p.price / 12) : p.price) : 0);
// rows newest first; planOf(row) -> its plan version; charged: the ids of rows
// the ledger holds a charge for. In force: active (Razorpay's charged event
// sets it), or ended / failing but still inside a period it was charged for.
// An authenticated row is never in force on its own: authorised is not paid.
// -> the row in force, or null
export function pickInForce(rows, planOf, nowMs = Date.now(), charged = new Set()) {
  let best = null;
  for (const r of rows) {
    if (!(r.status === "active" || (charged.has(r.id) && r.status !== "authenticated" && r.status !== "created" && r.current_end && Date.parse(r.current_end) > nowMs))) continue;
    const monthly = monthlyOf(planOf(r));
    if (!best || monthly > best.monthly) best = { row: r, monthly };
  }
  return best?.row || null;
}

// subscription ids with at least one charge in the ledger (of a store, or all)
async function chargedIds(tenantId = null) {
  const r = await platformDb().execute({
    sql: `SELECT DISTINCT subscription_id FROM billing_events WHERE amount > 0 AND subscription_id IS NOT NULL${tenantId ? " AND tenant_id = ?" : ""}`,
    args: tenantId ? [tenantId] : [],
  });
  return new Set(r.rows.map((x) => String(x.subscription_id)));
}

export async function effectiveSubscription(tenantId, nowMs = Date.now()) {
  const rows = await rowsFor(tenantId);
  const plans = await listPlans({ activeOnly: false });
  const inForce = pickInForce(rows, (r) => plans.find((p) => p.id === r.plan_id && p.version === r.plan_version), nowMs, await chargedIds(tenantId));
  if (inForce) return { sub: inForce, reason: "in_force" };
  const current = rows.find((r) => !r.replaced_by) || null;
  if (current && ["halted", "cancelled", "expired"].includes(current.status) && current.grace_until && Date.parse(current.grace_until) > nowMs) return { sub: current, reason: "grace" };
  return { sub: null, reason: "none" };
}

const providerConfigured = async () => (await import("./razorpay-billing.js")).billingProviderConfigured();
const unconfigured = (what) => Object.assign(new Error(`Billing provider is not configured (PLATFORM_RAZORPAY_* env), so ${what}`), { code: "BILLING_UNCONFIGURED" });
const errText = (e) => String(e?.message || e).slice(0, 200);

// Cancel one provider row at Razorpay and record the outcome on the row.
// -> { id, ended: "cycle_end" | "now" | null, error? }. Never throws.
async function cancelAtProvider(row, { atCycleEnd }) {
  const db = platformDb();
  try {
    const { cancelProviderSubscription } = await import("./razorpay-billing.js");
    await cancelProviderSubscription(row.razorpay_subscription_id, { atCycleEnd });
    const ended = atCycleEnd ? "cycle_end" : "now";
    await db.execute({ sql: "UPDATE subscriptions SET cancel_state = ?, cancel_error = NULL, updated_at = ? WHERE id = ?", args: [ended, nowIso(), row.id] });
    return { id: row.id, ended };
  } catch (e) {
    const error = errText(e);
    slog("billing_provider_cancel_failed", { subscription: row.id, error });
    await db.execute({ sql: "UPDATE subscriptions SET cancel_state = 'failed', cancel_error = ?, updated_at = ? WHERE id = ?", args: [error, nowIso(), row.id] });
    return { id: row.id, ended: null, error };
  }
}

// Start a subscription on the latest version of a plan, or change to it.
// A price-zero plan activates LOCALLY; a paid plan needs the platform's
// Razorpay account and hands back the founder's authorization short_url
// (status then moves only through webhooks).
//
// A change ends every live row of the store in the SAME batch that inserts
// the new one: a local row ends now (replaced, so no grace clock); a Razorpay
// row is marked replaced and then cancelled at Razorpay, at its cycle end
// (now, if it was never paid for). Replaced Razorpay rows whose cancel failed
// before are retried. If the batch loses to a concurrent change (the unique
// index), nothing is written, the new Razorpay subscription is cancelled at
// once, and the error says so (err.code BILLING_CONFLICT, err.detail).
// -> { id, plan, status, local, shortUrl?, previous: [{ id, ended, error? }] }
export async function startSubscription(tenantId, planId) {
  const tenant = await getTenant(tenantId);
  if (!tenant) throw refuse(422, `tenant ${tenantId} not found`);
  const plan = await getPlan(planId);
  if (!plan) throw refuse(422, `unknown plan "${planId}"`);

  const db = platformDb();
  const live = await rowsFor(tenantId, LIVE);
  const current = live.filter((r) => !r.replaced_by);
  const retry = live.filter((r) => r.replaced_by && r.razorpay_subscription_id && ["pending", "failed"].includes(r.cancel_state));
  if (current.some((r) => r.plan_id === plan.id && ["active", "authenticated"].includes(r.status))) throw refuse(422, `the store is already on ${plan.name}`);
  if ((plan.price > 0 || [...current, ...retry].some((r) => r.razorpay_subscription_id)) && !(await providerConfigured())) throw unconfigured("paid plans can't start or change yet");

  const id = newId("sub");
  const now = nowIso();
  let provider = null;
  if (plan.price > 0) {
    const { createProviderPlan, createProviderSubscription } = await import("./razorpay-billing.js");
    try {
      // mirror the plan into the provider once per version
      let rpPlanId = plan.razorpay_plan_id;
      if (!rpPlanId) {
        rpPlanId = (await createProviderPlan(plan)).razorpayPlanId;
        await db.execute({ sql: "UPDATE plans SET razorpay_plan_id = ? WHERE id = ? AND version = ?", args: [rpPlanId, plan.id, plan.version] });
      }
      provider = await createProviderSubscription({ ...plan, razorpay_plan_id: rpPlanId }, { tenantId });
    } catch (e) {
      // nothing of the store's subscriptions was written
      throw Object.assign(new Error("Razorpay refused the new subscription. Nothing changed; try again."), { code: "PROVIDER_ERROR", detail: { plan: plan.id, error: errText(e) } });
    }
  }

  // one batch: end the current rows and insert the new one
  const stmts = current.map((r) =>
    r.razorpay_subscription_id
      ? { sql: "UPDATE subscriptions SET replaced_by = ?, cancel_state = 'pending', updated_at = ? WHERE id = ? AND replaced_by IS NULL", args: [id, now, r.id] }
      : { sql: "UPDATE subscriptions SET status = 'cancelled', current_end = ?, grace_until = NULL, replaced_by = ?, updated_at = ? WHERE id = ? AND replaced_by IS NULL", args: [now, id, now, r.id] },
  );
  stmts.push(
    provider
      ? {
          sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, razorpay_subscription_id, status, short_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, tenantId, plan.id, plan.version, provider.id, provider.status || "created", provider.shortUrl, now, now],
        }
      : {
          sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, current_start, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
          args: [id, tenantId, plan.id, plan.version, now, now, now],
        },
  );
  try {
    await db.batch(stmts, "write");
  } catch (e) {
    const conflict = /UNIQUE/i.test(String(e?.message || e));
    if (!provider?.id) {
      if (!conflict) throw e;
      throw Object.assign(new Error("The store's plan changed at the same moment. Reload and check it before trying again."), { code: "BILLING_CONFLICT", detail: { conflict: true } });
    }
    // a Razorpay subscription exists that no row holds: cancel it now; if that
    // fails, or the batch failed for another reason, keep it as a replaced row
    // (cancel_state failed) so the exception queue shows it and the next change retries it
    const r = await cancelAtProvider({ id: "(none)", razorpay_subscription_id: provider.id }, { atCycleEnd: false });
    const detail = { conflict, provider_subscription: provider.id, provider_cancelled: r.ended === "now", ...(r.error ? { error: r.error } : {}) };
    if (r.error || !conflict) {
      const winner = (await rowsFor(tenantId, `replaced_by IS NULL AND ${LIVE}`).catch(() => []))[0];
      await db
        .execute({
          sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, razorpay_subscription_id, status, replaced_by, cancel_state, cancel_error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, tenantId, plan.id, plan.version, provider.id, provider.status || "created", winner?.id || "(lost a concurrent change)", r.error ? "failed" : "now", r.error || null, now, now],
        })
        .then(() => (detail.kept_as = id))
        .catch((x) => slog("billing_loser_row_failed", { tenant: tenantId, error: errText(x) }));
    }
    slog("billing_change_failed", { tenant: tenantId, ...detail });
    if (!conflict) throw Object.assign(e, { detail });
    throw Object.assign(new Error("The store's plan changed at the same moment. Reload and check it before trying again."), { code: "BILLING_CONFLICT", detail });
  }

  const previous = current.filter((r) => !r.razorpay_subscription_id).map((r) => ({ id: r.id, ended: "now" }));
  // one the founder never paid for has no cycle to keep: it ends now
  for (const r of [...current.filter((x) => x.razorpay_subscription_id), ...retry]) previous.push({ ...(await cancelAtProvider(r, { atCycleEnd: r.status !== "created" })), retried: retry.includes(r) });
  await syncTenantBillingSnapshot(tenantId);
  slog("billing_subscribed", { tenant: tenantId, plan: plan.id, local: !provider, provider_sub: provider?.id || null });
  return { id, plan: plan.id, status: provider ? provider.status || "created" : "active", local: !provider, shortUrl: provider?.shortUrl || null, previous };
}

// The audit rows of a start or plan change, for the operator and the merchant
// paths alike: billing.start with what happened to each row it ended, one
// billing.cancel_failed per Razorpay cancel that failed, and billing.start_failed
// for a start that failed part way. Provider error text is operator-only.
export async function auditStart({ actor, tenantId, result: r }) {
  const previous = r.previous.map(({ id, ended, retried = false }) => ({ id, ended, retried, cancel_failed: ended == null }));
  await audit({ actor, action: "billing.start", resource: `subscription:${r.id}`, tenantId, diff: { plan: r.plan, status: r.status, previous } });
  for (const p of r.previous.filter((x) => x.error)) {
    await audit({ actor, action: "billing.cancel_failed", resource: `subscription:${p.id}`, tenantId, diff: { during: "plan change", [OPERATOR_ONLY]: { error: p.error } } });
  }
}
export async function auditStartFailed({ actor, tenantId, plan, error: e, reason = null }) {
  const { error = null, ...detail } = e?.detail || {};
  await audit({ actor, action: "billing.start_failed", resource: `store:${tenantId}`, tenantId, diff: { code: e?.code || "ERROR", plan: plan || null, ...detail, [OPERATOR_ONLY]: { error, reason } } });
}

export const GRACE_EXTEND_MAX_DAYS = 30;
const subById = async (id) => shapeSub((await platformDb().execute({ sql: "SELECT * FROM subscriptions WHERE id = ?", args: [String(id || "")] })).rows[0] || null);

// Extend a subscription's grace (Phase 3 line 3): only on the store's newest
// subscription, only while it has a grace period (payment failing or ended:
// halted, cancelled, expired; lib/billing-state.js reads no other), by 1–30
// days from the later of now and the current grace end, with a reason.
export async function extendGrace(subscriptionId, { days, reason }) {
  const sub = await subById(subscriptionId);
  if (!sub) throw refuse(422, "unknown subscription");
  if ((await subscriptionFor(sub.tenant_id))?.id !== sub.id) throw refuse(422, "only the store's current (newest) subscription has a grace period to extend");
  if (!["halted", "cancelled", "expired"].includes(sub.status)) throw refuse(422, "only a subscription whose payment is failing or that has ended has a grace period");
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > GRACE_EXTEND_MAX_DAYS) throw refuse(422, `grace: 1 to ${GRACE_EXTEND_MAX_DAYS} days`);
  if (!String(reason || "").trim()) throw refuse(422, "extending grace needs a reason");
  const base = Math.max(Date.now(), sub.grace_until ? new Date(sub.grace_until).getTime() : 0);
  const graceUntil = new Date(base + d * 86400000).toISOString();
  await platformDb().execute({ sql: "UPDATE subscriptions SET grace_until = ?, updated_at = ? WHERE id = ?", args: [graceUntil, nowIso(), sub.id] });
  await syncTenantBillingSnapshot(sub.tenant_id);
  return { id: sub.id, tenant: sub.tenant_id, previous: sub.grace_until || null, grace_until: graceUntil };
}

// Cancel a subscription (Phase 3 line 3). A local one ends now and the
// platform's usual grace clock starts (as a provider cancellation does). A
// provider one is cancelled at Razorpay, at its cycle end unless atCycleEnd is
// false; its status then moves only through the provider's webhook, and the
// outcome is kept in cancel_state. A Razorpay error throws (code
// PROVIDER_ERROR) after it is recorded on the row. Neither can be undone.
export async function cancelSubscription(subscriptionId, { atCycleEnd = true } = {}) {
  const sub = await subById(subscriptionId);
  if (!sub) throw refuse(422, "unknown subscription");
  if (TERMINAL.has(sub.status)) throw refuse(422, "this subscription has already ended");
  if (!sub.razorpay_subscription_id) {
    const now = nowIso();
    const grace = new Date(Date.now() + graceDays() * 86400000).toISOString();
    const r = await platformDb().execute({
      sql: "UPDATE subscriptions SET status = 'cancelled', current_end = ?, grace_until = ?, updated_at = ? WHERE id = ? AND status = ?",
      args: [now, grace, now, sub.id, sub.status],
    });
    if (!Number(r.rowsAffected)) throw refuse(422, "this subscription changed at the same moment; reload and check it");
    await syncTenantBillingSnapshot(sub.tenant_id);
    return { id: sub.id, tenant: sub.tenant_id, local: true, ended: "now", grace_until: grace };
  }
  if (!(await providerConfigured())) throw unconfigured("a Razorpay subscription can't be cancelled from here");
  const r = await cancelAtProvider(sub, { atCycleEnd: atCycleEnd !== false });
  if (r.error) throw Object.assign(new Error("Razorpay refused the cancel. Nothing changed there; try again."), { code: "PROVIDER_ERROR", detail: { subscription: sub.id, tenant: sub.tenant_id, error: r.error } });
  return { id: sub.id, tenant: sub.tenant_id, local: false, ended: r.ended };
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
  const off = clampOffset(offset);
  const db = platformDb();
  const total = Number((await db.execute({ sql: `SELECT COUNT(*) n FROM subscriptions s LEFT JOIN tenants t ON t.id = s.tenant_id ${w}`, args })).rows[0]?.n || 0);
  const rows = (
    await db.execute({
      sql: `SELECT s.id, s.tenant_id, t.name AS store_name, s.plan_id, s.plan_version, s.razorpay_subscription_id, s.status, s.current_start, s.current_end,
                   s.grace_until, s.replaced_by, s.cancel_state, s.cancel_error, s.created_at, s.updated_at
            FROM subscriptions s LEFT JOIN tenants t ON t.id = s.tenant_id ${w}
            ORDER BY s.created_at DESC, s.id DESC LIMIT ${lim} OFFSET ${off}`,
      args,
    })
  ).rows.map((r) => ({
    ...shapeSub({ ...r }),
    provider: Boolean(r.razorpay_subscription_id),
    // a cancel sent to Razorpay (the row keeps its status until the webhook)
    cancel_requested: ["cycle_end", "now"].includes(r.cancel_state) ? { ended: r.cancel_state } : null,
    cancel_failed: ["failed", "pending"].includes(r.cancel_state),
  }));
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
    if (!/^\d{4}-\d{2}$/.test(month)) throw refuse(422, "month must be YYYY-MM");
    where.push("substr(e.occurred_at, 1, 7) = ?");
    args.push(month);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const lim = Math.min(Math.max(1, Number(limit) || 50), 100);
  const off = clampOffset(offset);
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
    if (subRow.replaced_by) {
      grace = null; // replaced by a plan change: the store runs on its new subscription
    } else if (["halted", "cancelled", "expired"].includes(next)) {
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
  if (!String(reason || "").trim()) throw refuse(422, "an override needs a reason");
  features = validPlanFeatures(features);
  if (!Object.keys(features).length) throw refuse(422, "an override needs at least one feature");
  if (!(await getTenant(String(tenantId || "")))) throw refuse(422, "unknown store");
  if (expiresAt != null) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) throw refuse(422, "the expiry must be a date");
    expiresAt = t.toISOString();
  }
  await platformDb().execute({
    sql: `INSERT INTO entitlement_overrides (tenant_id, features, reason, set_by, expires_at, created_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(tenant_id) DO UPDATE SET features = excluded.features, reason = excluded.reason, set_by = excluded.set_by, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    args: [tenantId, JSON.stringify(features), String(reason).trim().slice(0, 300), setBy == null ? null : operatorActor(setBy).id, expiresAt, nowIso()],
  });
  await audit({ actor: operatorActor(setBy || "operator"), action: "billing.override", resource: `entitlement_override:${tenantId}`, tenantId, diff: { features, expiresAt, [OPERATOR_ONLY]: { reason: String(reason).slice(0, 300) } } });
}

export async function clearOverride(tenantId, { setBy = null } = {}) {
  await platformDb().execute({ sql: "DELETE FROM entitlement_overrides WHERE tenant_id = ?", args: [tenantId] });
  await audit({ actor: operatorActor(setBy || "operator"), action: "billing.override_cleared", resource: `entitlement_override:${tenantId}`, tenantId, diff: { cleared: true } });
}

// Plan features (pinned version) ← operator override, per-field.
// Plan features from the subscription in force (effectiveSubscription: never
// an unpaid one) ← operator override, per-field. None in force = the free plan.
export async function entitlementsFor(tenantId) {
  const { sub } = await effectiveSubscription(tenantId);
  const plan = sub ? await getPlan(sub.plan_id, sub.plan_version) : await getPlan("free");
  const override = await getOverride(tenantId);
  return {
    plan: plan?.id || "free",
    planVersion: plan?.version || 1,
    source: sub ? "subscription" : "default-free",
    features: { ...(plan?.features || {}), ...(override?.features || {}) },
    // that an override exists and what it grants, never why: the reason is operator-only
    override: override ? { expiresAt: override.expiresAt, fields: Object.keys(override.features) } : null,
  };
}

// Push the derived snapshot into tenants.config.billing (edge hot path reads
// only this; lib/billing-state.js interprets it).
// The row is the one in force; with none, the current (unreplaced) row, so an
// unpaid, failing or ended subscription still shows its state and grace.
export async function syncTenantBillingSnapshot(tenantId) {
  const { sub: inForce } = await effectiveSubscription(tenantId);
  const sub = inForce || (await rowsFor(tenantId, "replaced_by IS NULL"))[0] || (await subscriptionFor(tenantId));
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
  const byTenant = new Map();
  for (const s of subs) byTenant.set(s.tenant_id, [...(byTenant.get(s.tenant_id) || []), s]);
  const plans = await listPlans({ activeOnly: false });
  const planOf = (s) => plans.find((p) => p.id === s.plan_id && p.version === s.plan_version);

  // MRR: each store's subscription in force (never an unpaid one, and a paid
  // one still running out its cycle after a downgrade); the row shown is the
  // store's newest
  let mrr = 0;
  const tenants = [];
  const now = Date.now();
  const charged = await chargedIds();
  for (const rows of byTenant.values()) {
    const s = rows[0];
    const monthly = monthlyOf(planOf(s));
    mrr += monthlyOf(planOf(pickInForce(rows, planOf, now, charged) || {}));
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
    ...(await db.execute(`SELECT id, tenant_id, cancel_error FROM subscriptions WHERE cancel_state IN ('failed','pending') AND ${LIVE} ORDER BY updated_at DESC LIMIT 20`)).rows.map((r) => ({
      kind: "cancel_failed",
      tenant: r.tenant_id,
      detail: `${r.id}: Razorpay still bills it (${r.cancel_error || "cancel not confirmed"}). Cancel it, or change plan to retry.`,
    })),
  ];
  return { tenants, mrr, revenue: await revenueByMonth(), exceptions, overrides };
}
