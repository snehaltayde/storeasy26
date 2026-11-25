// Operator billing suite (Phase 3 line 3, docs/plans/phase-3.md "Line 3").
//   pnpm test:platform-billing
// The /platform/billing screen's API and library: the paise boundary, plan
// versions (validated, retired, subscriber counts), start or change plan (a
// free plan locally, a paid one through the Razorpay stand-in, the old one
// ended: local now, provider at cycle end), extend grace, cancel (local now;
// provider at cycle end by default), overrides with a reason and an expiry,
// costs inputs and budgets, the subscription and ledger lists, and the
// least-trusted callers. Every write leaves a billing.* or costs.* audit row
// naming the real operator. Razorpay is a fetch stand-in that records each
// call; any other host fails the suite. Every database is a throwaway file.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-platbill-default.db";
process.env.PLATFORM_SECRET = "test-platform-billing-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_BILLING_GRACE_DAYS = "7";

// --- the Razorpay stand-in: records every call, refuses every other host -------------
const razorpay = [];
const elsewhere = [];
let rpSeq = 0;
// failNext.push(regex): the next Razorpay call whose path matches answers 400
const failNext = [];
// gate: when set, new Razorpay subscriptions wait until `of` callers have asked
// for one, so two plan changes both read the store before either writes
let gate = null;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input?.url ?? input));
  if (url.host !== "api.razorpay.com") {
    elsewhere.push(url.href.slice(0, 120));
    throw new Error("platform-billing suite: network blocked");
  }
  const body = init.body ? JSON.parse(init.body) : null;
  razorpay.push({ method: init.method || "GET", path: url.pathname, body });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const f = failNext.findIndex((re) => re.test(url.pathname));
  if (f >= 0) {
    failNext.splice(f, 1);
    return json({ error: { code: "BAD_REQUEST_ERROR", description: "RZP_CANARY stand-in refusal" } }, 400);
  }
  if (url.pathname === "/v1/plans") return json({ id: `plan_rp${++rpSeq}` });
  if (url.pathname === "/v1/subscriptions" && gate) {
    gate.n++;
    if (gate.n >= gate.of) gate.open();
    await gate.opened;
  }
  if (url.pathname === "/v1/subscriptions") return json({ id: `sub_rp${++rpSeq}`, status: "created", short_url: `https://rzp.io/i/pay${rpSeq}` });
  const m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/);
  if (m) return json({ id: m[1], status: body?.cancel_at_cycle_end ? "active" : "cancelled" });
  return json({ error: { description: "stand-in: unknown path" } }, 404);
};
const providerOn = () => {
  process.env.PLATFORM_RAZORPAY_KEY_ID = "rzp_test_standin";
  process.env.PLATFORM_RAZORPAY_KEY_SECRET = "standin-secret";
};
const providerOff = () => {
  process.env.PLATFORM_RAZORPAY_KEY_ID = "";
  process.env.PLATFORM_RAZORPAY_KEY_SECRET = "";
};

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- money at the boundary (pure) ----------------------------------------------------
const M = await import("../lib/platform/billing-money.js");
await t("money: paise are shown in rupees and typed rupees become whole paise", () => {
  eq(M.formatPaise(129900), "₹1,299", "whole");
  eq(M.formatPaise(129950), "₹1,299.50", "with paise");
  eq(M.formatPaise(0), "₹0", "zero");
  eq(M.formatPaise(null), "", "missing");
  eq(M.rupeesToPaise("1,299.50"), 129950, "comma and decimals");
  eq(M.rupeesToPaise("₹ 999"), 99900, "symbol");
  eq(M.rupeesToPaise("0"), 0, "free");
  eq(M.rupeesToPaise("12.5"), 1250, "one decimal");
  for (const bad of ["12.345", "-1", "abc", "", "1e3"]) eq(M.rupeesToPaise(bad), null, `"${bad}"`);
  eq(M.formatPaise(M.rupeesToPaise("2,999")), "₹2,999", "round trip");
});

