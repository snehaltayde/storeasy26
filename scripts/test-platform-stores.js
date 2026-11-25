// Operator Stores list and store page (Phase 3 line 1, docs/plans/phase-3.md
// "Line 1").
//   pnpm test:platform-stores
// lib/platform/stores-list.js (search, filters, sort, paging, counts, live
// health with its 5-second limit, the store page's read model), GET
// /api/platform/tenants (list, ?health=, ?legacy=1) and GET tenants/[id] as
// every caller, the /platform and /platform/stores/[id] pages, and the
// canaries: no answer an operator gets holds db_url, a database token, a
// secret value or a password hash, and no signed-out or merchant answer holds
// any store at all. Outside services are blanked and fetch() is blocked; every
// database is a throwaway file: database.
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "app/api/platform");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-platstores-default.db";
process.env.PLATFORM_SECRET = "test-platform-stores-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-platstores";
const network = H.blockNetwork();

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
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();
const read = (f) => readFile(join(ROOT, f), "utf8");

// --- 1. words (no database) -------------------------------------------------------------
const W = await import("../components/platform/stores/storesWords.js");

await t("words: a failed, slow, missing or unknown health check is never Healthy", () => {
  for (const h of [undefined, null, { state: "unreachable", reasons: [] }, { state: "missing", reasons: [] }, { state: "weird", reasons: [] }]) {
    ok(W.healthWords(h).label !== "Healthy", JSON.stringify(h));
  }
  eq(W.healthWords({ state: "unreachable", reasons: [] }).label, "Can't reach the store's database");
  eq(W.healthWords({ state: "healthy", reasons: [] }).label, "Healthy");
  eq(W.healthWords({ state: "attention", reasons: ["sync_failed", "migrations_behind"] }).label, "Needs attention: sync failed, migrations behind");
});

await t("words: onboarding n/4 or Open; every health reason and attention code has words", async () => {
  eq(W.onboardingWords({ supported: true, open: false, done: 2, total: 4 }), "2 / 4");
  eq(W.onboardingWords({ supported: true, open: true, done: 4, total: 4 }), "Open");
  eq(W.onboardingWords(null), "—");
  const L = await import("../lib/platform/stores-list.js");
  for (const r of L.HEALTH_REASONS) ok(W.HEALTH_WORDS[r], r);
  for (const r of ["shopify_uninstalled", "onboarding_problem", "incident_open", "billing_lapsed"]) ok(W.ATTENTION_WORDS[r], r);
  for (const s of L.STATUSES) ok(W.STORE_STATUS[s] && W.STATUS_FILTERS.some((f) => f.value === s), s);
});

