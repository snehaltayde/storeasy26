// Support access across hosts (Phase 3 line 5, docs/plans/phase-3.md "Line 5").
//   pnpm test:support-access
// The operator side (/api/platform/support: grant, the store card's view, every
// open grant, the entry token), the store side (/api/admin/support-entry, the
// __Host-support session as requireAdmin sees it, /api/admin/support-access, logout)
// and the rules between them: the token is single-use, 60 seconds, bound to the
// store and the grant, never for the setup password and never in an audit row;
// the session is read-only, bound to its host's store, and ends the moment its
// grant is closed (by an operator or the store's owner) or expires, or its user
// stops being an operator. test:permissions covers every admin route as the
// operator-support-entry caller and the token-misuse cases; test:support-reads
// covers what that caller reads. Outside services are blanked and fetch() is
// blocked; every database is a throwaway file: database.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-supacc-default.db";
process.env.PLATFORM_SECRET = "test-support-access-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-supacc"; // after the blanking: the bootstrap caller needs it
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
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

const store = await H.makeRoleStore({ name: "supacc" });
const { a, b, users, call } = store;
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const SP = await import("../lib/platform/support.js");
const AA = await import("../lib/platform/admin-auth.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = () => C.platformDb();
const OPERATOR_HOST = "localhost:3000";
const operatorId = users.operator.id;
const OP = { kind: "operator", id: operatorId };
const hostA = a.tenant.domains[0];
const hostB = b.tenant.domains[0];

// --- the operator API, as the operator console calls it ------------------------------
const JARS = {
  operator: { _platform: (await S.createSession({ userId: operatorId, kind: "operator", ttlMs: 10 * 60_000 })).token },
  bootstrap: { _platform: await AA.platformSessionToken() },
  "signed-out": {},
};
async function withoutOperators(fn) {
  await db().execute({ sql: "UPDATE users SET is_operator = 0 WHERE id = ?", args: [operatorId] });
  try {
    return await fn();
  } finally {
    await db().execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorId] });
  }
}
async function platform(caller, method, { body, query } = {}) {
  const route = await import(pathToFileURL(join(ROOT, "app/api/platform/support/route.js")).href);
  const headers = { host: OPERATOR_HOST };
  if (method !== "GET") headers.origin = `http://${OPERATOR_HOST}`;
  const jar = JARS[caller];
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new NextRequest(`http://${OPERATOR_HOST}/api/platform/support${query ? `?${query}` : ""}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const run = () => route[method](request, { params: Promise.resolve({}) });
  const res = caller === "bootstrap" ? await withoutOperators(run) : await run();
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

// --- the store side ----------------------------------------------------------------
const enter = (token, host) => call("signed-out", "support-entry", "POST", { form: { token }, host, origin: `http://${OPERATOR_HOST}` });
const supportCookie = (res) => res.setCookie.find((c) => c.startsWith("__Host-support="));
const cookieValue = (c) => c.split(";")[0].slice("__Host-support=".length);
const asSupport = (token, path, method, opts = {}) => call("signed-out", path, method, { ...opts, cookies: { "__Host-support": token } });
// operator: enter store B through the API and the entry route, → the __Host-support value
async function enterB() {
  const minted = await platform("operator", "POST", { body: { action: "enter", tenant: b.id } });
  eq(minted.status, 200, `mint ${minted.text.slice(0, 160)}`);
  const res = await enter(minted.body.token, hostB);
  eq(res.status, 303, `entry ${res.text.slice(0, 160)}`);
  return { token: minted.body.token, session: cookieValue(supportCookie(res)) };
}

await t("setup: outside services blank, file: databases, the harness operator has a name", () => {
  for (const k of H.OUTSIDE_SERVICE_ENV.filter((x) => x !== "PLATFORM_ADMIN_PASSWORD")) eq(process.env[k], "", k);
  for (const u of [process.env.PLATFORM_DB_URL, a.tenant.dbUrl, b.tenant.dbUrl]) ok(/^file:/.test(u), u);
  eq(users.operator.name, "Opname supacc", "operator name");
});

await t("migration 0017: sessions.grant_id and its index on a fresh control plane", async () => {
  const cols = (await db().execute("PRAGMA table_info(sessions)")).rows.map((r) => r.name);
  ok(cols.includes("grant_id"), `columns: ${cols.join(",")}`);
  const idx = (await db().execute("PRAGMA index_list(sessions)")).rows.map((r) => r.name);
  ok(idx.includes("idx_sessions_grant"), `indexes: ${idx.join(",")}`);
  const src = await readFile(join(ROOT, "migrations/platform/0017_support_sessions.sql"), "utf8");
  ok(!/\b(DROP|DELETE|UPDATE)\b/i.test(src.replace(/--.*$/gm, "")), "nothing destructive");
});

await t("grant: hours must be 1, 4, 8, 24 or 72 and the reason 5+ characters; signed out 401", async () => {
  eq((await platform("operator", "POST", { body: { action: "grant", tenant: b.id, reason: "a fine reason", hours: 2 } })).status, 400, "2 hours");
  eq((await platform("operator", "POST", { body: { action: "grant", tenant: b.id, reason: "shrt", hours: 1 } })).status, 400, "short reason");
  eq((await platform("signed-out", "POST", { body: { action: "grant", tenant: b.id, reason: "a fine reason", hours: 1 } })).status, 401, "signed out");
  eq(await SP.activeSupportGrant(b.id), null, "nothing opened on B");
});

await t("enter before any grant on B: 409 in words; a missing store 404; signed out 401", async () => {
  const none = await platform("operator", "POST", { body: { action: "enter", tenant: b.id } });
  eq(none.status, 409, "no grant");
  ok(/isn't open/.test(none.body?.error), none.body?.error);
  eq((await platform("operator", "POST", { body: { action: "enter", tenant: "missing-store" } })).status, 404, "missing");
  eq((await platform("signed-out", "POST", { body: { action: "enter", tenant: b.id } })).status, 401, "signed out");
});

// store B gets an admin, a staff and a support member: only owners and admins are emailed
const I = await import("../lib/platform/identity.js");
const bMembers = {};
for (const role of ["admin", "staff", "support"]) {
  bMembers[role] = await I.createUser({ email: `${role}-b@supacc-b.test`, password: `${role}-b-pass-supacc` });
  await I.addMembership(bMembers[role].id, b.id, role);
}
// the mail mock prints "[mail:MOCK — not sent] to=<address> …": the addresses it was handed
async function mailedTo(fn) {
  const seen = [];
  const log = console.log;
  console.log = (...args) => {
    const m = String(args[0] ?? "").match(/^\[mail:MOCK[^\]]*\] to=(\S+)/);
    if (m) seen.push(m[1]);
    else log(...args);
  };
  try {
    return { result: await fn(), seen };
  } finally {
    console.log = log;
  }
}

let grantB;
await t("grant on B: 200, only the owner and the admin are emailed (never staff or support; the mock: mail off), the store view shows it open with the operator's name, view=open lists it", async () => {
  const { result: res, seen } = await mailedTo(() => platform("operator", "POST", { body: { action: "grant", tenant: b.id, reason: "checking the theme with the founder", hours: 1 } }));
  eq(res.status, 200, res.text.slice(0, 200));
  grantB = res.body.id;
  eq(res.body.mail?.configured, false, "mail off");
  eq(res.body.mail?.sent, 2, "the owner and the admin mailed by the mock");
  eq(seen.sort().join(","), [users["owner-b"].email, bMembers.admin.email].sort().join(","), "the addresses");
  const view = await platform("operator", "GET", { query: `view=store&tenant=${b.id}` });
  eq(view.status, 200);
  eq(view.body.open?.id, grantB, "open grant");
  eq(view.body.open?.operatorName, "Opname supacc", "operator name");
  eq(view.body.mail, false, "the card is told mail is off");
  eq(view.headers.get("cache-control"), "no-store");
  const open = await platform("operator", "GET", { query: "view=open" });
  const row = open.body.grants.find((g) => g.id === grantB);
  ok(row && row.tenantId === b.id && row.storeName === b.tenant.name && row.operatorName === "Opname supacc", JSON.stringify(row));
  ok(open.body.grants.some((g) => g.tenantId === a.id), "store A's grant too");
});

await t("enter on a real store with an open grant: a merchant _admin, a __Host-support session and a forged _platform get 401 and no token", async () => {
  const forged = (await S.createSession({ userId: users["owner-b"].id, kind: "merchant", ttlMs: 60_000 })).token;
  const minted = (await platform("operator", "POST", { body: { action: "enter", tenant: b.id } })).body.token;
  const sup = cookieValue(supportCookie(await enter(minted, hostB)));
  const jars = {
    "merchant _admin": { _admin: store.cookies["owner-b"]._admin },
    "__Host-support session": { "__Host-support": sup },
    "_admin's token in _platform": { _platform: forged },
    "a made-up _platform": { _platform: "f".repeat(64) },
    "the support session in _platform": { _platform: sup },
  };
  const bad = [];
  for (const [label, jar] of Object.entries(jars)) {
    JARS.probe = jar;
    const res = await platform("probe", "POST", { body: { action: "enter", tenant: b.id } });
    if (res.status !== 401 || res.body?.token) bad.push(`${label}: ${res.status}`);
  }
  delete JARS.probe;
  eq(bad.join("\n"), "", "");
});

await t("two enters give independent tokens: using the first spends only the first", async () => {
  const one = (await platform("operator", "POST", { body: { action: "enter", tenant: b.id } })).body.token;
  const two = (await platform("operator", "POST", { body: { action: "enter", tenant: b.id } })).body.token;
  ok(one && two && one !== two, "two tokens");
  eq((await enter(one, hostB)).status, 303, "the first");
  eq((await enter(one, hostB)).status, 400, "the first, again");
  eq((await enter(two, hostB)).status, 303, "the second still works");
});

await t("the session cookie's Max-Age stays within the grant's end and the 12-hour cap", async () => {
  const maxAge = (res) => Number(/Max-Age=(\d+)/i.exec(supportCookie(res) || "")?.[1]);
  const grant = await SP.activeSupportGrant(b.id); // 1 hour
  const res = await enter((await platform("operator", "POST", { body: { action: "enter", tenant: b.id } })).body.token, hostB);
  const left = Math.floor((Date.parse(grant.expires_at) - Date.now()) / 1000);
  ok(maxAge(res) > 0 && maxAge(res) <= left + 1, `1-hour grant: Max-Age ${maxAge(res)} ≤ ${left}`);
  // a 72-hour grant on store A: the operator's 12 hours win
  const g72 = await SP.createSupportGrant({ tenantId: a.id, reason: "a long grant probe", hours: 72, operator: OP });
  try {
    const t72 = await SP.mintSupportEntry({ tenantId: a.id, operator: OP, consoleOrigin: `http://${OPERATOR_HOST}` });
    const r72 = await enter(t72.token, hostA);
    eq(r72.status, 303, "72-hour entry");
    ok(maxAge(r72) <= 12 * 3600 && maxAge(r72) > 12 * 3600 - 60, `72-hour grant: Max-Age ${maxAge(r72)} is the 12-hour cap`);
  } finally {
    await SP.revokeSupportGrant(g72.id, { operator: OP });
  }
  ok(await SP.activeSupportGrant(a.id), "store A keeps the harness grant");
});

await t("enter as the setup password (bootstrap, before any operator): 403 in words, no token", async () => {
  const res = await platform("bootstrap", "POST", { body: { action: "enter", tenant: b.id } });
  eq(res.status, 403, res.text.slice(0, 160));
  ok(/setup password/.test(res.body?.error), res.body?.error);
  ok(!res.body?.token, "no token");
});

let session;
await t("enter as the operator: a 64-hex token for 60 s, the store's own entry URL, no-store; the token is in no audit row", async () => {
  const since = new Date().toISOString();
  const minted = await platform("operator", "POST", { body: { action: "enter", tenant: b.id } });
  eq(minted.status, 200);
  ok(/^[0-9a-f]{64}$/.test(minted.body.token), "token shape");
  const { storeOrigin } = await import("../lib/platform/onboarding-ops.js");
  eq(minted.body.entryUrl, `${storeOrigin(b.tenant, `http://${OPERATOR_HOST}`)}/api/admin/support-entry`, "entry URL (the store's host, the console's port)");
  ok(new URL(minted.body.entryUrl).hostname === hostB.split(":")[0], "the store's own host");
  const ttl = Date.parse(minted.body.expiresAt) - Date.now();
  ok(ttl > 50_000 && ttl <= 60_000, `60 s (${ttl})`);
  eq(minted.headers.get("cache-control"), "no-store");
  const res = await enter(minted.body.token, hostB);
  eq(res.status, 303);
  session = cookieValue(supportCookie(res));
  ok(/^[0-9a-f]{64}$/.test(session), "a session token in the cookie");
  const all = JSON.stringify((await db().execute({ sql: "SELECT * FROM audit_log WHERE at >= ?", args: [since] })).rows);
  for (const v of [minted.body.token, session]) ok(!all.includes(v), "a token in audit_log");
  const actions = (await db().execute({ sql: "SELECT action, actor, resource FROM audit_log WHERE at >= ? ORDER BY at", args: [since] })).rows;
  for (const action of ["support.entry_issued", "support.entered"]) {
    const r = actions.find((x) => x.action === action);
    ok(r && r.actor === operatorId && r.resource === `grant:${grantB}`, `${action}: ${JSON.stringify(r)}`);
  }
  const row = (await db().execute({ sql: "SELECT kind, grant_id, user_id, revoked_at FROM sessions WHERE token_hash = ?", args: [await S.sha256Hex(minted.body.token)] })).rows[0];
  ok(row.kind === "support_entry" && row.grant_id === grantB && row.revoked_at, `the entry row is spent: ${JSON.stringify(row)}`);
});

await t("the __Host-support session on B: reads as support (orders 200), writes refused read-only (403), owner-only reads 403, the same cookie on A 401", async () => {
  eq((await asSupport(session, "orders", "GET", { host: hostB })).status, 200, "orders");
  const w = await asSupport(session, "offers", "POST", { host: hostB, body: { offer: {} } });
  eq(w.status, 403, "write");
  ok(/read-only/.test(w.body?.error), w.body?.error);
  eq((await asSupport(session, "support-access", "GET", { host: hostB })).status, 403, "audit.read");
  eq((await asSupport(session, "support-access", "POST", { host: hostB, body: { action: "end" } })).status, 403, "end");
  eq((await asSupport(session, "orders", "GET", { host: hostA })).status, 401, "store A");
  ok(await SP.activeSupportGrant(b.id), "the grant is still open");
});

await t("verifySession: a support session is never an operator or merchant session, and an operator session never a support one", async () => {
  eq(await S.verifySession(session, "operator"), null, "as operator");
  eq(await S.verifySession(session, "merchant"), null, "as merchant");
  eq(await S.verifySession(JARS.operator._platform, "support"), null, "operator as support");
  eq((await S.verifySession(session, "support"))?.grantId, grantB, "as support");
});

await t("the team's banner and card name the operator, never the id or email", async () => {
  const n = await withTenant(b.tenant, async () => (await import("../lib/admin/notices.js")).readNotices({ member: { kind: "merchant", role: "owner" } }));
  eq(n.grant?.operatorName, "Opname supacc");
  const res = await call("owner-b", "support-access", "GET", { host: hostB });
  eq(res.status, 200);
  eq(res.body.open?.operatorName, "Opname supacc");
  eq(res.body.history[0]?.state, "open");
  for (const v of [operatorId, users.operator.email]) ok(!res.text.includes(v) && !JSON.stringify(n).includes(v), `no ${v}`);
});

const M = await import("../lib/maintenance.js");
const closedB = () => ({ ...b.tenant, config: { ...(b.tenant.config || {}), maintenance: { enabled: true, message: "Back soon" } } });
const curtainFor = (jar) => withTenant(closedB(), () => M.maintenanceCurtain({ get: (n) => (jar[n] ? { value: jar[n] } : undefined) }));
await t("maintenance: a support session lifts a closed store's curtain while its grant is open, and never gets an _mx pass", async () => {
  eq(await curtainFor({ "__Host-support": session }), null, "the curtain is lifted");
  ok(await curtainFor({}), "a visitor sees the curtain");
  eq(await withTenant(closedB(), () => M.issueMaintenancePass({ get: (n) => (n === "__Host-support" ? { value: session } : undefined) })), null, "no _mx pass for a support session");
  const res = await asSupport(session, "maintenance-pass", "GET", { host: hostB });
  ok(!res.setCookie.some((c) => /^_mx=[^;]+/.test(c)), "the maintenance-pass route sets no _mx");
});

await t("the owner ends access: 200, the support session is refused at once (401) and revoked, the audit row names the owner, history says closed by the team", async () => {
  const res = await call("owner-b", "support-access", "POST", { host: hostB, body: { action: "end" } });
  eq(res.status, 200, res.text.slice(0, 160));
  eq(res.body.open, null, "nothing open");
  eq((await asSupport(session, "orders", "GET", { host: hostB })).status, 401, "next request");
  eq(await S.verifySession(session, "support"), null, "revoked");
  const row = (await db().execute({ sql: "SELECT actor, actor_kind FROM audit_log WHERE action = 'support.grant_revoked' AND resource = ?", args: [`grant:${grantB}`] })).rows[0];
  eq(`${row?.actor}/${row?.actor_kind}`, `${users["owner-b"].id}/merchant`, "audit actor");
  const h = res.body.history.find((x) => x.id === grantB);
  ok(h.state === "closed" && h.endedBy === "Your team" && h.endedAt, JSON.stringify(h));
  eq((await call("owner-b", "support-access", "POST", { host: hostB, body: { action: "end" } })).status, 409, "again");
  ok(await curtainFor({ "__Host-support": session }), "the closed storefront is refused at once");
  ok(await SP.activeSupportGrant(a.id), "store A's grant untouched");
});

await t("the team's audit view names the operator on support rows, never the raw id", async () => {
  const res = await call("owner-b", "audit", "GET", { host: hostB });
  eq(res.status, 200);
  const rows = res.body.entries.filter((e) => e.action.startsWith("support.") && e.actor_kind === "operator");
  ok(rows.length >= 3, `support rows: ${rows.length}`);
  ok(rows.every((e) => e.who === "Opname supacc"), JSON.stringify(rows.map((e) => e.who)));
  const withFacets = await call("owner-b", "audit", "GET", { host: hostB, query: "facets=1" });
  eq(withFacets.status, 200);
  ok(!withFacets.text.includes(operatorId), "the operator's id is in no entry and no filter choice");
  ok(withFacets.body.entries.filter((e) => e.actor_kind === "operator").every((e) => e.actor === null), "operator rows carry no actor id");
});

await t("expiry ends the session at once: the grant's end passes, the next request is 401", async () => {
  await SP.createSupportGrant({ tenantId: b.id, reason: "expiry probe grant", hours: 1, operator: OP });
  const { session: s } = await enterB();
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 200, "before");
  await db().execute({ sql: "UPDATE support_grants SET expires_at = ? WHERE tenant_id = ? AND revoked_at IS NULL", args: [new Date(Date.now() - 1000).toISOString(), b.id] });
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 401, "after");
  const h = await SP.supportHistory(b.id);
  ok(h[0].state === "expired" && h[0].endedBy === null, JSON.stringify(h[0]));
});

await t("an operator closing the grant revokes its sessions; an operator who stops being one is refused", async () => {
  const g = await SP.createSupportGrant({ tenantId: b.id, reason: "operator close probe", hours: 4, operator: OP });
  const { session: s } = await enterB();
  await db().execute({ sql: "UPDATE users SET is_operator = 0 WHERE id = ?", args: [operatorId] });
  try {
    eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 401, "not an operator");
  } finally {
    await db().execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorId] });
  }
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 200, "an operator again");
  eq((await platform("operator", "POST", { body: { action: "revoke", id: g.id } })).status, 200, "close");
  const row = (await db().execute({ sql: "SELECT revoked_at FROM sessions WHERE token_hash = ?", args: [await S.sha256Hex(s)] })).rows[0];
  ok(row?.revoked_at, "the session row is revoked");
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 401, "after close");
  const h = (await SP.supportHistory(b.id)).find((x) => x.id === g.id);
  eq(h.endedBy, "Opname supacc", "closed by the operator's name");
});