// --- the store, the operator and the callers ------------------------------------------
const store = await H.makeRoleStore({ name: "platbill" });
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const B = await import("../lib/platform/billing.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = () => C.platformDb();
const HOST = "localhost:3000";
const A = store.a.id;
const Bid = store.b.id;
const operatorId = store.users.operator.id;
const JARS = {
  operator: { _platform: (await S.createSession({ userId: operatorId, kind: "operator", ttlMs: 10 * 60_000 })).token },
  "signed-out": {},
  "merchant-owner": store.cookies.owner,
  "merchant-token-in-platform": { _platform: store.cookies.owner._admin },
};

async function call(caller, path, method, { body, query, origin } = {}) {
  const route = await import(pathToFileURL(join(ROOT, "app/api/platform", path, "route.js")).href);
  const headers = { host: HOST };
  const o = origin === undefined ? (method === "GET" ? null : `http://${HOST}`) : origin;
  if (o) headers.origin = o;
  const jar = JARS[caller];
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  let reqBody;
  if (body !== undefined && method !== "GET") {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await route[method](new NextRequest(`http://${HOST}/api/platform/${path}${query ? `?${query}` : ""}`, { method, headers, body: reqBody }), { params: Promise.resolve({}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text };
}
const op = (body) => call("operator", "billing", "POST", { body });
const auditSince = async (since, action) =>
  (await db().execute({ sql: "SELECT actor, actor_kind, tenant_id, resource, diff FROM audit_log WHERE at >= ? AND action = ? ORDER BY at", args: [since, action] })).rows;
async function audited(since, action, { tenant } = {}) {
  const rows = await auditSince(since, action);
  ok(rows.length, `an audit row for ${action}`);
  for (const r of rows) {
    eq(`${r.actor}/${r.actor_kind}`, `${operatorId}/operator`, `${action} actor`);
    if (tenant !== undefined) eq(r.tenant_id, tenant, `${action} tenant`);
  }
  return rows;
}
const subsOf = async (tenant) => (await db().execute({ sql: "SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at, id", args: [tenant] })).rows;
const tick = () => new Promise((r) => setTimeout(r, 3));

await t("setup: outside services blank, file: databases only, the provider unset", async () => {
  for (const url of [process.env.PLATFORM_DB_URL, store.a.tenant.dbUrl, store.b.tenant.dbUrl]) ok(/^file:\.test-platbill-/.test(url), `${url}`);
  eq(process.env.PLATFORM_RAZORPAY_KEY_ID, "", "provider key");
});

// --- plans -------------------------------------------------------------------------
await t("plans: GET lists every default version with its subscriber count and the provider state", async () => {
  const r = await call("operator", "billing", "GET");
  eq(r.status, 200, r.text.slice(0, 160));
  for (const id of ["free", "starter", "growth"]) ok(r.body.plans.some((p) => p.id === id && p.subscribers === 0), id);
  eq(r.body.provider_configured, false, "provider");
});

await t("plans: a new version is validated (id, name, whole paise, interval, feature keys and values)", async () => {
  const bad = [
    [{ plan: "", spec: { name: "X", price: 100 } }, /plan id/],
    [{ plan: "Bad Id", spec: { name: "X", price: 100 } }, /plan id/],
    [{ plan: "scale", spec: { name: "", price: 100 } }, /name/],
    [{ plan: "scale", spec: { name: "Scale", price: 99.5 } }, /paise/],
    [{ plan: "scale", spec: { name: "Scale", price: -1 } }, /paise/],
    [{ plan: "scale", spec: { name: "Scale", price: 100, interval: "week" } }, /interval/],
    [{ plan: "scale", spec: { name: "Scale", price: 100, features: { "Bad Key": 1 } } }, /lowercase/],
    [{ plan: "scale", spec: { name: "Scale", price: 100, features: { seats: { nested: 1 } } } }, /number/],
    [{ plan: "scale", spec: { name: "Scale", price: 100, features: [1] } }, /key\/value/],
  ];
  for (const [body, re] of bad) {
    const r = await op({ action: "plan_version", ...body });
    eq(r.status, 422, JSON.stringify(body));
    ok(re.test(r.body?.error || ""), `${JSON.stringify(body)}: ${r.body?.error}`);
  }
  eq(Number((await db().execute("SELECT COUNT(*) n FROM plans WHERE id = 'scale'")).rows[0].n), 0, "nothing saved");
});

await t("plans: a valid version goes on sale, the previous one stops selling; audited with the operator", async () => {
  const since = new Date().toISOString();
  const v1 = await op({ action: "plan_version", plan: "scale", spec: { name: "Scale", price: 499900, interval: "month", features: { orders_per_month: 20000, staff_seats: 30, priority_support: true } } });
  eq(v1.status, 200, v1.text.slice(0, 160));
  eq(v1.body.result.version, 1, "v1");
  const v2 = await op({ action: "plan_version", plan: "scale", spec: { name: "Scale", price: 549900, features: { orders_per_month: 25000 } } });
  eq(v2.body.result.version, 2, "v2");
  const scale = v2.body.plans.filter((p) => p.id === "scale");
  eq(scale.find((p) => p.version === 1).status, "retired", "v1 retired by v2");
  eq(scale.find((p) => p.version === 2).status, "active", "v2 on sale");
  const rows = await audited(since, "billing.plan_version", { tenant: null });
  eq(rows.length, 2, "two rows");
});

await t("plans: retire a version: no new sales on it; a store pinned to it keeps it; counts follow", async () => {
  // a store on scale v2 (inserted directly: paid starts need the provider)
  const now = new Date().toISOString();
  await db().execute({ sql: "INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, created_at, updated_at) VALUES ('sub_pinned', ?, 'scale', 2, 'active', ?, ?)", args: [Bid, now, now] });
  let r = await call("operator", "billing", "GET");
  eq(r.body.plans.find((p) => p.id === "scale" && p.version === 2).subscribers, 1, "one subscriber");
  const since = new Date().toISOString();
  r = await op({ action: "retire", plan: "scale", version: 2 });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.plans.find((p) => p.id === "scale" && p.version === 2).status, "retired", "retired");
  await audited(since, "billing.plan_retired", { tenant: null });
  eq((await op({ action: "retire", plan: "scale", version: 2 })).status, 422, "twice");
  eq((await op({ action: "retire", plan: "scale", version: 9 })).status, 422, "unknown version");
  eq(await B.getPlan("scale"), null, "no version of scale on sale");
  const start = await op({ action: "start", tenant: A, plan: "scale" });
  eq(start.status, 422, "cannot start a retired plan");
  const ent = await B.entitlementsFor(Bid);
  eq(`${ent.plan}@${ent.planVersion}`, "scale@2", "pinned");
  eq(ent.features.orders_per_month, 25000, "pinned features");
  await db().execute("DELETE FROM subscriptions WHERE id = 'sub_pinned'");
  await B.syncTenantBillingSnapshot(Bid);
});

// --- start, change, grace, cancel ------------------------------------------------------
await t("start: a free plan starts locally, active, with no provider call; audited on the store", async () => {
  const since = new Date().toISOString();
  const calls = razorpay.length;
  const r = await op({ action: "start", tenant: A, plan: "free" });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.result.status, "active", "active");
  eq(r.body.result.local, true, "local");
  eq(r.body.result.shortUrl, null, "no link");
  eq(razorpay.length, calls, "no provider call");
  await audited(since, "billing.start", { tenant: A });
  eq((await C.getTenant(A)).config.billing?.status, "active", "snapshot pushed");
  eq((await op({ action: "start", tenant: A, plan: "free" })).status, 422, "already on it");
});

await t("start: a paid plan with Razorpay not set up answers 503 and changes nothing", async () => {
  const before = (await subsOf(A)).length;
  const r = await op({ action: "start", tenant: A, plan: "starter" });
  eq(r.status, 503, r.text.slice(0, 160));
  eq(r.body.code, "BILLING_UNCONFIGURED", "code");
  eq((await subsOf(A)).length, before, "no new row");
  eq((await subsOf(A)).at(-1).status, "active", "the free plan still runs");
});

let paidSub = null;
await t("change plan: free -> starter returns the founder's payment link once and ends the free plan now", async () => {
  providerOn();
  const since = new Date().toISOString();
  const calls = razorpay.length;
  await tick();
  const r = await op({ action: "start", tenant: A, plan: "starter" });
  eq(r.status, 200, r.text.slice(0, 160));
  ok(/^https:\/\/rzp\.io\/i\/pay\d+$/.test(r.body.result.shortUrl || ""), `link ${r.body.result.shortUrl}`);
  eq(r.body.result.previous?.[0]?.ended, "now", "old ended now");
  const made = razorpay.slice(calls).map((c) => `${c.method} ${c.path}`);
  eq(made.join(", "), "POST /v1/plans, POST /v1/subscriptions", "provider calls");
  const subs = await subsOf(A);
  eq(subs.at(-2).status, "cancelled", "the free row ended");
  eq(subs.at(-2).grace_until, null, "no grace on a replaced plan");
  eq(subs.at(-1).status, "created", "the paid row waits for payment");
  paidSub = subs.at(-1);
  await audited(since, "billing.start", { tenant: A });
  const list = await call("operator", "billing", "GET", { query: `view=subscriptions&store=${A}` });
  ok(!list.text.includes("rzp.io"), "the link is not listed again");
});

await t("change plan: starter (Razorpay, paid) -> growth cancels the old one at Razorpay at its cycle end", async () => {
  await db().execute({ sql: "UPDATE subscriptions SET status = 'active' WHERE id = ?", args: [paidSub.id] }); // as its activated webhook would
  const calls = razorpay.length;
  await tick();
  const r = await op({ action: "start", tenant: A, plan: "growth" });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.result.previous?.[0]?.ended, "cycle_end", "old at cycle end");
  const cancel = razorpay.slice(calls).find((c) => c.path.endsWith("/cancel"));
  ok(cancel, "a cancel call");
  eq(cancel.path, `/v1/subscriptions/${paidSub.razorpay_subscription_id}/cancel`, "the old provider id");
  eq(cancel.body.cancel_at_cycle_end, true, "cycle end");
  eq((await subsOf(A)).find((s) => s.id === paidSub.id).status, "active", "status waits for the webhook");
});

await t("cancel: a Razorpay subscription is cancelled at cycle end by default; 'now' only when asked", async () => {
  const latest = (await subsOf(A)).at(-1);
  const since = new Date().toISOString();
  let calls = razorpay.length;
  let r = await op({ action: "cancel", subscription: latest.id, reason: "founder asked" });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.result.ended, "cycle_end", "ended");
  let sent = razorpay.slice(calls);
  eq(sent.length, 1, "one provider call");
  eq(sent[0].path, `/v1/subscriptions/${latest.razorpay_subscription_id}/cancel`, "path");
  eq(sent[0].body.cancel_at_cycle_end, true, "default cycle end");
  const rows = await audited(since, "billing.cancel", { tenant: A });
  ok(/founder asked/.test(rows[0].diff || ""), "the reason is audited");
  const list = await call("operator", "billing", "GET", { query: `view=subscriptions&store=${A}` });
  eq(list.body.rows.find((x) => x.id === latest.id).cancel_requested?.ended, "cycle_end", "listed as cancelling at cycle end");
  calls = razorpay.length;
  r = await op({ action: "cancel", subscription: latest.id, atCycleEnd: false });
  eq(r.status, 200, "now");
  sent = razorpay.slice(calls);
  eq(sent[0].body.cancel_at_cycle_end, false, "now when asked");
});