// --- 2. the stores, the users and every caller ---------------------------------------
const store = await H.makeRoleStore({ name: "platstores" });
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const AA = await import("../lib/platform/admin-auth.js");
const B = await import("../lib/platform/billing.js");
const L = await import("../lib/platform/stores-list.js");
const { audit, operatorActor } = await import("../lib/platform/audit.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db: tdb } = await import("../lib/db.js");
const db = () => C.platformDb();
const HOST = "localhost:3000";
const a = store.a;
const b = store.b;
const operatorId = store.users.operator.id;
await db().execute({ sql: "UPDATE users SET name = 'Stores Operator Ravi' WHERE id = ?", args: [operatorId] });

// canaries: a secret value, the database urls and token, password hashes
const SECRET_VALUE = "canary-secret-value-platstores-9f3a";
await C.patchTenant(a.id, { secrets: { meta_capi_token: SECRET_VALUE } });
const now = new Date().toISOString();
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
// 55 more stores so the list pages: control-plane rows whose databases do not exist
const DB_TOKEN = "canary-db-token-platstores-77c1";
const tokenEnc = await (await import("../lib/platform/crypto.js")).encryptSecret(DB_TOKEN);
const BULK = Array.from({ length: 55 }, (_, i) => `bulk-${String(i).padStart(2, "0")}`);
for (const [i, id] of BULK.entries()) {
  await db().execute({
    sql: "INSERT INTO tenants (id, name, status, domains, db_url, db_token_enc, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)",
    args: [id, `Bulk Store ${String(i).padStart(2, "0")}`, i === 0 ? "suspended" : "active", JSON.stringify([`${id}.stores.test`]), `file:/nonexistent-dir-platstores/${id}.db`, tokenEnc, iso((60 - i) * 60_000), iso((60 - i) * 60_000)],
  });
}
// b: maintenance, an open incident, onboarding with a problem; a: a paid plan, a note, an operator audit row, onboarding 2/4
await C.patchTenant(b.id, { config: { maintenance: { enabled: true, message: "Back soon" } } });
await db().execute({ sql: "INSERT INTO incidents (id, tenant_id, title, internal_note, public_message, status, created_at) VALUES ('inc_platstores', ?, 'Checkout slow', 'internal-note-canary', 'Checkout is slow', 'open', ?)", args: [b.id, now] });
await B.ensureDefaultPlans();
await db().execute({ sql: "INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, created_at, updated_at) VALUES ('sub_old', ?, 'free', 1, 'cancelled', ?, ?)", args: [a.id, iso(86_400_000), iso(86_400_000)] });
await db().execute({ sql: "INSERT INTO subscriptions (id, tenant_id, plan_id, plan_version, status, created_at, updated_at) VALUES ('sub_now', ?, 'starter', 1, 'active', ?, ?)", args: [a.id, now, now] });
await db().execute({ sql: "INSERT INTO onboarding_progress (tenant_id, supported, open, current_step, done_count, steps, checked_at) VALUES (?, 1, 0, 'brand', 2, ?, ?)", args: [a.id, JSON.stringify([{ id: "connect", state: "done" }, { id: "import", state: "done" }, { id: "brand", state: "in_progress" }, { id: "open", state: "blocked" }]), now] });
await db().execute({ sql: "INSERT INTO onboarding_progress (tenant_id, supported, open, current_step, done_count, steps, checked_at) VALUES (?, 1, 0, 'connect', 0, ?, ?)", args: [b.id, JSON.stringify([{ id: "connect", state: "ready", problem: "token" }]), now] });
await db().execute({ sql: "INSERT INTO operator_notes (id, subject, body, operator_id, created_at) VALUES ('opn_platstores', ?, 'Called the founder about the brand step', ?, ?)", args: [`tenant:${a.id}`, operatorId, now] });
await audit({ actor: operatorActor({ kind: "operator", id: operatorId }), action: "tenant.update", resource: `tenant:${a.id}`, tenantId: a.id, diff: { name: "x" } });

const hashes = (await db().execute("SELECT password_hash FROM users WHERE password_hash IS NOT NULL")).rows.map((r) => String(r.password_hash));
const CANARIES = [SECRET_VALUE, a.tenant.dbUrl, b.tenant.dbUrl, "nonexistent-dir-platstores", DB_TOKEN, tokenEnc, `${a.id}-secret`, "platstores-a-legacy-pass", ...hashes];
const KEY_CANARIES = ['"db_url"', '"dbUrl"', '"db_token', '"dbToken"', '"secrets_enc"', '"password_hash"', '"secrets"'];
function noCanary(text, label, { keys = true } = {}) {
  for (const c of CANARIES) ok(!text.includes(c), `${label}: holds a canary value (${c.slice(0, 24)}…)`);
  if (keys) for (const k of KEY_CANARIES) ok(!text.includes(k), `${label}: holds the key ${k}`);
}
// a signed-out or merchant answer holds no store at all
const STORE_CANARIES = [a.id, b.id, a.tenant.name, b.tenant.name, "Bulk Store", "Stores Operator Ravi"];

const opSession = async (userId, ttlMs = 10 * 60_000) => (await S.createSession({ userId, kind: "operator", ttlMs })).token;
const revoked = await opSession(operatorId);
await S.revokeSessionByToken(revoked);
const bootstrap = await AA.platformSessionToken();
const JARS = {
  operator: { _platform: await opSession(operatorId) },
  "bootstrap-before": { _platform: bootstrap },
  "bootstrap-after": { _platform: bootstrap },
  "signed-out": {},
  "merchant-owner": store.cookies.owner,
  "merchant-support": store.cookies.support,
  "merchant-token-in-platform": { _platform: store.cookies.owner._admin },
  "non-operator-session": { _platform: await opSession(store.users.owner.id) },
  "revoked-operator": { _platform: revoked },
  "expired-operator": { _platform: await opSession(operatorId, -60_000) },
};
const ALLOWED = ["operator", "bootstrap-before"];
const DENIED = Object.keys(JARS).filter((c) => !ALLOWED.includes(c));
async function withoutOperators(fn) {
  await db().execute({ sql: "UPDATE users SET is_operator = 0 WHERE id = ?", args: [operatorId] });
  try {
    return await fn();
  } finally {
    await db().execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorId] });
  }
}
async function call(caller, path, { params, query, method = "GET" } = {}) {
  const route = await import(pathToFileURL(join(API, path, "route.js")).href);
  const concrete = path.replace(/\[(\w+)\]/g, (_, k) => encodeURIComponent(params?.[k] ?? k));
  const headers = { host: HOST };
  const jar = JARS[caller];
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (method !== "GET") headers.origin = `http://${HOST}`;
  const request = new NextRequest(`http://${HOST}/api/platform/${concrete}${query ? `?${query}` : ""}`, { method, headers });
  const run = () => route[method](request, { params: Promise.resolve(params ?? {}) });
  const res = caller === "bootstrap-before" ? await withoutOperators(run) : await run();
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text };
}
const list = (query = "") => call("operator", "tenants", { query });
const { makePageHarness } = await import("./support/page-harness.js");
const P = await makePageHarness({ tenant: async () => a.tenant });
const runAs = (caller, rel, opts = {}) => (caller === "bootstrap-before" ? withoutOperators(() => P.run(rel, { cookies: JARS[caller], ...opts })) : P.run(rel, { cookies: JARS[caller], ...opts }));
const LIST_PAGE = "app/(console)/platform/page.js";
const STORE_PAGE = "app/(console)/platform/stores/[id]/page.js";