await t("logout on the store's host clears __Host-support and revokes the session", async () => {
  await SP.createSupportGrant({ tenantId: b.id, reason: "logout probe grant", hours: 1, operator: OP });
  const { session: s } = await enterB();
  const out = await call("signed-out", "logout", "POST", { host: hostB, cookies: { "__Host-support": s } });
  eq(out.status, 200);
  const c = supportCookie(out) || "";
  ok(/^__Host-support=;/.test(c) && /max-age=0/i.test(c), `clears __Host-support: ${c}`);
  eq(await S.verifySession(s, "support"), null, "revoked");
});

await t("P3-E the operator signing out of /platform ends their __Host-support session on store B (401) and their unspent entry tokens", async () => {
  const { session: s } = await enterB(); // the logout probe's grant is still open
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 200, "before");
  const unspent = (await platform("operator", "POST", { body: { action: "enter", tenant: b.id } })).body.token;
  const opToken = (await S.createSession({ userId: operatorId, kind: "operator", ttlMs: 10 * 60_000 })).token;
  const route = await import(pathToFileURL(join(ROOT, "app/api/platform/logout/route.js")).href);
  const res = await route.POST(new NextRequest(`http://${OPERATOR_HOST}/api/platform/logout`, { method: "POST", headers: { host: OPERATOR_HOST, origin: `http://${OPERATOR_HOST}`, cookie: `_platform=${opToken}` } }));
  eq(res.status, 200, "logout");
  eq(await S.verifySession(opToken, "operator"), null, "the operator session is revoked");
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 401, "the support session on B after sign-out");
  eq((await enter(unspent, hostB)).status, 400, "an unspent entry token after sign-out");
  ok(await S.verifySession(JARS.operator._platform, "operator"), "the operator's other console sessions are untouched");
});

