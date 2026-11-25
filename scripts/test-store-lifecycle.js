// Store lifecycle (Phase 3 line 2, docs/plans/phase-3.md "Line 2").
//   pnpm test:store-lifecycle
// lib/platform/store-lifecycle.js and PATCH/POST /api/platform/tenants/[id]
// (+ /export, /offboard) as every caller: suspend and resume with a reason,
// maintenance, rotating the keys Storeasy holds, edit details, sync, export
// and offboard. Each write leaves an audit row with the real operator and no
// secret value; a merchant, signed-out or cross-origin caller changes nothing;
// the other store is untouched; this server's host cache drops at once; an
// old order link fails after rotation and a new one works; a suspended
// store's jobs wait; the owner's mail; the store page's card. Outside
// services are blanked and fetch() is blocked except where a test stubs it;
// every database is a throwaway file: database.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "app/api/platform");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-lifecycle-default.db";
process.env.PLATFORM_SECRET = "test-store-lifecycle-secret";
process.env.PLATFORM_CACHE_MS = "60000"; // long, so the cache test means something
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-lifecycle";
const network = H.blockNetwork();
const blockedFetch = globalThis.fetch;

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

// --- words (no database) ------------------------------------------------------------
const W = await import("../components/platform/stores/lifecycleWords.js");
const LC = await import("../lib/platform/store-lifecycle.js");

await t("words: every mail outcome has words; the reason minimum matches the server", () => {
  for (const c of ["sent", "failed", "not_configured", "no_owner"]) ok(W.MAIL_WORDS[c], c);
  ok(W.mailWords("weird") === W.MAIL_WORDS.failed, "an unknown outcome never reads as sent");
  eq(W.REASON_MIN, LC.REASON_MIN, "REASON_MIN");
  ok(W.SUSPEND_EFFECTS.some((w) => w.includes("30 seconds")), "the 30-second note");
});

await t("only the order-link key and the console password are rotatable; merchant keys are names only", () => {
  eq(Object.keys(LC.ROTATABLE_SECRETS).sort(), ["admin_password", "order_link_secret"]);
  const merchant = LC.MERCHANT_KEYS.flatMap((g) => g.keys);
  for (const k of merchant) ok(!Object.hasOwn(LC.ROTATABLE_SECRETS, k), k);
  eq(LC.MERCHANT_KEYS.map((g) => g.name), ["Razorpay", "Meta", "Google Analytics"]);
});

// --- the stores, the users and every caller ---------------------------------------
const store = await H.makeRoleStore({ name: "lifecycle" });
const F = await import("./support/tenant-fixture.js");
const lone = await F.makeTenant({ name: "lifecycle-c", mode: "documents" }); // no members
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const AA = await import("../lib/platform/admin-auth.js");
const J = await import("../lib/platform/jobs.js");
const WK = await import("../lib/platform/worker.js");
const O = await import("../lib/orders.js");
const K = await import("../lib/customers.js");
const { db: tdb } = await import("../lib/db.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = () => C.platformDb();
const HOST = "localhost:3000";
const a = store.a;
const b = store.b;
const operatorId = store.users.operator.id;

const SECRET_CANARY = "canary-merchant-secret-lifecycle-5d1e";
const OLD_LINK_KEY = "old-order-link-key-lifecycle-0000000000000000";
await C.patchTenant(a.id, { secrets: { razorpay_key_secret: SECRET_CANARY, order_link_secret: OLD_LINK_KEY } });

const opSession = async (userId, ttlMs = 10 * 60_000) => (await S.createSession({ userId, kind: "operator", ttlMs })).token;
const revoked = await opSession(operatorId);
await S.revokeSessionByToken(revoked);
const JARS = {
  operator: { _platform: await opSession(operatorId) },
  "bootstrap-before": { _platform: await AA.platformSessionToken() },
  "bootstrap-after": { _platform: await AA.platformSessionToken() },
  "signed-out": {},
  "merchant-owner": store.cookies.owner,
  "merchant-support": store.cookies.support,
  "merchant-token-in-platform": { _platform: store.cookies.owner._admin },
  "non-operator-session": { _platform: await opSession(store.users.owner.id) },
  "revoked-operator": { _platform: revoked },
  "expired-operator": { _platform: await opSession(operatorId, -60_000) },
};
const DENIED = Object.keys(JARS).filter((c) => !["operator", "bootstrap-before"].includes(c));
async function withoutOperators(fn) {
  await db().execute({ sql: "UPDATE users SET is_operator = 0 WHERE id = ?", args: [operatorId] });
  try {
    return await fn();
  } finally {
    await db().execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorId] });
  }
}
async function call(caller, path, { params, method = "PATCH", body, origin } = {}) {
  const route = await import(pathToFileURL(join(API, path, "route.js")).href);
  const concrete = path.replace(/\[(\w+)\]/g, (_, k) => encodeURIComponent(params?.[k] ?? k));
  const headers = { host: HOST };
  const jar = JARS[caller];
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (method !== "GET") headers.origin = origin ?? `http://${HOST}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new NextRequest(`http://${HOST}/api/platform/${concrete}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const run = () => route[method](request, { params: Promise.resolve(params ?? {}) });
  const res = caller === "bootstrap-before" ? await withoutOperators(run) : await run();
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text, headers: res.headers };
}
const row = async (id) => (await db().execute({ sql: "SELECT status, name, domains, config, secrets_enc, updated_at FROM tenants WHERE id = ?", args: [id] })).rows[0];
const auditRows = async (id, action) => (await db().execute({ sql: "SELECT * FROM audit_log WHERE tenant_id = ? AND action = ? ORDER BY at, rowid", args: [id, action] })).rows;
const lastAudit = async (id, action) => (await auditRows(id, action)).at(-1);
const secretsOf = async (id) => (await C.getTenant(id, { fresh: true })).secrets;