await t("cancel: with Razorpay not set up a provider cancel is 503 and the stand-in gets nothing", async () => {
  providerOff();
  const latest = (await subsOf(A)).at(-1);
  const calls = razorpay.length;
  const r = await op({ action: "cancel", subscription: latest.id });
  eq(r.status, 503, r.text.slice(0, 160));
  eq(razorpay.length, calls, "no call");
});

await t("cancel: a local subscription ends now with the usual grace; an ended one cannot be cancelled again", async () => {
  await tick();
  await op({ action: "start", tenant: Bid, plan: "free" });
  const sub = (await subsOf(Bid)).at(-1);
  const since = new Date().toISOString();
  const r = await op({ action: "cancel", subscription: sub.id });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.result.local, true, "local");
  const row = (await subsOf(Bid)).at(-1);
  eq(row.status, "cancelled", "cancelled");
  const days = (Date.parse(row.grace_until) - Date.now()) / 86400000;
  ok(days > 6.9 && days <= 7, `grace ${days} days`);
  eq((await C.getTenant(Bid)).config.billing?.status, "cancelled", "snapshot");
  await audited(since, "billing.cancel", { tenant: Bid });
  eq((await op({ action: "cancel", subscription: sub.id })).status, 422, "again");
  eq((await op({ action: "cancel", subscription: "sub_missing" })).status, 422, "unknown");
});

