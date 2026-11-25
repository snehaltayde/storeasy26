// Operator route permission suite (Phase 3 line 0, docs/plans/phase-3.md "Line 0").
//   pnpm test:platform-permissions
// Every app/api/platform route, called as every caller: a TOTP operator and
// the bootstrap token before the first operator are allowed; the bootstrap
// token after it, signed out, a merchant owner's and a merchant support
// member's _admin cookie, a merchant token put in _platform, an "operator"
// session for a non-operator user, and revoked and expired operator sessions
// all get 401. Cross-origin writes get 403 before auth. The route table is
// scripts/support/platform-routes.js; a static guard keeps it in step with the
// route files. Writes record the real operator id. Outside services are
// blanked and fetch() is blocked; every database is a throwaway file: database.
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "app/api/platform");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-platperm-default.db";
process.env.PLATFORM_SECRET = "test-platform-permissions-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
process.env.SIGNUP_STORE_DOMAIN = "stores.test"; // so POST stores reaches its form check
process.env.PLATFORM_ADMIN_PASSWORD = "bootstrap-pass-platperm"; // after the blanking: the bootstrap callers need it
const network = H.blockNetwork();

const { PLATFORM_ROUTES, EXEMPT_PLATFORM_ROUTES } = await import("./support/platform-routes.js");

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
const rowName = (r) => `${r.method} ${r.path}${r.variant ? ` (${r.variant})` : ""}`;
const started = Date.now();

// --- the guard: the filesystem and each route module's real exports -------------
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
async function walk(dir) {
  const out = [];
  for (const f of await readdir(dir)) {
    const p = join(dir, f);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
    else if (/^route\.(js|ts|mjs)$/.test(f)) out.push(p);
  }
  return out;
}
const ROUTES = new Map();
for (const f of (await walk(API)).sort()) {
  const path = relative(API, dirname(f)).split("\\").join("/");
  const mod = await import(pathToFileURL(f).href);
  ROUTES.set(path, { src: await readFile(f, "utf8"), methods: Object.keys(mod).filter((k) => HTTP_METHODS.includes(k) && typeof mod[k] === "function") });
}
const code = (src) => src.replace(/^\s*\/\/.*$/gm, "");
const count = (src, re) => (code(src).match(re) || []).length;