// --- 3. the list ---------------------------------------------------------------------
await t("list: 50 a page, newest first by default, with total, counts and the plan list", async () => {
  const r = await list();
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.stores.length, 50, "page size");
  eq(r.body.total, 57, "total");
  eq(r.body.counts.all, 57, "counts.all");
  eq(r.body.counts.suspended, 1, "suspended");
  eq(r.body.counts.maintenance, 1, "maintenance");
  eq(r.body.counts.active, 55, "active");
  ok(r.body.plans.some((p) => p.id === "starter" && p.name === "Starter"), "plans");
  const p2 = await list("offset=50");
  eq(p2.body.stores.length, 7, "page two");
  eq(p2.body.offset, 50, "offset");
  const ids = new Set([...r.body.stores, ...p2.body.stores].map((s) => s.id));
  eq(ids.size, 57, "no row on both pages");
});

await t("list: search by name, id and domain (substring), owner email only exactly", async () => {
  eq((await list("q=Bulk%20Store%2007")).body.stores.map((s) => s.id), ["bulk-07"], "name");
  eq((await list("q=BULK-12")).body.stores.map((s) => s.id), ["bulk-12"], "id, any case");
  eq((await list("q=bulk-33.stores")).body.stores.map((s) => s.id), ["bulk-33"], "domain");
  const owner = store.users.owner.email;
  eq((await list(`q=${encodeURIComponent(owner.toUpperCase())}`)).body.stores.map((s) => s.id), [a.id], "owner email, any case");
  eq((await list(`q=${encodeURIComponent(owner.slice(1))}`)).body.total, 0, "a partial email matches nothing");
  eq((await list(`q=${encodeURIComponent(store.users.admin.email)}`)).body.total, 0, "a non-owner member's email matches nothing");
  eq((await list("q=%25")).body.total, 0, "a LIKE wildcard is literal");
});