await t("grace: extends a cancelled or failing subscription by 1-30 days with a reason, from its current end", async () => {
  const sub = (await subsOf(Bid)).at(-1);
  const since = new Date().toISOString();
  for (const [body, why] of [
    [{ days: 0, reason: "x" }, "0 days"],
    [{ days: 31, reason: "x" }, "31 days"],
    [{ days: 2.5, reason: "x" }, "fractional"],
    [{ days: 5, reason: "  " }, "no reason"],
  ]) eq((await op({ action: "grace", subscription: sub.id, ...body })).status, 422, why);
  const r = await op({ action: "grace", subscription: sub.id, days: 10, reason: "bank holiday" });
  eq(r.status, 200, r.text.slice(0, 160));
  const added = (Date.parse(r.body.result.grace_until) - Date.parse(sub.grace_until)) / 86400000;
  ok(Math.abs(added - 10) < 0.001, `added ${added} days`);
  eq((await C.getTenant(Bid)).config.billing?.grace_until, r.body.result.grace_until, "snapshot");
  const rows = await audited(since, "billing.grace", { tenant: Bid });
  ok(/bank holiday/.test(rows[0].diff || ""), "reason audited");
  const active = (await subsOf(A)).find((s) => s.status === "created" || s.status === "active");
  eq((await op({ action: "grace", subscription: active.id, days: 5, reason: "x" })).status, 422, "no grace on a running subscription");
});

// --- overrides ---------------------------------------------------------------------
await t("overrides: set needs a store, features, a reason and a future expiry; set and clear are audited on the store", async () => {
  const future = new Date(Date.now() + 5 * 86400000).toISOString();
  for (const [body, why] of [
    [{ tenant: "missing-store", features: { orders_per_month: 9 }, reason: "x", expiresAt: future }, "unknown store"],
    [{ tenant: A, features: {}, reason: "x", expiresAt: future }, "no features"],
    [{ tenant: A, features: { orders_per_month: 9 }, reason: "", expiresAt: future }, "no reason"],
    [{ tenant: A, features: { orders_per_month: 9 }, reason: "x", expiresAt: "2020-01-01T00:00:00Z" }, "past expiry"],
    [{ tenant: A, features: { orders_per_month: 9 }, reason: "x", expiresAt: "soon" }, "not a date"],
  ]) eq((await op({ action: "override", ...body })).status, 422, why);
  const since = new Date().toISOString();
  const r = await op({ action: "override", tenant: A, features: { orders_per_month: 9999 }, reason: "launch week", expiresAt: future });
  eq(r.status, 200, r.text.slice(0, 160));
  const o = r.body.overrides.find((x) => x.tenant === A);
  eq(o?.features.orders_per_month, 9999, "listed");
  eq(o?.set_by, operatorId, "set_by");
  eq((await B.entitlementsFor(A)).features.orders_per_month, 9999, "wins over the plan");
  await audited(since, "billing.override", { tenant: A });
  eq((await op({ action: "clear_override", tenant: A })).status, 200, "clear");
  await audited(since, "billing.override_cleared", { tenant: A });
  eq(await B.getOverride(A), null, "gone");
});

// --- costs -------------------------------------------------------------------------
await t("costs: the month's bills and a store budget are saved and audited; a bad month is refused", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const since = new Date().toISOString();
  let r = await call("operator", "costs", "POST", { body: { inputs: { month, totals: { compute: 1000, db: 500, mail: 0, ai: 0, other: 250 }, note: "Nov bills" } } });
  eq(r.status, 200, r.text.slice(0, 160));
  await audited(since, "costs.inputs");
  r = await call("operator", "costs", "POST", { body: { budget: { tenant: A, amount: 300 } } });
  eq(r.status, 200, r.text.slice(0, 160));
  await audited(since, "costs.budget", { tenant: A });
  eq((await call("operator", "costs", "POST", { body: { budget: { tenant: A, amount: -1 } } })).status, 422, "negative budget");
  eq((await call("operator", "costs", "POST", { body: { inputs: { month: "2026-13x", totals: {} } } })).status, 422, "bad month");
  r = await call("operator", "costs", "GET", { query: `month=${month}` });
  eq(r.status, 200, r.text.slice(0, 160));
  eq(r.body.report.total, 1750, "total");
  ok(r.body.report.unallocated >= 250, "other stays unallocated");
  eq(r.body.report.tenants.find((x) => x.tenant === A)?.budget, 300, "budget in the report");
  eq((await call("operator", "costs", "GET", { query: "month=nope" })).status, 422, "GET bad month");
  ok(!r.text.includes(store.a.tenant.dbUrl), "no database URL in the report");
});