// Every action an operator can take here, as a call. `missing` is safe to send
// as an allowed caller (a store that doesn't exist).
const ACTIONS = {
  suspend: { body: { status: "suspended", reason: "lifecycle suite" } },
  resume: { body: { status: "active", reason: "lifecycle suite" } },
  maintenance: { body: { maintenance: { enabled: true, message: "probe" } } },
  rotate: { body: { rotate: { keys: ["order_link_secret"] } } },
  update: { body: { update: { name: "Probe name" } } },
  sync: { method: "POST" },
  export: { method: "POST", path: "tenants/[id]/export" },
  offboard: { method: "POST", path: "tenants/[id]/offboard", body: { confirm: "x" } },
};
const act = (caller, name, id, extra = {}) => {
  const A = ACTIONS[name];
  return call(caller, A.path || "tenants/[id]", { method: A.method || "PATCH", params: { id }, body: A.body, ...extra });
};

// --- permissions: nobody else changes anything ----------------------------------
await t("every action: signed out, merchant, revoked, expired, non-operator and late bootstrap get 401 and the store row is unchanged", async () => {
  const before = JSON.stringify(await row(a.id));
  const auditBefore = (await db().execute({ sql: "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?", args: [a.id] })).rows[0].n;
  // offboard last: the confirm matches nothing, but keep the order anyway
  for (const caller of DENIED) {
    for (const name of Object.keys(ACTIONS)) {
      const r = await act(caller, name, a.id, name === "offboard" ? { body: { confirm: a.id } } : {});
      eq(r.status, 401, `${caller} ${name}:`);
      ok(!r.text.includes(a.tenant.name), `${caller} ${name}: no store in the answer`);
    }
  }
  eq(JSON.stringify(await row(a.id)), before, "row unchanged");
  eq((await db().execute({ sql: "SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?", args: [a.id] })).rows[0].n, auditBefore, "no audit row");
});

await t("every action: a cross-origin call gets 403 before auth, even from the operator", async () => {
  const before = JSON.stringify(await row(a.id));
  for (const name of Object.keys(ACTIONS)) {
    eq((await act("operator", name, a.id, { origin: "http://evil.test" })).status, 403, name);
    eq((await act("signed-out", name, a.id, { origin: "http://evil.test" })).status, 403, `${name} signed out`);
  }
  eq(JSON.stringify(await row(a.id)), before, "row unchanged");
});