await t("list: status, plan and needs-attention filters; the row's columns", async () => {
  eq((await list("status=maintenance")).body.stores.map((s) => s.id), [b.id], "maintenance");
  eq((await list("status=suspended")).body.stores.map((s) => s.id), ["bulk-00"], "suspended");
  eq((await list("status=active")).body.total, 55, "active");
  eq((await list("plan=starter")).body.stores.map((s) => s.id), [a.id], "plan = the latest subscription's");
  eq((await list("plan=free")).body.total, 0, "an older subscription does not count");
  eq((await list("plan=none")).body.total, 56, "no plan");
  const att = (await list("attention=1")).body;
  eq(att.stores.map((s) => s.id), [b.id], "attention");
  eq(att.stores[0].attentionReasons, ["onboarding_problem", "incident_open"], "reasons");
  const rowA = (await list(`q=${a.id}`)).body.stores.find((s) => s.id === a.id);
  eq({ status: rowA.status, plan: rowA.plan, subscription: rowA.subscription, onboarding: rowA.onboarding, supportOpen: rowA.supportOpen, incidentOpen: rowA.incidentOpen }, { status: "active", plan: "starter", subscription: "active", onboarding: { supported: true, open: false, done: 2, total: 4 }, supportOpen: true, incidentOpen: false }, "row a");
  ok(rowA.storefrontUrl?.endsWith(a.tenant.domains[0]), "storefront url");
  const rowB = (await list(`q=${b.id}`)).body.stores.find((s) => s.id === b.id);
  eq([rowB.status, rowB.incidentOpen, rowB.supportOpen], ["maintenance", true, false], "row b");
});

await t("list: sort by name, created and last updated, both ways; bad params fall back", async () => {
  const names = (q) => list(q).then((r) => r.body.stores.map((s) => s.name));
  const asc = await names("sort=name&q=bulk");
  eq(asc.slice(0, 2), ["Bulk Store 00", "Bulk Store 01"], "name asc");
  eq((await names("sort=name&dir=desc&q=bulk")).slice(0, 1), ["Bulk Store 54"], "name desc");
  eq((await names("sort=created&dir=asc&q=bulk")).slice(0, 1), ["Bulk Store 00"], "created asc");
  eq((await names("sort=updated&q=bulk")).slice(0, 1), ["Bulk Store 54"], "updated desc");
  const bad = (await list("sort=evil;drop&dir=sideways&status=nope&offset=-5")).body;
  eq([bad.params.sort, bad.params.dir, bad.params.status, bad.offset], ["created", "desc", null, 0], "fallbacks");
  for (const o of ["Infinity", "1e21", "-Infinity", "NaN", "9007199254740993"]) {
    const r = await list(`offset=${o}`);
    eq(r.status, 200, `offset=${o}`);
    ok(Number.isSafeInteger(r.body.offset) && r.body.offset <= L.MAX_OFFSET, `offset=${o} -> ${r.body.offset}`);
  }
});

// --- 4. health ---------------------------------------------------------------------
await t("health: only the named stores, reachable ones with reasons, a missing database is unreachable with no detail", async () => {
  await withTenant(await C.getTenant(a.id, { fresh: true }), () => tdb.insertInto("sync_runs").values({ id: "sync_platstores", status: "failed", error: "boom", started_at: now }).execute());
  const r = await list(`health=${a.id},${b.id},bulk-03,nope-store,${encodeURIComponent("bad id!")}`);
  eq(r.status, 200, r.text.slice(0, 200));
  eq(Object.keys(r.body.health).sort(), [a.id, b.id, "bulk-03", "nope-store"].sort(), "ids asked (a malformed one dropped)");
  const ha = r.body.health[a.id];
  eq([ha.reachable, ha.state], [true, "attention"], "a");
  ok(ha.reasons.includes("sync_failed"), `a: sync failed (${ha.reasons})`);
  eq(r.body.health[b.id].reachable, true, "b reachable");
  eq(r.body.health["bulk-03"].state, "unreachable", "a missing database");
  eq(r.body.health["nope-store"].state, "missing", "an unknown id");
  noCanary(r.text, "health");
});