await t("a support session for one grant is refused once another grant is the open one", async () => {
  const { session: s } = await enterB(); // the logout probe's grant is still open
  await db().execute({ sql: "UPDATE support_grants SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL", args: [new Date().toISOString(), b.id] });
  await SP.createSupportGrant({ tenantId: b.id, reason: "a newer grant", hours: 1, operator: OP });
  eq((await asSupport(s, "orders", "GET", { host: hostB })).status, 401, "old grant's session");
});

await t("history: the last 20, newest first, each with the operator's name and its end", async () => {
  for (let i = 0; i < 21; i++) await db().execute({ sql: "INSERT INTO support_grants (id, tenant_id, operator, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", args: [`sg_hist${String(i).padStart(2, "0")}`, b.id, operatorId, `old grant ${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, `2026-01-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`] });
  const h = await SP.supportHistory(b.id);
  eq(h.length, 20, "20");
  eq(h[0].state, "open", "the newest (open) first");
  ok(h.every((x) => x.operatorName === "Opname supacc"), "names");
});

await t("edge safety: lib/platform/support.js and lib/mail.js import no node: module", async () => {
  for (const f of ["lib/platform/support.js", "lib/mail.js", "lib/platform/sessions.js"]) ok(!/from\s+["']node:/.test(await readFile(join(ROOT, f), "utf8")), f);
});

await t("no network: nothing reached fetch()", () => eq(network.length, 0, network.join(", ")));

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