await t("every action: the operator and the bootstrap operator (before the first operator) pass the gate (a missing store: 404 or a refusal, never 401/403)", async () => {
  for (const caller of ["operator", "bootstrap-before"]) {
    for (const name of Object.keys(ACTIONS)) {
      const r = await act(caller, name, "missing-store");
      ok(![401, 403].includes(r.status) && r.status >= 400, `${caller} ${name}: ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
});

// --- suspend and resume -------------------------------------------------------------
await t("suspend: a reason of at least 5 characters is required; nothing changes without one", async () => {
  for (const reason of [undefined, "", "   ", "abcd"]) {
    const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "suspended", reason } });
    eq(r.status, 400, JSON.stringify(reason));
  }
  eq(String((await row(a.id)).status), "active");
});

await t("suspend: the storefront host fails closed on this server at once (patchTenant drops the 30-second cache), the audit row has the operator and reason, and the other store is untouched", async () => {
  const host = a.tenant.domains[0];
  eq((await C.resolveHost(host)).outcome, "resolved", "warm cache: resolved");
  const bBefore = JSON.stringify(await row(b.id));
  const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "suspended", reason: "Chargebacks under review" } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.tenant.status, "suspended");
  eq(r.body.mail, "not_configured", "mail");
  eq((await C.resolveHost(host)).outcome, "suspended", "host after suspend");
  // a shopper's checkout gets the closed answer, not an order
  const checkout = await import(pathToFileURL(join(ROOT, "app/api/checkout/route.js")).href);
  const co = await checkout.POST(new NextRequest(`http://${host}/api/checkout`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json" }, body: JSON.stringify({ cartId: "cart_x", method: "cod" }) }), {});
  eq([co.status, (await co.json()).code], [503, "TENANT_SUSPENDED"], "checkout on a suspended store");
  const au = await lastAudit(a.id, "tenant.status");
  eq([au.actor, au.actor_kind], [operatorId, "operator"], "actor");
  eq(JSON.parse(au.diff), { status: "suspended", reason: "Chargebacks under review" }, "diff");
  eq(JSON.stringify(await row(b.id)), bBefore, "b untouched");
  eq((await C.resolveHost(b.tenant.domains[0])).outcome, "resolved", "b still resolves");
});

await t("suspend twice: 409 and no second audit row", async () => {
  const n = (await auditRows(a.id, "tenant.status")).length;
  eq((await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "suspended", reason: "again again" } })).status, 409);
  eq((await auditRows(a.id, "tenant.status")).length, n, "rows");
});

const jobRow = async (id) => (await db().execute({ sql: "SELECT status, attempts, created_at, run_after, last_error FROM jobs WHERE id = ?", args: [id] })).rows[0];
const OLD_CREATED = "2026-01-01T00:00:00.000Z";

await t("suspended: a job waits (pending, later, a plain reason) instead of failing; each pass keeps its attempts and created_at", async () => {
  const ran = [];
  const handlers = { lifecycle_probe: async () => ran.push(1) };
  const { id } = await J.enqueueJob({ type: "lifecycle_probe", tenantId: a.id });
  await db().execute({ sql: "UPDATE jobs SET created_at = ? WHERE id = ?", args: [OLD_CREATED, id] });
  await WK.runJobById(id, { handlers });
  const first = await jobRow(id);
  eq(ran.length, 0, "handler not run");
  eq([String(first.status), Number(first.attempts), first.created_at], ["pending", 0, OLD_CREATED], "after the first pass");
  ok(first.run_after && Date.parse(first.run_after) > Date.now() + 10 * 60_000, "due later");
  ok(String(first.last_error).startsWith(J.SUSPENDED_WAIT_PREFIX), `says why: ${first.last_error}`);
  // fifteen minutes on, the queue leases it again: still waiting, nothing reset, the same "since"
  await db().execute({ sql: "UPDATE jobs SET run_after = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), id] });
  await WK.runJobById(id, { handlers });
  const second = await jobRow(id);
  eq([String(second.status), Number(second.attempts), second.created_at, second.last_error], ["pending", 0, OLD_CREATED, first.last_error], "after the second pass");
  eq(ran.length, 0, "still not run");
  globalThis.__lifecycleJob = id;
});

await t("suspended for 7 days: a waiting job dead-letters with a plain reason", async () => {
  const { id } = await J.enqueueJob({ type: "lifecycle_probe", tenantId: a.id });
  const since = new Date(Date.now() - J.SUSPENDED_MAX_MS - 60_000).toISOString();
  await db().execute({ sql: "UPDATE jobs SET last_error = ? WHERE id = ?", args: [`${J.SUSPENDED_WAIT_PREFIX}${since})`, id] });
  const ran = [];
  await WK.runJobById(id, { handlers: { lifecycle_probe: async () => ran.push(1) } });
  const row = await jobRow(id);
  eq([String(row.status), row.last_error], ["dead", J.SUSPENDED_DEAD_REASON]);
  eq(ran.length, 0, "not run");
});

await t("resume: the same reason rule; the host resolves again at once; waiting jobs are due at once and run; audit row", async () => {
  eq((await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "active", reason: "ok" } })).status, 400, "short reason");
  const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "active", reason: "Review cleared" } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq((await C.resolveHost(a.tenant.domains[0])).outcome, "resolved");
  eq(JSON.parse((await lastAudit(a.id, "tenant.status")).diff), { status: "active", reason: "Review cleared" });
  // resume made the waiting job due at once: no run_after, no waiting reason, attempts and place kept
  const waiting = await jobRow(globalThis.__lifecycleJob);
  eq([waiting.run_after, waiting.last_error, Number(waiting.attempts), waiting.created_at], [null, null, 0, OLD_CREATED], "due now");
  const ran = [];
  await WK.runJobById(globalThis.__lifecycleJob, { handlers: { lifecycle_probe: async () => ran.push(1) } });
  eq(ran.length, 1, "ran after resume");
  eq(String((await jobRow(globalThis.__lifecycleJob)).status), "done");
});