// a store whose database never answers: the probe hangs for that store only
const { tenantId: currentTenant } = await import("../lib/tenant-context.js");
async function withHangingStore(id, fn, timeoutMs = 100) {
  const saved = { ...L.storesHooks };
  const real = saved.probe;
  L.storesHooks.probe = () => (currentTenant() === id ? new Promise(() => {}) : real());
  L.storesHooks.timeoutMs = timeoutMs;
  try {
    return await fn();
  } finally {
    Object.assign(L.storesHooks, saved);
  }
}

await t("health: a store slower than the limit is unreachable, never healthy; at most a page of ids", async () => {
  eq(b.tenant && (await L.storeHealth([b.id]))[b.id].state, "healthy", "b has no attention reason without the hang");
  const t0 = Date.now();
  const h = await withHangingStore(b.id, () => L.storeHealth([a.id, b.id]));
  eq(h[b.id].state, "unreachable", "the hanging store");
  eq(h[b.id].reachable, false, "never reachable");
  ok(h[a.id].reachable, "the other store is still checked");
  ok(Date.now() - t0 < 3000, `cut off at the limit (${Date.now() - t0} ms)`);
  const detail = await withHangingStore(b.id, () => L.storeDetail(b.id));
  eq([detail.live.reachable, detail.live.behind], [false, null], "the store page's live card");
  eq(Object.keys(await L.storeHealth([...BULK, ...BULK])).length, 50, "an id list is capped at a page");
  let timedOut = false;
  await L.withTimeout(new Promise(() => {}), 20).catch((e) => (timedOut = e.message === "timeout"));
  ok(timedOut, "a check that never answers is cut off");
  eq(L.healthIds(Array.from({ length: 80 }, (_, i) => `s${i}`).join(",")).length, 50, "capped");
  eq(L.HEALTH_TIMEOUT_MS, 5000, "five seconds");
});

await t("legacy: ?legacy=1 keeps the old console's shape (every store with health), minus the database url", async () => {
  const r = await list("legacy=1");
  eq(r.status, 200);
  eq(r.body.tenants.length, 57, "every store");
  eq(r.body.tenants.slice(0, 50).filter((x) => x.health.state !== "unchecked").length, 50, "the first 50 are checked");
  eq(r.body.tenants.slice(50).map((x) => [x.health.state, x.health.reachable]), Array.from({ length: 7 }, () => ["unchecked", false]), "the rest are not, and not reachable");
  const ta = r.body.tenants.find((x) => x.id === a.id);
  ok(ta.health && Array.isArray(ta.domains), "health and domains");
  noCanary(r.text, "legacy");
});