// --- lists ---------------------------------------------------------------------------
await t("subscriptions list: search by store, filter by status and plan, ?store=, every store to start; no database URL", async () => {
  const get = async (q) => (await call("operator", "billing", "GET", { query: `view=subscriptions&${q}` })).body;
  let r = await get("");
  ok(r.rows.length >= 4, `rows ${r.rows.length}`);
  ok(r.stores.some((s) => s.id === A) && r.stores.some((s) => s.id === Bid), "stores to start");
  r = await get(`q=${encodeURIComponent(store.b.tenant.name)}`);
  ok(r.rows.length && r.rows.every((x) => x.tenant_id === Bid), "search by name");
  r = await get("status=cancelled");
  ok(r.rows.length && r.rows.every((x) => x.status === "cancelled"), "status");
  r = await get("plan=growth");
  ok(r.rows.length && r.rows.every((x) => x.plan_id === "growth"), "plan");
  r = await get(`store=${A}`);
  ok(r.rows.every((x) => x.tenant_id === A), "store");
  eq(r.total, (await subsOf(A)).length, "total");
  r = await get("q=%25");
  eq(r.rows.length, 0, "a % is searched for literally");
  const raw = await call("operator", "billing", "GET", { query: "view=subscriptions" });
  for (const u of [store.a.tenant.dbUrl, store.b.tenant.dbUrl]) ok(!raw.text.includes(u), "no db_url");
});

await t("events list: newest first, 50 a page, filters for store, type, month and no store; signed amounts", async () => {
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    const at = new Date(now - i * 60_000).toISOString();
    await db().execute({
      sql: "INSERT INTO billing_events (id, provider_event_id, subscription_id, tenant_id, type, amount, payment_id, occurred_at, applied_at, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [`bev_pb${i}`, `evt_pb${i}`, null, i % 10 === 9 ? null : A, i % 5 === 4 ? "refund.processed" : "subscription.charged", i % 5 === 4 ? -10000 : 99900, `pay_pb${i}`, at, at, i % 10 === 9 ? "no matching subscription" : null],
    });
  }
  const get = async (q) => (await call("operator", "billing", "GET", { query: `view=events&${q}` })).body;
  let r = await get("");
  eq(r.rows.length, 50, "first page");
  ok(r.total >= 60, `total ${r.total}`);
  ok(r.rows[0].occurred_at >= r.rows[1].occurred_at, "newest first");
  const p2 = await get("offset=50");
  ok(p2.rows.length >= 10 && !p2.rows.some((x) => r.rows.some((y) => y.id === x.id)), "second page");
  r = await get("store=orphan");
  ok(r.rows.length === 6 && r.rows.every((x) => x.orphan && x.tenant_id == null), `orphans ${r.rows.length}`);
  r = await get(`store=${A}&type=refund.processed`);
  ok(r.rows.length && r.rows.every((x) => x.amount < 0 && x.tenant_id === A), "refunds are negative");
  ok(r.types.includes("subscription.charged"), "types for the filter");
  r = await get(`month=${new Date(now).toISOString().slice(0, 7)}`);
  ok(r.total >= 1, "this month");
  r = await get("month=1999-01");
  eq(r.total, 0, "an empty month");
  eq((await call("operator", "billing", "GET", { query: "view=events&month=bad" })).status, 422, "bad month");
  const ov = (await call("operator", "billing", "GET")).body;
  ok(ov.exceptions.some((x) => x.kind === "orphan_event"), "orphans in the exception queue");
  ok(ov.revenue.length >= 1 && ov.revenue[0].refunds > 0, "refunds by month");
});

// --- least trusted --------------------------------------------------------------------
// --- review fixes: one current subscription, features in force, partial failures --------
const C3 = "platbill-c";
await C.upsertTenant({ id: C3, name: "Platbill C", domains: ["platbill-c.test"], dbUrl: "file:.test-platbill-c-tenant.db", config: {}, secrets: {} });
const liveRows = async (tenant) => (await db().execute({ sql: "SELECT * FROM subscriptions WHERE tenant_id = ? AND replaced_by IS NULL AND status NOT IN ('cancelled','completed','expired')", args: [tenant] })).rows;
const rpEvent = (type, rpId, extra = {}) => B.applyBillingEvent({ eventId: `evt_${type}_${rpId}_${Math.random()}`, type, occurredAt: new Date().toISOString(), subscription: { id: rpId, ...extra } });

await t("concurrent: a double click on a free plan leaves exactly one current subscription", async () => {
  providerOff();
  const answers = await Promise.all([1, 2, 3].map(() => op({ action: "start", tenant: C3, plan: "free" })));
  eq(answers.filter((a) => a.status === 200).length, 1, answers.map((a) => a.status).join(","));
  ok(answers.every((a) => [200, 409, 422].includes(a.status)), "the others are refused, never a 500");
  eq((await liveRows(C3)).length, 1, "one current row");
});

await t("unique index: a second current row for a store is refused by the database itself", async () => {
  const now = new Date().toISOString();
  const tried = await db()
    .execute({ sql: "INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, created_at, updated_at) VALUES ('sub_dup', ?, 'free', 1, 'active', ?, ?)", args: [C3, now, now] })
    .then(() => "inserted", (e) => String(e.message));
  ok(/UNIQUE/.test(tried), tried);
});