await t("mail: with mail set up the owner is emailed on suspend and resume (no reason, no secret in it); a failed send says failed and the action still happens", async () => {
  process.env.RESEND_API_KEY = "re_test_lifecycle";
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "suspended", reason: "Secret internal reason" } });
    eq(r.body.mail, "sent", r.text.slice(0, 200));
    eq(sent.length, 1, "one owner");
    eq(sent[0].body.to, store.users.owner.email, "to the owner");
    ok(!JSON.stringify(sent[0].body).includes("Secret internal reason"), "no reason in the mail");
    const pm = (await db().execute({ sql: "SELECT kind, status, ref FROM platform_mail WHERE recipient = ? ORDER BY rowid DESC LIMIT 1", args: [store.users.owner.email] })).rows[0];
    eq([pm.kind, pm.status, pm.ref], ["store_suspended", "sent", a.id], "platform_mail");
    globalThis.fetch = async () => new Response("{}", { status: 500 });
    const r2 = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { status: "active", reason: "Back to normal" } });
    eq([r2.status, r2.body.mail, r2.body.tenant.status], [200, "failed", "active"], "failed send");
  } finally {
    globalThis.fetch = blockedFetch;
    process.env.RESEND_API_KEY = "";
  }
});

// --- maintenance ---------------------------------------------------------------------
await t("maintenance: on with a message, then off; tenant.maintenance audit rows; status stays active", async () => {
  const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { maintenance: { enabled: true, message: "Back at 6pm" } } });
  eq(r.status, 200, r.text.slice(0, 200));
  const t1 = await C.getTenant(a.id, { fresh: true });
  eq([t1.config.maintenance.enabled, t1.config.maintenance.message, t1.status], [true, "Back at 6pm", "active"]);
  eq(JSON.parse((await lastAudit(a.id, "tenant.maintenance")).diff), { enabled: true });
  eq((await lastAudit(a.id, "tenant.maintenance")).actor, operatorId, "actor");
  await call("operator", "tenants/[id]", { params: { id: a.id }, body: { maintenance: { enabled: false } } });
  eq((await C.getTenant(a.id, { fresh: true })).config.maintenance, null, "off");
  eq(JSON.parse((await lastAudit(a.id, "tenant.maintenance")).diff), { enabled: false });
});

