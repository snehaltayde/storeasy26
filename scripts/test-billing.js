// Billing & entitlements suite (Session 40 / BE11 + BE33): versioned plan
// catalog, subscription lifecycle via synthetic provider events (dedupe,
// out-of-order repair, terminal-state protection), grace → degraded clocks,
// the signed-amount ledger (gross/refunds/net), entitlement resolution
// (plan ← override), tenant snapshot push + the degraded checkout gate, and
// idempotent usage metering with pre-limit warnings.
//   pnpm test:billing
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-bill-default.db";
process.env.PLATFORM_DB_URL = "file:.test-bill-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_BILLING_GRACE_DAYS = "7";
delete process.env.PLATFORM_RAZORPAY_KEY_ID; // provider deliberately unconfigured
delete process.env.PLATFORM_RAZORPAY_KEY_SECRET;

const dbs = [".test-bill-default.db", ".test-bill-platform.db", ".test-bill-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const B = await import("../lib/platform/billing.js");
const { billingDegraded, billingInGrace, billingLabel, quotaStatus } = await import("../lib/billing-state.js");
const { checkoutCapability } = await import("../lib/commerce/adapter.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "shop", name: "Shop", domains: ["shop.test"], dbUrl: "file:.test-bill-t1.db", config: {}, secrets: {} });
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await withTenant(await C.getTenant("shop"), async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, await loadMigrations("tenant"));
});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const throws = async (fn, re, label = "") => {
  try {
    await fn();
  } catch (e) {
    if (!re.test(e.message)) throw new Error(`${label} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${label} expected a throw`);
};

// link a provider subscription id to the shop tenant via a paid-plan row we
// insert directly (startSubscription refuses paid plans without the provider
// — that refusal is itself under test below)
async function seedProviderSub(rpId, planId = "starter", version = 1) {
  // pinned explicitly at the SOLD version (v1), so the entitlement tests can
  // prove pinning even after the catalog moved to v2
  // one current subscription per store (platform migration 0017): the store's
  // earlier rows end first, as a plan change would end them
  await C.platformDb().execute({
    sql: "UPDATE subscriptions SET status = 'cancelled', replaced_by = ? WHERE tenant_id = 'shop' AND replaced_by IS NULL AND status NOT IN ('cancelled','completed','expired')",
    args: [`sub_test_${rpId}`],
  });
  await C.platformDb().execute({
    sql: `INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, razorpay_subscription_id, status, created_at, updated_at)
          VALUES (?, 'shop', ?, ?, ?, 'created', ?, ?)`,
    args: [`sub_test_${rpId}`, planId, version, rpId, new Date().toISOString(), new Date().toISOString()],
  });
}
const ev = (type, { id, rpSub = "rzsub_1", at, amount, paymentId } = {}) => ({
  eventId: id,
  type,
  occurredAt: at,
  subscription: { id: rpSub, current_end: at ? Math.floor(new Date(at).getTime() / 1000) + 30 * 86400 : undefined },
  payment: amount != null ? { id: paymentId || `pay_${id}`, amount } : null,
});

console.log("— plan catalog (versioned)");

await t("default plans seed idempotently; versions are immutable (change = new version)", async () => {
  await B.ensureDefaultPlans();
  await B.ensureDefaultPlans();
  const plans = await B.listPlans();
  eq(plans.length, 3);
  const v2 = await B.createPlanVersion("starter", { name: "Starter", price: 129900, features: { orders_per_month: 750, staff_seats: 5 } });
  eq(v2.version, 2);
  const v1 = await B.getPlan("starter", 1);
  eq(v1.price, 99900, "old version intact:");
  eq(v1.status, "retired", "old version retired for NEW subscribers:");
  eq((await B.getPlan("starter")).version, 2, "latest active wins:");
  await throws(() => B.createPlanVersion("starter", { name: "x", price: -5 }), /non-negative/);
});

console.log("— subscriptions & provider events");

await t("free plan activates locally; paid plan without provider = honest refusal", async () => {
  const r = await B.startSubscription("shop", "free");
  eq(r.status, "active");
  eq(r.local, true);
  const snap = (await C.getTenant("shop")).config.billing;
  eq(snap.plan, "free", "snapshot pushed:");
  await throws(() => B.startSubscription("shop", "growth"), /not configured/);
});

await t("lifecycle: activated → charged lands money in the ledger and activates", async () => {
  await seedProviderSub("rzsub_1");
  await B.applyBillingEvent(ev("subscription.activated", { id: "e1", at: "2026-10-01T00:00:00Z" }));
  await B.applyBillingEvent(ev("subscription.charged", { id: "e2", at: "2026-10-01T00:05:00Z", amount: 99900 }));
  const sub = await B.subscriptionFor("shop");
  eq(sub.status, "active");
  eq(sub.razorpay_subscription_id, "rzsub_1");
  const rev = await B.revenueByMonth();
  eq(rev[0].gross, 99900);
  eq(rev[0].net, 99900);
});

await t("webhook replay dedupes by provider event id (money counted once)", async () => {
  const r = await B.applyBillingEvent(ev("subscription.charged", { id: "e2", at: "2026-10-01T00:05:00Z", amount: 99900 }));
  eq(r.deduped, true);
  eq((await B.revenueByMonth())[0].gross, 99900, "still one charge:");
});

await t("refund matches its charge by payment id; net = gross − refunds", async () => {
  await B.applyBillingEvent({ eventId: "e3", type: "refund.processed", occurredAt: "2026-10-02T00:00:00Z", payment: { id: "pay_e2", amount: 99900 } });
  const rev = (await B.revenueByMonth())[0];
  eq(rev.refunds, 99900);
  eq(rev.net, 0);
  const orphan = await B.applyBillingEvent({ eventId: "e3b", type: "refund.processed", occurredAt: "2026-10-02T01:00:00Z", payment: { id: "pay_unknown", amount: 500 } });
  eq(orphan.orphan, true, "unmatched refund flagged:");
});

await t("out-of-order: a late-arriving OLDER status event can't regress state", async () => {
  await B.applyBillingEvent(ev("subscription.halted", { id: "e4", at: "2026-10-10T00:00:00Z" }));
  eq((await B.subscriptionFor("shop")).status, "halted");
  const r = await B.applyBillingEvent(ev("subscription.activated", { id: "e5", at: "2026-10-05T00:00:00Z" }));
  eq(r.stale, true);
  eq((await B.subscriptionFor("shop")).status, "halted", "older event ignored for status:");
});

await t("grace clock: halted keeps service in grace, then degrades; recovery clears it", async () => {
  const sub = await B.subscriptionFor("shop");
  if (!sub.grace_until) throw new Error("halted set no grace");
  const snap = (await C.getTenant("shop")).config.billing;
  eq(billingInGrace(snap, new Date("2026-10-11T00:00:00Z").getTime()), true, "day 1 = grace:");
  eq(billingDegraded(snap, new Date("2026-10-11T00:00:00Z").getTime()), false);
  const past = new Date(snap.grace_until).getTime() + 1000;
  eq(billingDegraded(snap, past), true, "past grace = degraded:");
  eq(billingLabel(snap, past), "degraded");
  await B.applyBillingEvent(ev("subscription.resumed", { id: "e6", at: "2026-10-12T00:00:00Z" }));
  const snap2 = (await C.getTenant("shop")).config.billing;
  eq(snap2.status, "active");
  eq(snap2.grace_until, null, "recovery clears grace:");
});

await t("terminal protection: cancelled never reverts on a later activated", async () => {
  await B.applyBillingEvent(ev("subscription.cancelled", { id: "e7", at: "2026-10-20T00:00:00Z" }));
  await B.applyBillingEvent(ev("subscription.activated", { id: "e8", at: "2026-10-21T00:00:00Z" }));
  eq((await B.subscriptionFor("shop")).status, "cancelled");
});

await t("orphan provider events land in the ledger + exception queue, never lost", async () => {
  const r = await B.applyBillingEvent(ev("subscription.charged", { id: "e9", rpSub: "rzsub_unknown", at: "2026-10-22T00:00:00Z", amount: 500 }));
  eq(r.orphan, true);
  const o = await B.billingOverview();
  if (!o.exceptions.some((x) => x.kind === "orphan_event")) throw new Error("orphan missing from exceptions");
});

console.log("— entitlements (BE33)");

await t("no subscription → free plan; subscription → pinned plan version", async () => {
  await C.upsertTenant({ id: "fresh", name: "Fresh", domains: ["fresh.test"], dbUrl: "file:.test-bill-t1.db", config: {}, secrets: {} });
  const none = await B.entitlementsFor("fresh");
  eq(none.plan, "free");
  eq(none.source, "default-free");
  const shop = await B.entitlementsFor("shop");
  eq(shop.plan, "starter");
  eq(shop.planVersion, 1, "pinned at the SOLD version, not latest:");
  eq(shop.features.orders_per_month, 500, "v1 quota, not v2's 750:");
});

await t("operator override wins per-field, needs a reason, expires", async () => {
  await throws(() => B.setOverride("shop", { features: { orders_per_month: 9999 }, reason: "" }), /reason/);
  await B.setOverride("shop", { features: { orders_per_month: 9999 }, reason: "launch week bump", setBy: "op1" });
  const ent = await B.entitlementsFor("shop");
  eq(ent.features.orders_per_month, 9999, "override wins:");
  eq(ent.features.staff_seats, 5, "untouched fields keep plan values:");
  await B.setOverride("shop", { features: { orders_per_month: 1 }, reason: "expired test", expiresAt: "2020-01-01T00:00:00Z" });
  eq((await B.entitlementsFor("shop")).features.orders_per_month, 500, "expired override ignored:");
  await B.clearOverride("shop");
});

await t("degraded snapshot pauses CHECKOUT only (storefront never hard-shut-down)", async () => {
  const tenant = await C.getTenant("shop");
  const degradedSnap = { ...tenant.config.billing, status: "halted", grace_until: "2020-01-01T00:00:00Z" };
  const cap = await withTenant({ ...tenant, config: { ...tenant.config, billing: degradedSnap } }, () => checkoutCapability());
  eq(cap.available, false);
  eq(cap.billing, "degraded");
  if (!/browsing stays open/i.test(cap.reason)) throw new Error(`copy: ${cap.reason}`);
  // and a healthy snapshot keeps checkout on
  const cap2 = await withTenant({ ...tenant, config: { ...tenant.config, billing: { ...degradedSnap, status: "active" } } }, () => checkoutCapability());
  eq(cap2.available, true, "healthy = full service:");
  // no snapshot at all (legacy/unbilled) = full service
  const cap3 = await withTenant({ ...tenant, config: { ...tenant.config, billing: null } }, () => checkoutCapability());
  eq(cap3.available, true, "unbilled = full service:");
});

console.log("— usage & quotas (BE33)");

await t("usage events are idempotent; quota meter warns at 80% and flags over", async () => {
  await B.recordUsage("shop", "api_calls_per_month", 1, "u1");
  const dup = await B.recordUsage("shop", "api_calls_per_month", 1, "u1");
  eq(dup.recorded, false, "idempotent:");
  await B.recordUsage("shop", "api_calls_per_month", 3, "u2");
  const totals = await B.usageTotals("shop");
  eq(totals.api_calls_per_month, 4);
  const q = quotaStatus({ orders_per_month: 100 }, { orders_per_month: 85 });
  eq(q[0].warn, true, "80% warns:");
  eq(q[0].over, false);
  const q2 = quotaStatus({ orders_per_month: 100 }, { orders_per_month: 101 });
  eq(q2[0].over, true);
  eq(quotaStatus({ campaigns: true }, {}).length, 0, "boolean flags unmetered:");
});

await t("MRR counts active subscriptions at their monthly price", async () => {
  // shop's latest sub is cancelled → MRR 0 from it; fresh has none
  const o1 = await B.billingOverview();
  eq(o1.mrr, 0, "cancelled ≠ MRR:");
  await seedProviderSub("rzsub_2", "growth");
  await B.applyBillingEvent(ev("subscription.activated", { id: "e10", rpSub: "rzsub_2", at: "2026-10-25T00:00:00Z" }));
  const o2 = await B.billingOverview();
  eq(o2.mrr, 299900, "active growth counts:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