await t("concurrent: two paid changes at once: one wins; the loser's new Razorpay subscription is cancelled now", async () => {
  providerOn();
  const calls = razorpay.length;
  const since = new Date().toISOString();
  gate = { n: 0, of: 2 };
  gate.opened = new Promise((r) => (gate.open = r));
  const [x, y] = await Promise.all([op({ action: "start", tenant: C3, plan: "starter" }), op({ action: "start", tenant: C3, plan: "growth" })]);
  gate = null;
  const failed = await auditSince(since, "billing.start_failed");
  eq(failed.length, 1, "the loser is audited");
  ok(/BILLING_CONFLICT/.test(failed[0].diff || ""), "with its code");
  eq([x.status, y.status].sort().join(","), "200,409", `${x.status} / ${y.status} ${y.text.slice(0, 120)}`);
  const loser = (x.status === 409 ? x : y).body.detail;
  ok(loser.provider_subscription, "the loser made a Razorpay subscription");
  eq(loser.provider_cancelled, true, "and it was cancelled");
  const sent = razorpay.slice(calls).find((c) => c.path === `/v1/subscriptions/${loser.provider_subscription}/cancel`);
  eq(sent?.body.cancel_at_cycle_end, false, "cancelled now");
  const live = await liveRows(C3);
  eq(live.length, 1, "one current row");
  eq(live[0].id, (x.status === 200 ? x : y).body.result.id, "the winner is current");
});

await t("features: an unpaid upgrade unlocks nothing; once Razorpay activates it, it does", async () => {
  // the current row (paid, created) is activated, so the store is on a paid plan
  const cur = (await liveRows(C3))[0];
  await rpEvent("subscription.activated", cur.razorpay_subscription_id, { current_end: Math.floor(Date.now() / 1000) + 20 * 86400 });
  const paidPlan = cur.plan_id;
  eq((await B.entitlementsFor(C3)).plan, paidPlan, "on the paid plan");
  await db().execute({ sql: "INSERT INTO plans (id, version, name, price, currency, interval, features, status, created_at) VALUES ('platinum', 1, 'Platinum', 999900, 'INR', 'month', '{\"orders_per_month\":99999}', 'active', ?) ON CONFLICT DO NOTHING", args: [new Date().toISOString()] });
  await tick();
  const up = await op({ action: "start", tenant: C3, plan: "platinum" });
  eq(up.status, 200, up.text.slice(0, 160));
  const ent = await B.entitlementsFor(C3);
  eq(ent.plan, paidPlan, "the unpaid upgrade unlocks nothing");
  const snap = (await C.getTenant(C3)).config.billing;
  eq(`${snap.plan}/${snap.status}`, `${paidPlan}/active`, "the snapshot stays on the paid plan");
  const rp = (await db().execute({ sql: "SELECT razorpay_subscription_id r FROM subscriptions WHERE id = ?", args: [up.body.result.id] })).rows[0].r;
  await rpEvent("subscription.activated", rp, { current_end: Math.floor(Date.now() / 1000) + 30 * 86400 });
  eq((await B.entitlementsFor(C3)).plan, "platinum", "paid: unlocked");
  eq((await C.getTenant(C3)).config.billing.plan, "platinum", "snapshot follows");
  // the replaced plan's cycle ends
  await rpEvent("subscription.cancelled", cur.razorpay_subscription_id, { current_end: Math.floor(Date.now() / 1000) - 60 });
  eq((await B.entitlementsFor(C3)).plan, "platinum", "still platinum");
});

await t("features: a downgrade from paid to free keeps the paid plan until its cycle ends, with no grace on the replaced row", async () => {
  const paid = (await liveRows(C3))[0];
  await tick();
  const down = await op({ action: "start", tenant: C3, plan: "free" });
  eq(down.status, 200, down.text.slice(0, 160));
  eq(down.body.result.previous.find((p) => p.id === paid.id)?.ended, "cycle_end", "the paid one is cancelled at cycle end");
  eq((await B.entitlementsFor(C3)).plan, "platinum", "paid features until the cycle ends");
  eq((await C.getTenant(C3)).config.billing.plan, "platinum", "snapshot");
  // the cycle ends: Razorpay's cancelled webhook
  await rpEvent("subscription.cancelled", paid.razorpay_subscription_id, { current_end: Math.floor(Date.now() / 1000) - 60 });
  const row = (await db().execute({ sql: "SELECT status, grace_until FROM subscriptions WHERE id = ?", args: [paid.id] })).rows[0];
  eq(`${row.status}/${row.grace_until}`, "cancelled/null", "no grace on a replaced row");
  eq((await B.entitlementsFor(C3)).plan, "free", "then free");
  eq((await C.getTenant(C3)).config.billing.status, "active", "the free plan runs");
});