// --- rotation -----------------------------------------------------------------------
await t("rotate: an old order link fails and a new one works; the merchant's keys are kept; the audit row names the key and holds no value", async () => {
  const tenantBefore = await C.getTenant(a.id, { fresh: true });
  const oldToken = await withTenant(tenantBefore, () => O.orderStatusToken("ord_lifecycle"));
  ok(await withTenant(tenantBefore, () => O.verifyOrderStatusToken("ord_lifecycle", oldToken)), "old link works before");
  // a signed-in shopper, and a sign-in code sent but not yet used (lib/customers.js signs both with this key)
  const inBefore = (fn) => withTenant(tenantBefore, fn);
  const latestCode = async () => /(\d{6})/.exec((await inBefore(() => tdb.selectFrom("notifications").select(["subject"]).where("type", "=", "customer_otp").orderBy("created_at", "desc").executeTakeFirst())).subject)[1];
  await inBefore(() => K.requestOtp("shopper@lifecycle.test"));
  const session = (await inBefore(async () => K.verifyOtp("shopper@lifecycle.test", await latestCode()))).token;
  ok(await inBefore(() => K.customerFromToken(session)), "the shopper session works before");
  await inBefore(() => K.requestOtp("pending@lifecycle.test"));
  const pendingCode = await latestCode();
  const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { rotate: { keys: ["order_link_secret"] } } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.rotated, ["order_link_secret"]);
  ok(!("consolePassword" in r.body), "no password");
  eq(r.headers.get("cache-control"), "no-store", "no-store");
  const sec = await secretsOf(a.id);
  ok(sec.order_link_secret && sec.order_link_secret !== OLD_LINK_KEY, "new key");
  ok(!r.text.includes(sec.order_link_secret), "the new key is not in the answer");
  eq(sec.razorpay_key_secret, SECRET_CANARY, "merchant key kept");
  const after = await C.getTenant(a.id, { fresh: true });
  eq(await withTenant(after, () => O.verifyOrderStatusToken("ord_lifecycle", oldToken)), false, "old link fails");
  eq(await withTenant(after, () => K.customerFromToken(session)), null, "the shopper session signed before is refused (signed out)");
  let codeRefused = false;
  await withTenant(after, () => K.verifyOtp("pending@lifecycle.test", pendingCode)).catch(() => (codeRefused = true));
  ok(codeRefused, "a sign-in code sent before is refused");
  // the dialog says so (components/platform/stores/lifecycleWords.js)
  const said = W.ROTATE_EFFECTS.order_link_secret.join(" ");
  for (const w of ["signed out", "sign-in codes", "Order links", "preview links", "30 seconds"]) ok(said.includes(w), `the dialog says: ${w}`);
  const newToken = await withTenant(after, () => O.orderStatusToken("ord_lifecycle"));
  ok(await withTenant(after, () => O.verifyOrderStatusToken("ord_lifecycle", newToken)), "new link works");
  const au = await lastAudit(a.id, "tenant.secrets_rotate");
  eq([au.actor, au.actor_kind], [operatorId, "operator"]);
  eq(JSON.parse(au.diff), { rotated: ["order_link_secret"] });
  for (const v of [sec.order_link_secret, OLD_LINK_KEY, SECRET_CANARY]) ok(!String(au.diff).includes(v), "no value in the row");
});

await t("rotate: nothing by default, unknown and merchant keys refused, the console password refused while the store has members", async () => {
  const before = JSON.stringify(await row(a.id));
  for (const rotate of [{}, { keys: [] }, { keys: ["razorpay_key_secret"] }, { keys: ["shopify_admin_token"] }, { keys: ["order_link_secret", "meta_capi_token"] }, null]) {
    eq((await call("operator", "tenants/[id]", { params: { id: a.id }, body: { rotate } })).status, 400, JSON.stringify(rotate));
  }
  const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { rotate: { keys: ["admin_password"] } } });
  eq(r.status, 409, r.text.slice(0, 200));
  eq(JSON.stringify(await row(a.id)), before, "unchanged");
});