// --- 5. the store page's read model ----------------------------------------------------
await t("detail: GET tenants/[id] holds the store page and the old fields, secret names only", async () => {
  const r = await call("operator", "tenants/[id]", { params: { id: a.id } });
  eq(r.status, 200, r.text.slice(0, 200));
  const d = r.body;
  eq(d.store.id, a.id, "id");
  ok(d.store.storefrontUrl, "storefront link");
  eq(d.store.owners.map((o) => o.email), [store.users.owner.email], "owner");
  ok(d.secretNames.includes("meta_capi_token") && d.secretNames.includes("order_link_secret"), `names: ${d.secretNames}`);
  eq(d.tenant.secretsPresent.meta_capi_token, true, "the old presence map");
  eq(d.subscription && [d.subscription.plan, d.subscription.planName, d.subscription.status], ["starter", "Starter", "active"], "plan");
  eq(d.live.reachable, true, "live");
  ok(d.live.repoHead && "behind" in d.live, "migrations");
  eq(d.support.open, true, "support open");
  eq(d.support.operatorName, "Stores Operator Ravi", "support operator name");
  eq(d.notes.map((n) => [n.body, n.operatorName]), [["Called the founder about the brand step", "Stores Operator Ravi"]], "notes");
  ok(d.audit.some((x) => x.action === "tenant.update" && x.actorName === "Stores Operator Ravi"), "audit with names");
  ok(d.audit.length <= 20, "at most 20 audit rows");
  ok(Array.isArray(d.runs) && d.runs.length <= 10, "runs");
  eq(d.onboardingCache?.done, 2, "onboarding cache");
  ok(Array.isArray(d.connect.redirectUrls), "redirect urls");
  noCanary(r.text, "detail a");
  const rb = await call("operator", "tenants/[id]", { params: { id: b.id } });
  eq(rb.body.incidents.map((i) => i.title), ["Checkout slow"], "b's open incident");
  ok(!rb.text.includes("internal-note-canary"), "the incident's internal note stays off the store page");
  eq(rb.body.store.status, "maintenance", "b status");
  noCanary(rb.text, "detail b");
  eq((await call("operator", "tenants/[id]", { params: { id: "missing-store" } })).status, 404, "unknown id");
  const unreachable = await call("operator", "tenants/[id]", { params: { id: "bulk-05" } });
  eq([unreachable.status, unreachable.body.live.reachable], [200, false], "an unreachable store still opens");
  noCanary(unreachable.text, "detail bulk");
});

// --- 5b. database addresses in error text, overview reachability, the rendered page -------
const A = await import("../lib/platform/turso-api.js");

await t("scrub: libsql://, file: and Turso https addresses and the store's own url and token are stripped from error text", () => {
  const msg = "connect failed: libsql://acme-db-org.turso.io?authToken=abc; also file:/var/data/acme.db, https://acme-db-org.aws-ap-south-1.turso.io/v2/pipeline (see profile: x)";
  const out = A.scrubSecrets(msg);
  ok(!/libsql:|file:\/|turso\.io|authToken=abc/.test(out), out);
  ok(out.includes("profile: x"), `a word ending in "file:" is left alone: ${out}`);
  eq(A.scrubSecrets(`token was ${DB_TOKEN}`, [a.tenant.dbUrl, DB_TOKEN]), "token was [redacted]", "explicit values");
});

await t("canary: a provisioning run whose error holds the database address shows it nowhere", async () => {
  await db().execute({
    sql: "INSERT INTO provision_runs (id, tenant_id, status, steps, refs, params, error, created_at, updated_at) VALUES ('prov_platstores', ?, 'failed', ?, '{}', '{}', ?, ?, ?)",
    args: [a.id, JSON.stringify([{ name: "database", status: "failed" }]), `SQLITE_CANTOPEN at ${a.tenant.dbUrl} (libsql://platstores-canary.turso.io; path ${a.tenant.dbUrl.replace(/^file:/, "")})`, now, now],
  });
  const r = await call("operator", "tenants/[id]", { params: { id: a.id } });
  const run = r.body.runs.find((x) => x.id === "prov_platstores");
  ok(run && run.error.includes("SQLITE_CANTOPEN"), `the run and its error are shown: ${run?.error}`);
  noCanary(r.text, "detail with a failed run");
  ok(!r.text.includes("platstores-canary.turso.io"), "the libsql address");
  const page = await P.run(STORE_PAGE, { cookies: JARS.operator, params: { id: a.id } });
  noCanary(page.text, "store page with a failed run");
});

await t("canary: a sync that fails on the store's database answers 500 without the database address", async () => {
  const r = await call("operator", "tenants/[id]", { method: "POST", params: { id: "bulk-05" } });
  eq(r.status, 500, r.text.slice(0, 200));
  noCanary(r.text, "sync error");
  ok(r.body.error, "an error is still said");
});