await t("razorpay errors: a failed cancel during a change is flagged, then retried by the next change", async () => {
  // the store on a paid, active plan again
  await tick();
  const p = await op({ action: "start", tenant: C3, plan: "starter" });
  const rpOld = (await db().execute({ sql: "SELECT razorpay_subscription_id r FROM subscriptions WHERE id = ?", args: [p.body.result.id] })).rows[0].r;
  await rpEvent("subscription.activated", rpOld, { current_end: Math.floor(Date.now() / 1000) + 10 * 86400 });
  const since = new Date().toISOString();
  failNext.push(/\/cancel$/);
  await tick();
  const ch = await op({ action: "start", tenant: C3, plan: "growth" });
  eq(ch.status, 200, ch.text.slice(0, 160));
  const prev = ch.body.result.previous.find((x) => x.id === p.body.result.id);
  eq(prev?.ended, null, "not cancelled");
  ok(/RZP_CANARY/.test(prev?.error || ""), "the operator sees why");
  const row = (await db().execute({ sql: "SELECT cancel_state, replaced_by FROM subscriptions WHERE id = ?", args: [p.body.result.id] })).rows[0];
  eq(row.cancel_state, "failed", "flagged on the row");
  ok(row.replaced_by, "still replaced: one current subscription");
  eq((await liveRows(C3)).length, 1, "one current row");
  const ov = (await call("operator", "billing", "GET")).body;
  ok(ov.exceptions.some((x) => x.kind === "cancel_failed" && x.tenant === C3), "in the exception queue");
  const [a] = await audited(since, "billing.start", { tenant: C3 });
  ok(/"cancel_failed":true/.test(a.diff) && /RZP_CANARY/.test(a.diff), "the audit says what happened");
  const calls = razorpay.length;
  await tick();
  const again = await op({ action: "start", tenant: C3, plan: "starter" });
  eq(again.status, 200, again.text.slice(0, 160));
  ok(razorpay.slice(calls).some((c) => c.path === `/v1/subscriptions/${rpOld}/cancel` && c.body.cancel_at_cycle_end === true), "the next change retries it at cycle end");
  eq(again.body.result.previous.find((x) => x.id === p.body.result.id)?.retried, true, "reported as a retry");
  eq((await db().execute({ sql: "SELECT cancel_state s FROM subscriptions WHERE id = ?", args: [p.body.result.id] })).rows[0].s, "cycle_end", "now confirmed");
});

await t("razorpay errors: a refused new subscription changes nothing; a refused cancel is a 502, flagged and audited", async () => {
  const before = (await db().execute({ sql: "SELECT id, status, replaced_by FROM subscriptions WHERE tenant_id = ? ORDER BY id", args: [C3] })).rows.map((r) => `${r.id}:${r.status}:${r.replaced_by}`).join(" ");
  const since = new Date().toISOString();
  failNext.push(/^\/v1\/subscriptions$/);
  const r = await op({ action: "start", tenant: C3, plan: "growth" });
  eq(r.status, 502, r.text.slice(0, 160));
  ok(!/RZP_CANARY/.test(r.body.error), "plain words, not the provider's");
  const after = (await db().execute({ sql: "SELECT id, status, replaced_by FROM subscriptions WHERE tenant_id = ? ORDER BY id", args: [C3] })).rows.map((x) => `${x.id}:${x.status}:${x.replaced_by}`).join(" ");
  eq(after, before, "no row written or ended");
  ok(/PROVIDER_ERROR/.test((await audited(since, "billing.start_failed", { tenant: C3 }))[0].diff), "audited");
  const cur = (await liveRows(C3))[0];
  failNext.push(/\/cancel$/);
  const c = await op({ action: "cancel", subscription: cur.id, reason: "CANCEL_REASON_CANARY" });
  eq(c.status, 502, c.text.slice(0, 160));
  eq((await db().execute({ sql: "SELECT cancel_state s FROM subscriptions WHERE id = ?", args: [cur.id] })).rows[0].s, "failed", "flagged");
  const rows = await audited(since, "billing.cancel_failed", { tenant: C3 });
  ok(/RZP_CANARY/.test(rows[0].diff) && /CANCEL_REASON_CANARY/.test(rows[0].diff), "error and reason kept for operators");
  eq((await op({ action: "cancel", subscription: cur.id })).status, 200, "a retry goes through");
});

await t("grace: only the store's newest subscription, and never a paused one", async () => {
  const older = (await subsOf(A)).find((s) => s.status === "cancelled");
  ok(older && older.id !== (await B.subscriptionFor(A)).id, "an older ended row");
  const r = await op({ action: "grace", subscription: older.id, days: 3, reason: "x" });
  eq(r.status, 422, "older row");
  ok(/newest/.test(r.body.error), r.body.error);
  const newest = await B.subscriptionFor(Bid);
  await db().execute({ sql: "UPDATE subscriptions SET status = 'paused' WHERE id = ?", args: [newest.id] });
  eq((await op({ action: "grace", subscription: newest.id, days: 3, reason: "x" })).status, 422, "paused");
  await db().execute({ sql: "UPDATE subscriptions SET status = ? WHERE id = ?", args: [newest.status, newest.id] });
});

await t("merchant audit log: the store sees operator billing actions but never their reason or Razorpay's error text", async () => {
  const since = new Date().toISOString();
  await tick();
  const sub = await B.subscriptionFor(Bid);
  eq((await op({ action: "grace", subscription: sub.id, days: 2, reason: "GRACE_REASON_CANARY" })).status, 200, "grace");
  const future = new Date(Date.now() + 86400000).toISOString();
  eq((await op({ action: "override", tenant: A, features: { staff_seats: 3 }, reason: "OVERRIDE_REASON_CANARY", expiresAt: future })).status, 200, "override");
  await op({ action: "clear_override", tenant: A });
  ok((await auditSince(since, "billing.grace"))[0].diff.includes("GRACE_REASON_CANARY"), "kept for operators");
  const canaries = ["GRACE_REASON_CANARY", "OVERRIDE_REASON_CANARY", "CANCEL_REASON_CANARY", "RZP_CANARY", "founder asked", "bank holiday"];
  const hosts = { owner: store.a.tenant.domains[0], "owner-b": store.b.tenant.domains[0], support: store.a.tenant.domains[0] };
  for (const [caller, host] of Object.entries(hosts)) {
    const r = await store.call(caller, "audit", "GET", { host, query: "limit=200" });
    for (const c of canaries) ok(!r.text.includes(c), `${caller} (${r.status}) sees ${c}`);
    if (caller !== "support") {
      eq(r.status, 200, `${caller} reads its audit log`);
      ok(r.body.entries.some((e) => e.action.startsWith("billing.")), `${caller} sees the billing actions`);
    }
  }
  const { auditChanges, OPERATOR_ONLY } = await import("../lib/platform/audit.js");
  const long = JSON.stringify({ note: "x".repeat(3000), [OPERATOR_ONLY]: { reason: "TRUNC_CANARY" } });
  ok(!auditChanges(JSON.stringify({ truncated: true, preview: long.slice(0, 2000) + "\"operator_only\":{\"reason\":\"TRUNC_CANARY\"}" })).join(" ").includes("TRUNC_CANARY"), "a truncated preview is cut too");
});