await t("rotate: a store with no members gets a new console password once in the answer; it works for the console, the old does not; never in audit or slog", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...x) => logs.push(x.join(" "));
  let r;
  try {
    r = await call("operator", "tenants/[id]", { params: { id: lone.id }, body: { rotate: { keys: ["admin_password", "order_link_secret"] } } });
  } finally {
    console.log = orig;
  }
  eq(r.status, 200, r.text.slice(0, 200));
  const pw = r.body.consolePassword;
  ok(typeof pw === "string" && pw.length >= 12, "a password");
  eq((await secretsOf(lone.id)).admin_password, pw, "stored");
  const au = await lastAudit(lone.id, "tenant.secrets_rotate");
  eq(JSON.parse(au.diff), { rotated: ["admin_password", "order_link_secret"] });
  ok(!String(au.diff).includes(pw), "not in audit");
  ok(!logs.join("\n").includes(pw), "not logged");
  const A = await import("../lib/admin-auth.js");
  const t2 = await C.getTenant(lone.id, { fresh: true });
  const token = await withTenant(t2, () => A.adminSessionToken());
  eq(token, await A.adminSessionTokenFor(lone.id, pw), "the console token follows the new password");
});

// --- the other actions ----------------------------------------------------------------
await t("edit details: a field error names the field; a save audits tenant.update with the operator and no client secret value", async () => {
  const bad = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { update: { support_email: "nope" } } });
  eq([bad.status, bad.body.field], [400, "support_email"]);
  const clash = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { update: { domains: [b.tenant.domains[0]] } } });
  eq([clash.status, clash.body.field], [400, "domains"]);
  const r = await call("operator", "tenants/[id]", { params: { id: a.id }, body: { update: { name: "Lifecycle A Renamed", client_secret: "client-secret-canary-lifecycle" } } });
  eq(r.status, 200, r.text.slice(0, 200));
  const au = await lastAudit(a.id, "tenant.update");
  eq([au.actor, JSON.parse(au.diff)], [operatorId, { changed: ["name", "client_secret"] }]);
  ok(!r.text.includes("client-secret-canary-lifecycle") && !String(au.diff).includes("client-secret-canary-lifecycle"), "no secret value");
});