function guardProblems(rows, exempt, routes) {
  const problems = [];
  const all = [...rows.map((r) => ({ ...r, kind: "gated" })), ...exempt];
  for (const [path, { methods }] of routes) {
    for (const m of methods) if (!all.some((r) => r.path === path && r.method === m)) problems.push(`(a) ${m} ${path} has no table row`);
  }
  for (const r of all) {
    const route = routes.get(r.path);
    if (!route) problems.push(`(b) ${rowName(r)}: app/api/platform/${r.path}/route.js is missing`);
    else if (!route.methods.includes(r.method)) problems.push(`(b) ${rowName(r)}: the route exports no ${r.method}`);
  }
  for (const [path, { src, methods }] of routes) {
    const gatedMethods = methods.filter((m) => rows.some((r) => r.path === path && r.method === m));
    if (!gatedMethods.length) {
      if (count(src, /\brequireOperator\(/g)) problems.push(`(e) ${path}: exempt but calls requireOperator`);
      continue;
    }
    // one requireOperator( and one `instanceof Response` return per gated method
    if (count(src, /\brequireOperator\(/g) < gatedMethods.length) problems.push(`(c) ${path}: ${gatedMethods.length} gated methods but fewer requireOperator( calls`);
    if (count(src, /if \(auth instanceof Response\) return auth;/g) < gatedMethods.length) problems.push(`(c) ${path}: a requireOperator result is not checked`);
    // the old gates are gone: no route checks the cookie or the origin itself
    if (/\b(verifyPlatformToken|platformOperator|sameOrigin)\b/.test(code(src))) problems.push(`(d) ${path}: checks the cookie or origin itself instead of requireOperator`);
    if (/id: "operator"|actor: "operator"|setBy: "operator"/.test(code(src))) problems.push(`(f) ${path}: a write names the fixed actor "operator"`);
  }
  return problems;
}

await t("guard: every route file and exported method has its row; gated routes call requireOperator and check it", () => {
  const problems = guardProblems(PLATFORM_ROUTES, EXEMPT_PLATFORM_ROUTES, ROUTES);
  if (problems.length) throw new Error(problems.join("\n"));
  ok(ROUTES.size >= 21, `walked ${ROUTES.size} route files`);
  eq(new Set(PLATFORM_ROUTES.map((r) => r.path)).size, 18, "gated route files");
});

await t("guard: it catches a missing row, a stale row, an unchecked gate, an old gate and a fixed actor", () => {
  const has = (problems, tag) => problems.some((p) => p.startsWith(tag));
  const drop = (pred) => PLATFORM_ROUTES.filter((r) => !pred(r));
  ok(has(guardProblems(drop((r) => r.path === "themes"), EXEMPT_PLATFORM_ROUTES, ROUTES), "(a)"), "(a) a method without a row");
  ok(has(guardProblems([...PLATFORM_ROUTES, { path: "themes", method: "DELETE" }], EXEMPT_PLATFORM_ROUTES, ROUTES), "(b)"), "(b) a row for a missing method");
  ok(has(guardProblems([...PLATFORM_ROUTES, { path: "no-such", method: "GET" }], EXEMPT_PLATFORM_ROUTES, ROUTES), "(b)"), "(b) a row for a missing file");
  const fake = (src) => new Map([...ROUTES, ["themes", { src, methods: ["GET"] }]]);
  ok(has(guardProblems(PLATFORM_ROUTES, EXEMPT_PLATFORM_ROUTES, fake("export async function GET(request) { return Response.json({}); }")), "(c)"), "(c) a dropped gate");
  ok(has(guardProblems(PLATFORM_ROUTES, EXEMPT_PLATFORM_ROUTES, fake("const auth = await requireOperator(request);")), "(c)"), "(c) an unchecked result");
  const withGate = "const auth = await requireOperator(request);\n  if (auth instanceof Response) return auth;\n";
  ok(has(guardProblems(PLATFORM_ROUTES, EXEMPT_PLATFORM_ROUTES, fake(`${withGate}if (!sameOrigin(request)) {}`)), "(d)"), "(d) an old origin check");
  ok(has(guardProblems(PLATFORM_ROUTES, EXEMPT_PLATFORM_ROUTES, fake(`${withGate}audit({ actor: { kind: "operator", id: "operator" } })`)), "(f)"), "(f) the fixed actor");
});

// --- the store, the users and every caller's cookies ------------------------------
const store = await H.makeRoleStore({ name: "platperm" });
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const AA = await import("../lib/platform/admin-auth.js");
const RO = await import("../lib/platform/require-operator.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = () => C.platformDb();
const HOST = "localhost:3000"; // the operator console's host; operator routes are host-blind

const opSession = async (userId, ttlMs = 10 * 60_000) => (await S.createSession({ userId, kind: "operator", ttlMs })).token;
const operatorId = store.users.operator.id;
const bootstrap = await AA.platformSessionToken();
const revoked = await opSession(operatorId);
await S.revokeSessionByToken(revoked);
const expired = await opSession(operatorId, -60_000);

// P3-C: an operator's support tokens are never operator sessions. The support
// session (from the harness's cross-host entry) and a fresh, unspent support-entry
// token, each put in _platform, and the __Host-support cookie on its own.
const SP = await import("../lib/platform/support.js");
const supportSession = store.cookies["operator-support-entry"]["__Host-support"];
const supportEntry = (await SP.mintSupportEntry({ tenantId: store.a.id, operator: { kind: "operator", id: operatorId }, consoleOrigin: H.CONSOLE_ORIGIN })).token;
// kept live for the whole run, so the 401 is the kind check and not the 60-second expiry
await db().execute({ sql: "UPDATE sessions SET expires_at = ? WHERE token_hash = ?", args: [new Date(Date.now() + 60 * 60_000).toISOString(), await S.sha256Hex(supportEntry)] });
const JARS = {
  operator: { _platform: await opSession(operatorId) },
  "bootstrap-before": { _platform: bootstrap }, // called only while no operator user exists
  "bootstrap-after": { _platform: bootstrap },
  "signed-out": {},
  "merchant-owner": store.cookies.owner,
  "merchant-support": store.cookies.support,
  "merchant-token-in-platform": { _platform: store.cookies.owner._admin },
  "non-operator-session": { _platform: await opSession(store.users.owner.id) },
  "revoked-operator": { _platform: revoked },
  "expired-operator": { _platform: expired },
  "support-session-in-platform": { _platform: supportSession },
  "support-entry-in-platform": { _platform: supportEntry },
  "host-support-only": { "__Host-support": supportSession },
};
const ALLOWED = ["operator", "bootstrap-before"];
const DENIED = Object.keys(JARS).filter((c) => !ALLOWED.includes(c));

// No active operator user, for the bootstrap-before caller: the operator's flag
// is off for the call and back on after it.
async function withoutOperators(fn) {
  await db().execute({ sql: "UPDATE users SET is_operator = 0 WHERE id = ?", args: [operatorId] });
  try {
    return await fn();
  } finally {
    await db().execute({ sql: "UPDATE users SET is_operator = 1 WHERE id = ?", args: [operatorId] });
  }
}

async function call(caller, path, method, { body, params, query, origin } = {}) {
  const route = await import(pathToFileURL(join(API, path, "route.js")).href);
  const concrete = path.replace(/\[(\w+)\]/g, (_, k) => encodeURIComponent(params?.[k] ?? k));
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
  const request = new NextRequest(`http://${HOST}/api/platform/${concrete}${query ? `?${query}` : ""}`, { method, headers, body: reqBody });
  const run = () => route[method](request, { params: Promise.resolve(params ?? {}) });
  const res = caller === "bootstrap-before" ? await withoutOperators(run) : await run();
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // an empty or non-JSON body
  }
  return { status: res.status, body: json, text };
}
const callRow = (caller, r, extra = {}) => call(caller, r.path, r.method, { ...(r.probe ?? {}), ...extra });

await t("setup: outside services blank (but the bootstrap password), only file: databases, fetch blocked", async () => {
  for (const k of H.OUTSIDE_SERVICE_ENV) if (k !== "PLATFORM_ADMIN_PASSWORD") eq(process.env[k], "", k);
  for (const url of [process.env.PLATFORM_DB_URL, process.env.DATABASE_URL, store.a.tenant.dbUrl, store.b.tenant.dbUrl]) ok(/^file:\.test-platperm-/.test(url), `${url} is a .test-platperm file: database`);
  ok(await S.operatorsExist(), "an operator user exists");
});

// --- requireOperator itself --------------------------------------------------------
const fakeReq = ({ method = "GET", origin, cookie }) => ({
  method,
  headers: new Headers({ host: HOST, ...(origin ? { origin } : {}) }),
  cookies: { get: (n) => (n === "_platform" && cookie ? { value: cookie } : undefined) },
});

await t("requireOperator: a TOTP operator -> { operator: { id, kind, name, email } }", async () => {
  const r = await RO.requireOperator(fakeReq({ cookie: JARS.operator._platform }));
  ok(!(r instanceof Response), "not a response");
  eq(r.operator.id, operatorId, "id");
  eq(r.operator.kind, "operator", "kind");
  eq(r.operator.email, store.users.operator.email, "email");
  ok(r.operator.name, "a name to show");
});

await t("requireOperator: bootstrap before the first operator -> kind bootstrap; after it -> 401", async () => {
  const before = await withoutOperators(() => RO.requireOperator(fakeReq({ cookie: bootstrap })));
  eq(before.operator?.kind, "bootstrap", "before");
  eq(before.operator?.id, "bootstrap", "before id");
  const after = await RO.requireOperator(fakeReq({ cookie: bootstrap }));
  ok(after instanceof Response, "after is a response");
  eq(after.status, 401, "after");
});

await t("requireOperator: cross-origin writes 403 before auth (signed out too); a GET with an Origin header is a read", async () => {
  for (const cookie of [JARS.operator._platform, undefined]) {
    eq((await RO.requireOperator(fakeReq({ method: "POST", origin: "https://evil.test", cookie }))).status, 403, `POST ${cookie ? "operator" : "signed out"}`);
    eq((await RO.requireOperator(fakeReq({ method: "GET", origin: "https://evil.test", cookie }), { write: true })).status, 403, "write: true on a GET");
  }
  eq((await RO.requireOperator(fakeReq({ method: "PATCH", origin: "null", cookie: JARS.operator._platform }))).status, 403, "an opaque origin");
  const read = await RO.requireOperator(fakeReq({ method: "GET", origin: "https://evil.test", cookie: JARS.operator._platform }));
  ok(!(read instanceof Response), "a cross-origin GET read passes the origin check");
  const same = await RO.requireOperator(fakeReq({ method: "POST", origin: `http://${HOST}`, cookie: JARS.operator._platform }));
  ok(!(same instanceof Response), "same-origin POST");
});

await t("requireOperator: every denied caller's cookie -> 401", async () => {
  for (const c of DENIED) {
    const r = await RO.requireOperator(fakeReq({ cookie: JARS[c]._platform }));
    eq(r instanceof Response ? r.status : "allowed", 401, c);
  }
});

// --- every row as every caller ------------------------------------------------------
// Least trusted: no denied answer, on any row, holds a store id or name, a store's
// database URL, the operator's email or a probe's own ids.
const CANARIES = [store.a.id, store.b.id, store.a.tenant.name, store.b.tenant.name, store.a.tenant.dbUrl, store.b.tenant.dbUrl, store.users.operator.email].filter(Boolean).map(String);
let deniedChecked = 0;
for (const r of PLATFORM_ROUTES) {
  await t(`${rowName(r)} as each caller`, async () => {
    const wrong = [];
    for (const caller of DENIED) {
      const res = await callRow(caller, r);
      if (res.status !== 401) wrong.push(`${caller}: want 401, got ${res.status} ${res.text.slice(0, 120)}`);
      for (const c of CANARIES) if (res.text.includes(c)) wrong.push(`${caller}: the 401 holds ${c}`);
      deniedChecked++;
    }
    for (const caller of ALLOWED) {
      const res = await callRow(caller, r);
      if ([401, 403].includes(res.status) || res.status >= 500) wrong.push(`${caller}: want allowed, got ${res.status} ${res.text.slice(0, 160)}`);
    }
    if (wrong.length) throw new Error(wrong.join("\n"));
  });
}

await t("cross-origin: every write row answers the operator and a signed-out caller 403", async () => {
  const wrong = [];
  for (const r of PLATFORM_ROUTES.filter((x) => x.write)) {
    for (const caller of ["operator", "signed-out"]) {
      const res = await callRow(caller, r, { origin: "https://evil.test" });
      if (res.status !== 403) wrong.push(`${rowName(r)} as ${caller}: got ${res.status}`);
    }
  }
  if (wrong.length) throw new Error(wrong.join("\n"));
});

await t("least trusted: every row's denied answers were searched for the canaries, a db_url among them", () => {
  eq(deniedChecked, PLATFORM_ROUTES.length * DENIED.length, "denied answers checked");
  ok(CANARIES.some((c) => /^file:/.test(c)), "a store's db_url is a canary");
});

// --- writes name the real operator --------------------------------------------------
const auditRows = async (since) => (await db().execute({ sql: "SELECT actor, actor_kind, action FROM audit_log WHERE at >= ? ORDER BY at", args: [since] })).rows;

await t("writes: a flag, a support grant and an incident record the operator's id (row and audit), never \"operator\"", async () => {
  const since = new Date().toISOString();
  eq((await call("operator", "flags", "POST", { body: { flag: { key: "ff_platperm-probe", description: "probe" } } })).status, 200, "flag set");
  const flag = (await db().execute({ sql: "SELECT updated_by FROM feature_flags WHERE key = 'ff_platperm-probe'" })).rows[0];
  eq(flag?.updated_by, operatorId, "flag updated_by");
  const grant = await call("operator", "support", "POST", { body: { action: "grant", tenant: store.a.id, reason: "platperm probe", hours: 1 } });
  eq(grant.status, 200, `grant ${grant.text.slice(0, 120)}`);
  const row = (await db().execute({ sql: "SELECT operator FROM support_grants WHERE id = ?", args: [grant.body.id] })).rows[0];
  eq(row?.operator, operatorId, "grant operator");
  eq((await call("operator", "support", "POST", { body: { action: "revoke", id: grant.body.id } })).status, 200, "revoke");
  eq((await call("operator", "incidents", "POST", { body: { action: "open", title: "platperm probe" } })).status, 200, "incident");
  eq((await call("operator", "flags", "POST", { body: { remove: { key: "ff_platperm-probe" } } })).status, 200, "flag removed");
  const rows = await auditRows(since);
  for (const action of ["flags.set", "support.grant_created", "support.grant_revoked", "incident.open", "flags.delete"]) {
    const mine = rows.filter((x) => x.action === action);
    ok(mine.length, `an audit row for ${action}`);
    for (const x of mine) {
      eq(x.actor, operatorId, `${action} actor`);
      eq(x.actor_kind, "operator", `${action} kind`);
    }
  }
});

await t("writes: plan versions, job and inbox replays and the queue tick are audited with the operator", async () => {
  const J = await import("../lib/platform/jobs.js");
  const since = new Date().toISOString();
  const plan = await call("operator", "billing", "POST", { body: { action: "plan_version", plan: "platperm", spec: { name: "Platperm", price: 100 } } });
  eq(plan.status, 200, `plan_version ${plan.text.slice(0, 120)}`);
  const job = await J.enqueueJob({ type: "platperm_probe", payload: {} });
  await db().execute({ sql: "UPDATE jobs SET status = 'dead' WHERE id = ?", args: [job.id] });
  eq((await call("operator", "queues", "POST", { body: { action: "replay", kind: "job", id: job.id } })).status, 200, "job replay");
  await db().execute({ sql: "UPDATE jobs SET status = 'done' WHERE id = ?", args: [job.id] }); // so the tick leaves it alone
  const wh = await J.recordWebhook({ source: "platperm", topic: "probe", rawBody: "{}", hmacOk: true, status: "failed" });
  const whId = typeof wh === "string" ? wh : wh?.id;
  eq((await call("operator", "queues", "POST", { body: { action: "replay", kind: "inbox", id: whId } })).status, 200, "inbox replay");
  await db().execute({ sql: "UPDATE jobs SET status = 'done' WHERE status = 'pending'" });
  eq((await call("operator", "queues", "POST", { body: { action: "tick" } })).status, 200, "tick");
  const rows = await auditRows(since);
  const want = { "billing.plan_version": 1, "queue.replay": 2, "queue.tick": 1 };
  for (const [action, n] of Object.entries(want)) {
    const mine = rows.filter((x) => x.action === action);
    eq(mine.length, n, `${action} rows`);
    for (const x of mine) eq(`${x.actor}/${x.actor_kind}`, `${operatorId}/operator`, action);
  }
});

await t("writes: the bootstrap caller is audited as bootstrap (incident, flag, support grant, billing override, plan version, tick)", async () => {
  await new Promise((r) => setTimeout(r, 5)); // rows from the test before share no millisecond with these
  const since = new Date().toISOString();
  const as = (path, body) => call("bootstrap-before", path, "POST", { body });
  eq((await as("incidents", { action: "open", title: "bootstrap probe" })).status, 200, "incident");
  eq((await as("flags", { flag: { key: "ff_boot-probe" } })).status, 200, "flag set");
  eq((await as("flags", { disable: { key: "ff_boot-probe" } })).status, 200, "flag disable");
  eq((await as("flags", { remove: { key: "ff_boot-probe" } })).status, 200, "flag remove");
  const grant = await as("support", { action: "grant", tenant: store.a.id, reason: "bootstrap probe", hours: 1 });
  eq(grant.status, 200, "grant");
  eq((await as("support", { action: "revoke", id: grant.body.id })).status, 200, "revoke");
  eq((await as("billing", { action: "override", tenant: store.a.id, features: { orders_per_month: 5 }, reason: "bootstrap probe" })).status, 200, "override");
  eq((await as("billing", { action: "clear_override", tenant: store.a.id })).status, 200, "clear override");
  eq((await as("billing", { action: "plan_version", plan: "platperm-boot", spec: { name: "Boot", price: 1 } })).status, 200, "plan version");
  eq((await as("queues", { action: "tick" })).status, 200, "tick");
  const rows = await auditRows(since);
  for (const action of ["incident.open", "flags.set", "flags.emergency_disable", "flags.delete", "support.grant_created", "support.grant_revoked", "billing.override", "billing.override_cleared", "billing.plan_version", "queue.tick"]) {
    const mine = rows.filter((x) => x.action === action);
    ok(mine.length, `an audit row for ${action}`);
    for (const x of mine) eq(`${x.actor}/${x.actor_kind}`, "bootstrap/bootstrap", action);
  }
  const row = (await db().execute({ sql: "SELECT operator FROM support_grants WHERE id = ?", args: [grant.body.id] })).rows[0];
  eq(row?.operator, "bootstrap", "the grant row names bootstrap");
});

// --- the export link (exempt GET): its signature is its only auth --------------------
await t("export link: a link signed with \"dev-only\" is refused; with no PLATFORM_SECRET no link is honoured or minted", async () => {
  const { createHmac } = await import("node:crypto");
  const id = store.a.id;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const forged = `x.${exp}.${createHmac("sha256", "dev-only|export").update(`${id}|${exp}`).digest("hex").slice(0, 32)}`;
  const get = (token) => call("signed-out", "tenants/[id]/export", "GET", { params: { id }, query: `token=${token}` });
  eq((await get(forged)).status, 401, "a dev-only link with the secret set");
  const minted = await call("operator", "tenants/[id]/export", "POST", { params: { id } });
  eq(minted.status, 200, "mint");
  const good = new URL(minted.body.url, "http://x").searchParams.get("token");
  eq((await get(good)).status, 200, "a real link works");
  const saved = process.env.PLATFORM_SECRET;
  delete process.env.PLATFORM_SECRET;
  try {
    for (const [label, token] of [["dev-only", forged], ["previously minted", good]]) {
      const res = await get(token);
      eq(res.status, 503, `no secret: the ${label} link`);
      ok(!res.text.includes(store.a.tenant.dbUrl) && !/"manifest"/.test(res.text), `no secret: the ${label} link returns no export`);
    }
    eq((await call("operator", "tenants/[id]/export", "POST", { params: { id } })).status, 503, "no secret: no link is minted");
  } finally {
    process.env.PLATFORM_SECRET = saved;
  }
});

// --- Phase 3 audit fixes (docs/cms-reviews/PHASE-3-AUDIT.md) ---------------------------
const exportGet = (id, token) => call("signed-out", "tenants/[id]/export", "GET", { params: { id }, query: `token=${encodeURIComponent(token)}` });
async function mintLink(id = store.a.id) {
  const res = await call("operator", "tenants/[id]/export", "POST", { params: { id } });
  eq(res.status, 200, `mint ${res.text.slice(0, 120)}`);
  return { res, token: new URL(res.body.url, "http://x").searchParams.get("token") };
}
const downloads = async (id) => (await db().execute({ sql: "SELECT actor, actor_kind, tenant_id FROM audit_log WHERE action = 'tenant.export_downloaded' AND tenant_id = ?", args: [id] })).rows;

await t("P3-A export link: valid for 15 minutes, and the mint says so", async () => {
  const { res, token } = await mintLink();
  eq(res.body.expires_in, "15 minutes", "the words");
  const exp = Number(String(token).split(".")[1]);
  const left = exp - Date.now() / 1000;
  ok(left > 14 * 60 && left <= 15 * 60 + 1, `the token's end is 15 minutes out (${Math.round(left)} s)`);
});

await t("P3-A export link: single use: the first GET 200, the second 401 with no export", async () => {
  const { token } = await mintLink();
  eq((await exportGet(store.a.id, token)).status, 200, "first");
  const again = await exportGet(store.a.id, token);
  eq(again.status, 401, "second");
  ok(!/"manifest"/.test(again.text), "no export on the second use");
});

await t("P3-A export link: after 15 minutes it gets 401 (the token's end and the row's end)", async () => {
  const X = await import("../lib/platform/export.js");
  const old = await X.mintExportToken(store.a.id, { now: Date.now() - 15 * 60_000 - 5_000 });
  eq((await exportGet(store.a.id, old)).status, 401, "a link minted 15 minutes ago");
  const { token } = await mintLink();
  await db().execute({ sql: "UPDATE export_links SET expires_at = ? WHERE used_at IS NULL", args: [new Date(Date.now() - 1000).toISOString()] });
  eq((await exportGet(store.a.id, token)).status, 401, "a link whose row has passed its end");
});

await t("P3-A export link: one tenant.export_downloaded row per download, with the store and the minting operator", async () => {
  const before = (await downloads(store.a.id)).length;
  const { token } = await mintLink();
  eq((await exportGet(store.a.id, token)).status, 200, "download");
  eq((await exportGet(store.a.id, token)).status, 401, "reuse");
  eq((await exportGet(store.b.id, token)).status, 401, "another store");
  const rows = await downloads(store.a.id);
  eq(rows.length, before + 1, "one new row");
  const last = rows[rows.length - 1];
  eq(`${last.actor}/${last.actor_kind}/${last.tenant_id}`, `${operatorId}/operator/${store.a.id}`, "actor and store");
});

await t("P3-A export link: concurrent uses, exactly one succeeds", async () => {
  const before = (await downloads(store.a.id)).length;
  const { token } = await mintLink();
  const results = await Promise.all(Array.from({ length: 6 }, () => exportGet(store.a.id, token)));
  eq(results.map((r) => r.status).sort().join(","), "200,401,401,401,401,401", "statuses");
  eq((await downloads(store.a.id)).length, before + 1, "one audit row");
});

// a store whose database can't be opened: the driver's error names its address
const GONE_DIR = "/nonexistent-platperm-canary-dir";
const GONE_TOKEN = "platperm-canary-db-token-9f3a";
const gone = "platperm-gone";
await C.upsertTenant({ id: gone, name: "Platperm Gone", domains: ["platperm-gone.test"], dbUrl: `file:${GONE_DIR}/store.db`, dbToken: GONE_TOKEN, config: {}, secrets: {} });
const GONE_CANARIES = [GONE_DIR, GONE_TOKEN, "nonexistent-platperm-canary"];
const holdsGone = (text) => GONE_CANARIES.filter((c) => text.includes(c));

await t("P3-B export GET on an unreachable store: 422 in fixed words, no db_url", async () => {
  const { token } = await mintLink(gone);
  const res = await exportGet(gone, token);
  eq(res.status, 422, res.text.slice(0, 200));
  eq(holdsGone(res.text).join(","), "", "canaries in the answer");
  ok(/couldn't build/i.test(res.body?.error || ""), `fixed words: ${res.body?.error}`);
});

await t("P3-G privacy redact on an unreachable store: no db_url or token in the answer", async () => {
  const res = await call("operator", "privacy", "POST", { body: { action: "redact", tenant: gone, requestId: "pr_x" } });
  eq(res.status, 422, res.text.slice(0, 200));
  eq(holdsGone(res.text).join(","), "", "canaries in the answer");
});

await t("P3-G offboard on an unreachable store: no db_url or token in the answer", async () => {
  const res = await call("operator", "tenants/[id]/offboard", "POST", { params: { id: gone }, body: { confirm: gone } });
  eq(holdsGone(res.text).join(","), "", `canaries in the ${res.status} answer`);
});

await t("P3-G the queues list scrubs last_error with the store's address and token", async () => {
  const now = new Date().toISOString();
  await db().execute({ sql: "INSERT INTO jobs (id, type, tenant_id, status, last_error, created_at, updated_at) VALUES ('job_platperm_gone', 'x', ?, 'dead', ?, ?, ?)", args: [gone, `ConnectionFailed("Unable to open connection to local database ${GONE_DIR}/store.db: 14") auth ${GONE_TOKEN}`, now, now] });
  const res = await call("operator", "queues", "GET", { query: "status=dead" });
  eq(res.status, 200);
  const job = res.body.jobs.find((j) => j.id === "job_platperm_gone");
  ok(job && job.last_error, "the job is listed with its error");
  eq(holdsGone(res.text).join(","), "", "canaries in the list");
});

await t("P3-F paging: queues ?limit=-1 returns at most 200 rows; huge page and offset values give 200 and an empty page", async () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 210; i++) await db().execute({ sql: "INSERT INTO jobs (id, type, status, created_at, updated_at) VALUES (?, 'x', 'done', ?, ?)", args: [`job_page${String(i).padStart(4, "0")}`, now, now] });
  const q = await call("operator", "queues", "GET", { query: "limit=-1" });
  eq(q.status, 200);
  ok(q.body.jobs.length <= 200 && q.body.jobs.length > 0, `jobs: ${q.body.jobs.length}`);
  for (const query of ["limit=1e300", "limit=Infinity"]) {
    const r = await call("operator", "queues", "GET", { query });
    ok(r.status === 200 && r.body.jobs.length <= 200, `${query}: ${r.status} ${r.body?.jobs?.length}`);
  }
  for (const page of ["1e20", "Infinity", "-5"]) {
    const r = await call("operator", "incidents", "GET", { query: `page=${page}` });
    eq(r.status, 200, `incidents page=${page} ${r.text.slice(0, 120)}`);
    if (page !== "-5") eq(r.body.incidents.length, 0, `incidents page=${page} is empty`);
  }
  const B = await import("../lib/platform/billing.js");
  await B.ensureDefaultPlans();
  await B.startSubscription(store.b.id, "free");
  await db().execute({ sql: "INSERT INTO billing_events (id, provider_event_id, tenant_id, type, amount, occurred_at, applied_at) VALUES ('bev_platperm', 'pe_platperm', ?, 'payment.captured', 100, ?, ?)", args: [store.b.id, now, now] });
  for (const view of ["subscriptions", "events"]) {
    ok((await call("operator", "billing", "GET", { query: `view=${view}` })).body.rows.length > 0, `billing ${view} has a first page`);
    for (const offset of ["1e300", "Infinity"]) {
      const r = await call("operator", "billing", "GET", { query: `view=${view}&offset=${offset}` });
      eq(r.status, 200, `billing ${view} offset=${offset} ${r.text.slice(0, 120)}`);
      eq(r.body.rows.length, 0, `billing ${view} offset=${offset} is empty`);
    }
  }
});

await t("no network: no route reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

console.log(`\n${PLATFORM_ROUTES.length} rows × ${Object.keys(JARS).length} callers, ${EXEMPT_PLATFORM_ROUTES.length} exempt, ${ROUTES.size} route files`);
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