await t("least trusted: signed out and merchant callers get 401 on every billing view and action, with no store data", async () => {
  const views = ["", "view=subscriptions", "view=events", `view=subscriptions&store=${A}`];
  const actions = [
    { action: "start", tenant: A, plan: "free" },
    { action: "retire", plan: "starter", version: 1 },
    { action: "grace", subscription: "sub_x", days: 1, reason: "x" },
    { action: "cancel", subscription: "sub_x" },
    { action: "override", tenant: A, features: { a: 1 }, reason: "x" },
    { action: "clear_override", tenant: A },
    { action: "plan_version", plan: "evil", spec: { name: "Evil", price: 0 } },
  ];
  const wrong = [];
  for (const caller of ["signed-out", "merchant-owner", "merchant-token-in-platform"]) {
    for (const q of views) {
      const r = await call(caller, "billing", "GET", { query: q });
      if (r.status !== 401 || r.text.includes(A) || r.text.includes(Bid)) wrong.push(`${caller} GET ${q}: ${r.status}`);
    }
    for (const body of actions) {
      const r = await call(caller, "billing", "POST", { body });
      if (r.status !== 401) wrong.push(`${caller} ${body.action}: ${r.status}`);
    }
    for (const body of [{ inputs: { month: "2026-11", totals: {} } }, { budget: { tenant: A, amount: 1 } }]) if ((await call(caller, "costs", "POST", { body })).status !== 401) wrong.push(`${caller} costs`);
    if ((await call(caller, "costs", "GET")).status !== 401) wrong.push(`${caller} costs GET`);
  }
  for (const body of actions) if ((await call("operator", "billing", "POST", { body, origin: "https://evil.test" })).status !== 403) wrong.push(`cross-origin ${body.action}`);
  if (wrong.length) throw new Error(wrong.join("\n"));
  eq(Number((await db().execute("SELECT COUNT(*) n FROM plans WHERE id = 'evil'")).rows[0].n), 0, "no plan made");
});

await t("merchant: a store's own /api/admin/billing never shows another store's subscription", async () => {
  const theirs = (await subsOf(A)).map((s) => s.id);
  const r = await store.call("owner-b", "billing", "GET", { host: store.b.tenant.domains[0] });
  eq(r.status, 200, r.text.slice(0, 160));
  for (const id of [...theirs, A]) ok(!r.text.includes(id), `store b's billing holds ${id}`);
  const mine = await store.call("owner", "billing", "GET");
  eq(mine.status, 200, "store a reads its own");
});

// --- the page, the nav and the old console ---------------------------------------------
await t("page: /platform/billing is an operator page in the nav, and its parts use only components/ui and components/kit", async () => {
  const { PLATFORM_PAGES, OPERATOR_ONLY_PAGES } = await import("./support/platform-pages.js");
  ok(PLATFORM_PAGES.some((p) => p.path === "/platform/billing" && p.file === "app/(console)/platform/billing/page.js"), "page row");
  ok(OPERATOR_ONLY_PAGES.includes("/platform/billing"), "operator only");
  const { PLATFORM_NAV, activePlatformItem } = await import("../lib/platform/nav.js");
  ok(PLATFORM_NAV.some((i) => i.id === "billing" && i.href === "/platform/billing"), "nav item");
  eq(activePlatformItem("/platform/billing")?.id, "billing", "active");
  const dir = join(ROOT, "components/platform/billing");
  const files = [...(await readdir(dir)).map((f) => join(dir, f)), join(ROOT, "app/(console)/platform/billing/page.js"), join(ROOT, "app/(console)/platform/billing/loading.js")];
  for (const f of files) {
    const src = await readFile(f, "utf8");
    ok(!/components\/console\//.test(src), `${f} imports components/console`);
    ok(!/from ["']node:/.test(src), `${f} imports node:*`);
  }
  const page = await readFile(join(ROOT, "app/(console)/platform/billing/page.js"), "utf8");
  ok(/platformOperator\(/.test(page) && /redirect\("\/platform"\)/.test(page), "the page sends non-operators to the sign-in");
});

await t("old console: billing and costs moved out; BillingPanel is allowlisted for line 7", async () => {
  const src = await readFile(join(ROOT, "components/platform/PlatformAdmin.js"), "utf8");
  ok(!/BillingPanel|CostsPanel/.test(src), "PlatformAdmin no longer renders them");
  const { ALLOWLIST } = await import("./support/dead-code-allowlist.js");
  ok(ALLOWLIST.some((r) => r.path === "components/platform/BillingPanel.js" && r.reason === "removed by Phase 3 line 7"), "allowlist row");
});

await t("no network: every outside call went to the Razorpay stand-in", () => {
  eq(elsewhere.length, 0, elsewhere.join(", "));
  ok(razorpay.length >= 5, `${razorpay.length} stand-in calls`);
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