await t("sync: a suspended store refuses (409); export mints an expiring link and audits tenant.export", async () => {
  await C.patchTenant(lone.id, { status: "suspended" });
  eq((await call("operator", "tenants/[id]", { method: "POST", params: { id: lone.id } })).status, 409, "sync on suspended");
  await C.patchTenant(lone.id, { status: "active" });
  const r = await call("operator", "tenants/[id]/export", { method: "POST", params: { id: a.id } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.expires_in, "1 hour");
  ok(r.body.url.startsWith(`/api/platform/tenants/${a.id}/export?token=x.`), r.body.url);
  eq((await lastAudit(a.id, "tenant.export")).actor, operatorId, "actor");
});

await t("an unknown store: export and offboard answer 404 exactly (offboard before the typed-id check)", async () => {
  eq((await call("operator", "tenants/[id]/export", { method: "POST", params: { id: "missing-store" } })).status, 404, "export");
  for (const confirm of ["missing-store", "wrong"]) eq((await call("operator", "tenants/[id]/offboard", { method: "POST", params: { id: "missing-store" }, body: { confirm } })).status, 404, `offboard (${confirm})`);
});

await t("sync now: 202 with progress and a tenant.sync audit row with the operator", async () => {
  // credentials to start with (the first slice, which would call Shopify, runs in after() and is dropped)
  await C.patchTenant(a.id, { config: { shopify_store_domain: "lifecycle-a.myshopify.com" }, secrets: { shopify_admin_token: "shpat_lifecycle_fake_token" } });
  const r = await call("operator", "tenants/[id]", { method: "POST", params: { id: a.id } });
  eq(r.status, 202, r.text.slice(0, 300));
  ok(r.body.runId && typeof r.body.products === "number", "progress");
  const au = await lastAudit(a.id, "tenant.sync");
  eq([au.actor, au.actor_kind, JSON.parse(au.diff).run], [operatorId, "operator", r.body.runId]);
  (globalThis.__afterQueue || []).length = 0; // the first slice is not run here (it needs Shopify)
});

await t("offboard: the store id typed back is required; it suspends, rotates both keys and audits tenant.offboard with the operator; b untouched", async () => {
  const bBefore = JSON.stringify(await row(b.id));
  eq((await call("operator", "tenants/[id]/offboard", { method: "POST", params: { id: lone.id }, body: { confirm: "wrong" } })).status, 400);
  const before = await secretsOf(lone.id);
  const r = await call("operator", "tenants/[id]/offboard", { method: "POST", params: { id: lone.id }, body: { confirm: lone.id } });
  eq(r.status, 200, r.text.slice(0, 200));
  const after = await C.getTenant(lone.id, { fresh: true });
  eq(after.status, "suspended");
  ok(after.secrets.order_link_secret !== before.order_link_secret && after.secrets.admin_password !== before.admin_password, "both rotated");
  const au = await lastAudit(lone.id, "tenant.offboard");
  eq([au.actor, au.actor_kind], [operatorId, "operator"]);
  eq(JSON.stringify(await row(b.id)), bBefore, "b untouched");
});

await t("every action's audit row carries the real operator id, and no row holds a secret value", async () => {
  const rows = (await db().execute({ sql: "SELECT action, actor, diff FROM audit_log WHERE tenant_id IN (?, ?) AND action LIKE 'tenant.%'", args: [a.id, lone.id] })).rows;
  const actions = new Set(rows.map((r) => r.action));
  for (const x of ["tenant.status", "tenant.maintenance", "tenant.secrets_rotate", "tenant.update", "tenant.sync", "tenant.export", "tenant.offboard"]) ok(actions.has(x), x);
  for (const r of rows) eq(r.actor, operatorId, r.action);
  const values = Object.values({ ...(await secretsOf(a.id)), ...(await secretsOf(lone.id)) }).filter((v) => typeof v === "string" && v.length >= 8);
  for (const r of rows) for (const v of values) ok(!String(r.diff).includes(v), `${r.action} holds a value`);
});

// --- the store page ---------------------------------------------------------------------
await t("store page: the lifecycle card shows the real status, maintenance, the rotatable keys and merchant key names, never a value", async () => {
  await C.patchTenant(a.id, { config: { maintenance: { enabled: true, message: "Stocktake today" } } });
  const L = await LC.lifecycleView(a.id);
  eq([L.status, L.maintenance.enabled, L.maintenance.message, L.hasMembers], ["active", true, "Stocktake today", true]);
  eq(L.rotatable.map((r) => [r.key, r.present]), [["order_link_secret", true], ["admin_password", true]]);
  eq(L.merchantKeys.find((k) => k.name === "Razorpay").present, true, "Razorpay present");
  const text = JSON.stringify(L);
  for (const v of Object.values(await secretsOf(a.id))) ok(typeof v !== "string" || !text.includes(v), "no value");
  const { makePageHarness } = await import("./support/page-harness.js");
  const P = await makePageHarness({ tenant: async () => a.tenant });
  const page = await P.run("app/(console)/platform/stores/[id]/page.js", { cookies: JARS.operator, params: { id: a.id } });
  ok(!page.error, String(page.error?.stack || page.error).slice(0, 400));
  // the harness records the page's props (no render): StoreDetail gets the card's state
  const lc = page.props.map((p) => p.props?.detail?.lifecycle).find(Boolean);
  ok(lc && lc.status === "active" && lc.maintenance.enabled, `lifecycle handed to StoreDetail: ${page.props.map((p) => p.component).join(", ")}`);
  ok(page.text.includes("Stocktake today"), "maintenance message");
  for (const v of Object.values(await secretsOf(a.id))) ok(typeof v !== "string" || !page.text.includes(v), "no secret value on the page");
  const signedOut = await P.run("app/(console)/platform/stores/[id]/page.js", { cookies: {}, params: { id: a.id } });
  ok(signedOut.redirect && !signedOut.props.some((p) => p.props?.detail), "signed out: redirected, no store read");
});

await t("static: the new files import nothing from components/console and mark no data-read-control", async () => {
  for (const f of ["LifecycleCard.js", "RotateSecretsDialog.js", "EditStoreDialog.js", "OffboardDialog.js", "lifecycleWords.js"]) {
    const src = await read(`components/platform/stores/${f}`);
    ok(!/from ["']@\/components\/console\//.test(src), f);
    ok(!src.includes("data-read-control"), `${f}: no read-control mark`);
  }
  ok((await read("components/platform/stores/StoreDetail.js")).includes("{/* line 5: support access */}"), "line 5 anchor kept");
});

await t("no network: nothing reached fetch() outside the mail test", () => {
  eq(network, [], "fetch calls:");
});

await lone.cleanup();
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
