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
for (const r of PLATFORM_ROUTES) {
  await t(`${rowName(r)} as each caller`, async () => {
    const wrong = [];
    for (const caller of DENIED) {
      const res = await callRow(caller, r);
      if (res.status !== 401) wrong.push(`${caller}: want 401, got ${res.status} ${res.text.slice(0, 120)}`);
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

await t("least trusted: denied answers carry no store id or name", async () => {
  const canaries = [store.a.id, store.b.id, store.a.tenant.name, store.b.tenant.name].filter(Boolean).map(String);
  for (const caller of DENIED) {
    for (const path of ["tenants", "overview", "themes", "onboarding"]) {
      const res = await call(caller, path, "GET");
      eq(res.status, 401, `${caller} ${path}`);
      for (const c of canaries) ok(!res.text.includes(c), `${caller} ${path} holds ${c}`);
    }
  }
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
  for (const action of ["flags.set", "support.grant_created", "support.grant_revoked", "tenant.status", "flags.delete"]) {
    const mine = rows.filter((x) => x.action === action);
    ok(mine.length, `an audit row for ${action}`);
    for (const x of mine) {
      eq(x.actor, operatorId, `${action} actor`);
      eq(x.actor_kind, "operator", `${action} kind`);
    }
  }
});

await t("writes: the bootstrap caller is audited as bootstrap", async () => {
  const since = new Date().toISOString();
  eq((await call("bootstrap-before", "incidents", "POST", { body: { action: "open", title: "bootstrap probe" } })).status, 200, "incident");
  const rows = (await auditRows(since)).filter((x) => x.action === "tenant.status");
  ok(rows.length, "an audit row");
  for (const x of rows) {
    eq(x.actor, "bootstrap", "actor");
    eq(x.actor_kind, "bootstrap", "kind");
  }
});

await t("no network: no route reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

console.log(`\n${PLATFORM_ROUTES.length} rows × ${Object.keys(JARS).length} callers, ${EXEMPT_PLATFORM_ROUTES.length} exempt, ${ROUTES.size} route files`);
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