await t("overview: a store that never answers is cut off at the limit and reported unreachable and uncovered, never reachable", async () => {
  const t0 = Date.now();
  const r = await withHangingStore(b.id, () => call("operator", "overview"));
  eq(r.status, 200, r.text.slice(0, 200));
  ok(Date.now() - t0 < 5000, `bounded (${Date.now() - t0} ms)`);
  const fb = r.body.fleet.find((f) => f.tenant === b.id);
  eq(fb.reachable, false, "b in the fleet");
  ok(!("behind" in fb) || fb.behind !== false, "no migration verdict for b");
  eq(r.body.fleet.find((f) => f.tenant === a.id).reachable, true, "a still reachable");
  ok(r.body.revenue30d.uncovered.some((u) => u.tenant === b.id), "b is uncovered, not counted");
  for (const id of ["bulk-03", "bulk-40"]) eq(r.body.fleet.find((f) => f.tenant === id)?.reachable, false, `${id}: a database that does not exist is unreachable`);
  noCanary(r.text, "overview");
});

// StoreDetail rendered for real (the page harness only records props): Next's
// SWC compiles components/platform/stores, components/ui, components/kit and lib
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc/index.js");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const compiled = new Map();
const resolveFile = (base) => [`${base}.js`, base].find((c) => {
  try {
    readFileSync(join(ROOT, c));
    return true;
  } catch {
    return false;
  }
});
async function loadComponent(rel) {
  if (compiled.has(rel)) return compiled.get(rel);
  await swc.loadBindings();
  const file = join(ROOT, rel);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    const local = id.startsWith("@/") ? id.slice(2) : id.startsWith(".") ? join(dirname(rel), id) : null;
    if (local) {
      const f = resolveFile(local);
      if (!f) throw new Error(`${rel}: cannot resolve ${id}`);
      deps.set(id, await loadComponent(f));
    } else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  compiled.set(rel, mod.exports);
  return mod.exports;
}

await t("render: StoreDetail renders a store with a theme pin and one with a legacy config.theme as kit-version", async () => {
  const SD = (await loadComponent("components/platform/stores/StoreDetail.js")).default;
  await C.patchTenant(a.id, { config: { theme_pin: { kit: "glow", version: 1 } } });
  await db().execute({ sql: "UPDATE tenants SET config = json_set(json_remove(config, '$.theme_pin'), '$.theme', json('{\"kit\":\"pulse\",\"version\":1}')) WHERE id = ?", args: [b.id] });
  for (const [id, want] of [[a.id, "glow-1"], [b.id, "pulse-1"]]) {
    const detail = await L.storeDetail(id);
    eq(detail.live.themePin, want, `${id} pin`);
    const html = renderToStaticMarkup(React.createElement(SD, { detail }));
    ok(html.includes(want) && html.includes('data-card="secrets"'), `${id}: rendered with ${want}`);
    noCanary(html, `${id} rendered`, { keys: false }); // HTML, not JSON: data-card="secrets" is the card's name
  }
  const none = await L.storeDetail("bulk-06");
  ok(renderToStaticMarkup(React.createElement(SD, { detail: none })).includes("Theme pin"), "an unreachable, unpinned store renders too");
});

// --- 6. every caller ------------------------------------------------------------------
await t("permissions: operator and bootstrap-before get 200 on the list, health, legacy and detail; every other caller 401 with no store in it", async () => {
  const calls = [
    ["tenants", {}],
    ["tenants", { query: `health=${a.id}` }],
    ["tenants", { query: "legacy=1" }],
    ["tenants", { query: `q=${a.id}` }],
    ["tenants/[id]", { params: { id: a.id } }],
  ];
  for (const [path, opts] of calls) {
    for (const caller of ALLOWED) {
      const r = await call(caller, path, opts);
      eq(r.status, 200, `${caller} ${path} ${JSON.stringify(opts)}`);
      noCanary(r.text, `${caller} ${path}`);
    }
    for (const caller of DENIED) {
      const r = await call(caller, path, opts);
      eq(r.status, 401, `${caller} ${path} ${JSON.stringify(opts)}`);
      for (const c of [...STORE_CANARIES, ...CANARIES]) ok(!r.text.includes(c), `${caller} ${path}: holds ${c.slice(0, 24)}`);
    }
  }
});

// --- 7. the pages -----------------------------------------------------------------------

await t("pages: /platform is the Stores list for operators and the sign-in for everyone else, with no store in it", async () => {
  for (const caller of ALLOWED) {
    const r = await runAs(caller, LIST_PAGE);
    ok(!r.error, String(r.error));
    ok(r.props.some((p) => p.component === "@/components/platform/stores/StoresTable#default"), `${caller}: the list`);
  }
  for (const caller of DENIED) {
    const r = await runAs(caller, LIST_PAGE);
    ok(r.props.some((p) => p.component === "@/components/platform/PlatformLogin#default"), `${caller}: the sign-in`);
    ok(!r.props.some((p) => p.component === "@/components/platform/stores/StoresTable#default"), `${caller}: never the list`);
    for (const c of [...STORE_CANARIES, ...CANARIES]) ok(!r.text.includes(c), `${caller}: holds ${c.slice(0, 24)}`);
  }
});

await t("pages: a store's page for operators (no database details); denied callers are sent to /platform before any read; an unknown id is not found", async () => {
  for (const caller of ALLOWED) {
    const r = await runAs(caller, STORE_PAGE, { params: { id: a.id } });
    ok(!r.error, String(r.error));
    const detail = r.props.find((p) => p.component === "@/components/platform/stores/StoreDetail#default")?.props.detail;
    eq(detail?.store.id, a.id, `${caller}: the store`);
    noCanary(JSON.stringify(detail), `${caller} page`);
    noCanary(r.text, `${caller} page text`);
    eq((await runAs(caller, STORE_PAGE, { params: { id: "missing-store" } })).notFound, true, `${caller}: unknown id`);
    for (const id of ["50%", "%E0%A4%A", "%zz"]) {
      const odd = await runAs(caller, STORE_PAGE, { params: { id } });
      eq([odd.notFound, odd.error && String(odd.error)], [true, null], `${caller}: the id ${id} is not decoded again`);
    }
  }
  for (const caller of DENIED) {
    const r = await runAs(caller, STORE_PAGE, { params: { id: a.id } });
    eq(r.redirect, "/platform", caller);
    for (const c of [...STORE_CANARIES, ...CANARIES]) ok(!r.text.includes(c), `${caller}: holds ${c.slice(0, 24)}`);
  }
});

// --- 8. static ----------------------------------------------------------------------------
const NEW_FILES = [
  "lib/platform/stores-list.js",
  "app/api/platform/tenants/route.js",
  "app/(console)/platform/page.js",
  "app/(console)/platform/loading.js",
  "app/(console)/platform/stores/[id]/page.js",
  "app/(console)/platform/stores/[id]/loading.js",
  "app/(console)/platform/stores/[id]/not-found.js",
  "app/(console)/platform/stores/[id]/error.js",
  "components/platform/stores/StoresTable.js",
  "components/platform/stores/FleetStrip.js",
  "components/platform/stores/StoreDetail.js",
  "components/platform/stores/HealthCard.js",
  "components/platform/stores/storesWords.js",
];

await t("static: the new files import nothing from components/console; StoreDetail keeps the line 2 and line 5 anchors", async () => {
  for (const f of NEW_FILES) ok(!/from ["']@\/components\/console\//.test(await read(f)), f);
  const detail = await read("components/platform/stores/StoreDetail.js");
  ok(detail.includes("{/* line 2: lifecycle */}"), "line 2 anchor");
  ok(detail.includes("{/* line 5: support access */}"), "line 5 anchor");
});

await t("static: the list route never selects a whole tenant row or sends db_url", async () => {
  const lib = await read("lib/platform/stores-list.js");
  ok(!/SELECT \* FROM tenants|t\.db_url|db_token_enc|secrets_enc/.test(lib), "stores-list reads no database url, token or secret column");
});

await t("no network: nothing reached fetch()", () => {
  eq(network, [], "fetch calls:");
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
