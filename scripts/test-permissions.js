// Per-role permission suite (Phase 0 line 1): every admin API route, called as
// every caller, against the role matrix in lib/platform/authz.js.
//   pnpm test:permissions
// The route table is scripts/support/admin-routes.js. Expected answers come
// from roleAllows(), never by hand: an allowed role gets anything but 401/403,
// a denied role 403, a signed-out caller and another store's owner 401, and an
// operator under a support grant what support gets (with its _platform cookie,
// and with the __Host-support session from the cross-host entry, Phase 3 line 5). A static guard keeps the
// table in step with app/api/admin/**/route.js. Outside services are blanked
// and fetch() is blocked; every database is a throwaway file: database.
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const H = await import("./support/route-harness.js");
H.spyOnRequireAdmin(); // before any route or lib/admin-auth.js import
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-perm-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
const network = H.blockNetwork();

const { ADMIN_ROUTES, EXEMPT_ROUTES } = await import("./support/admin-routes.js");
const AUTHZ = await import("../lib/platform/authz.js");
const { roleAllows, isWriteAction, ROLES, ACTIONS } = AUTHZ;

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

// --- 1.3 the documented matrix equals authz.js ---------------------------------
// A copy of docs/ARCHITECTURE.md "Roles and permission matrix" (merchant roles).
const MATRIX = {
  "storefront.read": ["owner", "admin", "staff", "support"],
  "storefront.write": ["owner", "admin", "staff"],
  "storefront.publish": ["owner", "admin"],
  "offers.read": ["owner", "admin", "staff", "support"],
  "upsells.read": ["owner", "admin", "staff", "support"],
  "offers.write": ["owner", "admin", "staff"],
  "upsells.write": ["owner", "admin", "staff"],
  "orders.read": ["owner", "admin", "staff", "support"],
  "returns.decide": ["owner", "admin", "staff"],
  "orders.push": ["owner", "admin"],
  "orders.cancel": ["owner", "admin"],
  "sync.run": ["owner", "admin"],
  "settings.read": ["owner", "admin"],
  "settings.write": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
  "team.manage": ["owner", "admin"],
  "team.owner": ["owner"],
  // Phase 4 line 1
  "apps.read": ["owner", "admin", "staff", "support"],
  "apps.manage": ["owner", "admin"],
};

await t("matrix: the suite's copy equals ROLES × ACTIONS in authz.js exactly", () => {
  eq([...ROLES].sort().join(","), "admin,owner,staff,support", "roles");
  eq([...ACTIONS].sort().join(","), Object.keys(MATRIX).sort().join(","), "actions");
  for (const action of ACTIONS) for (const role of ROLES) eq(roleAllows(role, action), MATRIX[action].includes(role), `${role} ${action}`);
  ok(Object.isFrozen(ACTIONS), "ACTIONS frozen");
});

await t("matrix: docs/ARCHITECTURE.md's table says the same as the copy", async () => {
  const doc = await readFile(join(ROOT, "docs/ARCHITECTURE.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Roles and permission matrix"));
  const seen = new Set();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6) continue;
    const actions = cells[1].replace(/\(.*\)/, "").split("/").map((s) => s.trim()).filter((s) => /^[a-z]+\.[a-z]+$/.test(s));
    for (const action of actions) {
      seen.add(action);
      const roles = ["owner", "admin", "staff", "support"].filter((_, i) => cells[2 + i] === "allow");
      eq(roles.join(","), (MATRIX[action] || []).join(","), `doc row ${action}`);
    }
  }
  eq([...seen].sort().join(","), Object.keys(MATRIX).sort().join(","), "doc actions");
});

// --- 1.2 the table against authz ------------------------------------------------
await t("table: every row's action is in ACTIONS and every row is unique", () => {
  const keys = new Set();
  for (const r of ADMIN_ROUTES) {
    ok(ACTIONS.includes(r.action), `${rowName(r)} action ${r.action} in ACTIONS`);
    if (r.asks) ok(ACTIONS.includes(r.asks), `${rowName(r)} asks ${r.asks} in ACTIONS`);
    const k = `${r.method} ${r.path} ${r.variant ?? ""}`;
    ok(!keys.has(k), `${k} duplicated`);
    keys.add(k);
    ok(!r.kind || r.kind === "gated", `${rowName(r)} kind`);
    if (r.allowStatus) ok(![401, 403].includes(r.allowStatus[0]) && r.allowStatus[1], `${rowName(r)} allowStatus is not 401/403 and has a reason`);
  }
});

await t("table: crossOrigin 'read' marks exactly the read actions on mutating methods", () => {
  for (const r of ADMIN_ROUTES) eq(r.crossOrigin === "read", r.method !== "GET" && !isWriteAction(r.action), rowName(r));
});

// --- the stores (before any route module is imported: the guard imports them) ----
const store = await H.makeRoleStore({ name: "perm" });
const { call, a } = store;
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/sessions.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { requireAdmin, adminSessionTokenFor } = await import("../lib/admin-auth.js");
// Phase 2 line 8: the revoke-owner-invite row's probe, an owner invite of store A
// that has already expired (the owner's call finds nothing to revoke)
await (await import("../lib/platform/control.js")).platformDb().execute({
  sql: "INSERT INTO invitations (id, token_hash, kind, email, tenant_id, role, invited_by, created_at, expires_at) VALUES ('i_permownerprobe', 'probe-hash', 'invite', 'probe-owner@perm.test', ?, 'owner', NULL, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
  args: [a.id],
});

// --- 1.6 the guard (the filesystem, and each route module's real exports) --------
const ROUTE_FILE = /^route\.(js|ts|mjs)$/;
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
async function walk(dir) {
  const out = [];
  for (const f of await readdir(dir)) {
    const p = join(dir, f);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
    else if (ROUTE_FILE.test(f)) out.push(p);
  }
  return out;
}
const source = async (rel) => readFile(join(ROOT, rel), "utf8").catch(() => null);
// path -> { file, src, methods }: methods are the module's exports, so
// `export function`, `export { h as POST }` and re-exports all count
const ROUTES = new Map();
for (const f of (await walk(join(ROOT, "app/api/admin"))).sort()) {
  const path = relative(join(ROOT, "app/api/admin"), dirname(f)).split("\\").join("/");
  const mod = await import(pathToFileURL(f).href);
  ROUTES.set(path, { file: relative(ROOT, f), src: await readFile(f, "utf8"), methods: Object.keys(mod).filter((k) => HTTP_METHODS.includes(k) && typeof mod[k] === "function") });
}
const routeFiles = [...ROUTES.keys()];
// cross-check only: the plain `export const|async function METHOD` the routes use today
const regexMethodsOf = (src) => [...src.matchAll(/export\s+(?:const|async\s+function)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)].map((m) => m[1]);
// every "x.y" literal inside each requireAdmin( … ) call, parentheses balanced
function requireAdminLiterals(src) {
  const out = new Set();
  let i = src.indexOf("requireAdmin(");
  while (i !== -1) {
    let depth = 0;
    let j = i + "requireAdmin".length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    for (const m of src.slice(i, j).matchAll(/"([a-z]+\.[a-z]+)"/g)) out.add(m[1]);
    i = src.indexOf("requireAdmin(", j);
  }
  return out;
}
const callsRequireAdmin = (src) => /\brequireAdmin\(/.test(src.replace(/^\s*\/\/.*$/gm, ""));

async function guardProblems(rows, exempt, routes) {
  const problems = [];
  const all = [...rows.map((r) => ({ ...r, kind: r.kind ?? "gated" })), ...exempt];
  for (const [path, { methods }] of routes) {
    for (const m of methods) if (!all.some((r) => r.path === path && r.method === m)) problems.push(`(a) ${m} ${path} has no table row`);
  }
  for (const r of all) {
    const route = routes.get(r.path);
    if (!route) {
      problems.push(`(b) ${rowName(r)}: app/api/admin/${r.path}/route.{js,ts,mjs} is missing`);
      continue;
    }
    if (!route.methods.includes(r.method)) problems.push(`(b) ${rowName(r)}: the route exports no ${r.method}`);
    if (r.kind === "gated") {
      const gate = r.via ? await source(r.via) : route.src;
      if (gate == null) problems.push(`(b) ${rowName(r)}: via ${r.via} is missing`);
      else if (!callsRequireAdmin(gate) || !/!auth\.ok/.test(gate)) problems.push(`(c) ${rowName(r)}: ${r.via ?? "the route"} has no requireAdmin( call or no !auth.ok check`);
    } else {
      if (callsRequireAdmin(route.src)) problems.push(`(e) exempt ${rowName(r)} calls requireAdmin`);
      if (!EXEMPT_RULES[r.kind]) problems.push(`(e) exempt ${rowName(r)} has no rule "${r.kind}"`);
    }
  }
  for (const [path, { src }] of routes) {
    const mine = rows.filter((r) => r.path === path);
    const vias = [...new Set(mine.map((r) => r.via).filter(Boolean))];
    const literals = new Set(requireAdminLiterals(src));
    for (const v of vias) for (const l of requireAdminLiterals((await source(v)) ?? "")) literals.add(l);
    for (const l of literals) if (!mine.some((r) => r.action === l)) problems.push(`(d) ${path}: requireAdmin asks for "${l}" but no row has it`);
  }
  return problems;
}

// the exempt rules, by kind; defined below, checked by the guard (e)
const EXEMPT_RULES = {};
for (const k of ["login", "logout", "token", "recover", "maintenance-pass"]) EXEMPT_RULES[k] = true;

await t("guard: every route file, exported method and requireAdmin action has its row (filesystem walk + import)", async () => {
  const problems = await guardProblems(ADMIN_ROUTES, EXEMPT_ROUTES, ROUTES);
  if (problems.length) throw new Error(problems.join("\n"));
  ok(routeFiles.length >= 40, `walked ${routeFiles.length} route files`);
  for (const [path, { src, methods }] of ROUTES) eq([...regexMethodsOf(src)].sort().join(","), [...methods].sort().join(","), `${path}: source scan vs exports`);
});

await t("guard: it catches a missing row, a stale row, a dropped gate, an unlisted action, a gated exempt and a non-const export", async () => {
  const drop = (pred) => ADMIN_ROUTES.filter((r) => !pred(r));
  const has = (problems, tag) => problems.some((p) => p.startsWith(tag));
  const withRoute = (path, route) => new Map([...ROUTES, [path, route]]);
  ok(has(await guardProblems(drop((r) => r.path === "audit"), EXEMPT_ROUTES, ROUTES), "(a)"), "(a) a route without rows");
  // `export { h as DELETE }` / `export function PATCH` are exports, so they need rows
  ok(has(await guardProblems(ADMIN_ROUTES, EXEMPT_ROUTES, withRoute("audit", { ...ROUTES.get("audit"), methods: ["GET", "DELETE"] })), "(a)"), "(a) an extra exported method");
  ok(has(await guardProblems(ADMIN_ROUTES, EXEMPT_ROUTES, withRoute("ghost", { file: "app/api/admin/ghost/route.ts", src: "export { h as POST }", methods: ["POST"] })), "(a)"), "(a) a route.ts with a re-exported method");
  ok(has(await guardProblems([...ADMIN_ROUTES, { path: "audit", method: "DELETE", action: "audit.read" }], EXEMPT_ROUTES, ROUTES), "(b)"), "(b) a row for a missing method");
  ok(has(await guardProblems([...ADMIN_ROUTES, { path: "no-such-route", method: "GET", action: "audit.read" }], EXEMPT_ROUTES, ROUTES), "(b)"), "(b) a row for a missing file");
  ok(has(await guardProblems(ADMIN_ROUTES.map((r) => (r.path === "refs" ? { ...r, via: undefined } : r)), EXEMPT_ROUTES, ROUTES), "(c)"), "(c) a gated row whose source has no requireAdmin");
  ok(has(await guardProblems(drop((r) => r.path === "integrations" && r.variant === "revoke"), EXEMPT_ROUTES, ROUTES), "(d)"), "(d) an action in the source no row has");
  ok(has(await guardProblems(ADMIN_ROUTES, [...EXEMPT_ROUTES, { path: "audit", method: "GET", kind: "login" }], ROUTES), "(e)"), "(e) an exempt route that calls requireAdmin");
  ok(has(await guardProblems(ADMIN_ROUTES, EXEMPT_ROUTES.map((r) => (r.path === "recover" ? { ...r, kind: "none" } : r)), ROUTES), "(e)"), "(e) an exempt route without its rule");
});

// line 2 (S6): every read the documents dispatcher serves has its own row
await t("guard: every DOCUMENT_READS op in lib/admin/documents-api.js has a storefront.read row", async () => {
  const { DOCUMENT_READS } = await import("../lib/admin/documents-api.js");
  ok(Array.isArray(DOCUMENT_READS) && DOCUMENT_READS.length >= 7, `DOCUMENT_READS exported (${DOCUMENT_READS?.length})`);
  const missing = DOCUMENT_READS.filter((op) => !ADMIN_ROUTES.some((r) => r.path === "documents" && r.method === "PUT" && r.variant === op && r.action === "storefront.read"));
  eq(missing.join(","), "", "document reads without a row:");
});

// (c) per method: every exported method of a gated route answers signed-out 401
await t("guard: every exported method of every non-exempt route answers a signed-out caller 401", async () => {
  const wrong = [];
  for (const [path, { methods }] of ROUTES) {
    for (const m of methods) {
      if (EXEMPT_ROUTES.some((r) => r.path === path && r.method === m)) continue;
      const row = ADMIN_ROUTES.find((r) => r.path === path && r.method === m);
      const res = await call("signed-out", path, m, row?.probe ?? {});
      if (res.status !== 401) wrong.push(`${m} ${path}: got ${res.status}`);
    }
  }
  if (wrong.length) throw new Error(wrong.join("\n"));
});

await t("setup: outside services blank, only file: databases, fetch blocked", () => {
  for (const k of H.OUTSIDE_SERVICE_ENV) eq(process.env[k], "", k);
  for (const url of [process.env.PLATFORM_DB_URL, process.env.DATABASE_URL, store.a.tenant.dbUrl, store.b.tenant.dbUrl]) ok(/^file:\.test-perm-/.test(url), `${url} is a .test-perm file: database`);
  eq(typeof globalThis.fetch, "function");
});

// --- 1.4 every gated row as every caller -----------------------------------------
const expectFor = (caller, action) => {
  if (caller === "signed-out" || caller === "owner-b") return "401";
  const role = caller.startsWith("operator-support") ? "support" : caller;
  return roleAllows(role, action) ? "allowed" : "403";
};
const callRow = (caller, r, extra = {}) => call(caller, r.path, r.method, { ...(r.probe ?? {}), ...extra });

for (const r of ADMIN_ROUTES) {
  await t(`${rowName(r)} → ${r.action} as each caller`, async () => {
    const wrong = [];
    for (const caller of H.CALLERS) {
      const want = expectFor(caller, r.action);
      const res = await callRow(caller, r);
      // allowed: past the gate (not 401/403), and no server error unless the row says why
      const good = want === "allowed" ? ![401, 403].includes(res.status) && (res.status < 500 || r.allowStatus?.[0] === res.status) : String(res.status) === want;
      if (!good) wrong.push(`${caller}: want ${want}, got ${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      // the action requireAdmin was really asked for (spy), so variants that no
      // role tells apart (test/revoke, push/cancel, …) are still checked
      if (res.asked.join(",") !== (r.asks ?? r.action)) wrong.push(`${caller}: requireAdmin asked for [${res.asked.join(", ")}], row says ${r.asks ?? r.action}`);
    }
    if (wrong.length) throw new Error([...new Set(wrong)].join("\n"));
  });
}

// --- 1.5 cross-origin --------------------------------------------------------------
await t("cross-origin: every write row, and every read on a mutating method, answers the owner 403", async () => {
  const wrong = [];
  for (const r of ADMIN_ROUTES) {
    if (!(isWriteAction(r.action) || r.method !== "GET")) continue;
    const res = await callRow("owner", r, { origin: "https://evil.test" });
    if (res.status !== 403) wrong.push(`${rowName(r)}: got ${res.status}`);
  }
  if (wrong.length) throw new Error(wrong.join("\n"));
});

await t("cross-origin: a GET read is not refused for an Origin header", async () => {
  const res = await call("owner", "offers", "GET", { origin: "https://evil.test" });
  eq(res.status, 200);
});

// --- F2 regression: requireAdmin itself ----------------------------------------------
const fakeReq = ({ method, origin, cookie }) => ({
  ...(method ? { method } : {}),
  cookies: { get: (n) => (n === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: a.tenant.domains[0], ...(origin ? { origin } : {}) })[k.toLowerCase()] ?? null },
});
await t("F2: requireAdmin refuses a cross-origin POST/PUT/PATCH/DELETE under a read action; GET, HEAD and method-less requests keep the old rule", async () => {
  const cookie = store.cookies.owner._admin;
  await withTenant(a.tenant, async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) eq((await requireAdmin(fakeReq({ method, origin: "https://evil.test", cookie }), "storefront.read")).status, 403, method);
    for (const method of ["GET", "HEAD", undefined]) eq((await requireAdmin(fakeReq({ method, origin: "https://evil.test", cookie }), "storefront.read")).ok, true, String(method));
    eq((await requireAdmin(fakeReq({ origin: "https://evil.test", cookie }), "storefront.write")).status, 403, "method-less write");
    eq((await requireAdmin(fakeReq({ method: "POST", origin: `http://${a.tenant.domains[0]}`, cookie }), "storefront.read")).ok, true, "same-origin POST read");
  });
});

// --- F1 regression: a second owner -------------------------------------------------
await t("F1: an admin can neither demote nor remove an owner; an owner can", async () => {
  const owner2 = await I.createUser({ email: "owner2@perm-a.test", password: "owner2-pass-perm" });
  await I.addMembership(owner2.id, a.id, "owner");
  try {
    const demote = await call("admin", "team", "POST", { body: { action: "role", userId: owner2.id, role: "staff" } });
    eq(demote.status, 403, "admin demotes owner");
    eq(await S.membershipRole(owner2.id, a.id), "owner", "still owner after the admin's demote");
    const remove = await call("admin", "team", "POST", { body: { action: "remove", userId: owner2.id } });
    eq(remove.status, 403, "admin removes owner");
    eq(await S.membershipRole(owner2.id, a.id), "owner", "still a member after the admin's remove");
    const adminOnStaff = await call("admin", "team", "POST", { body: { action: "role", userId: store.users.staff.id, role: "staff" } });
    eq(adminOnStaff.status, 200, "admin still manages a non-owner");
    const byOwner = await call("owner", "team", "POST", { body: { action: "role", userId: owner2.id, role: "staff" } });
    eq(byOwner.status, 200, "owner demotes owner");
    eq(await S.membershipRole(owner2.id, a.id), "staff", "demoted by the owner");
    const row = (await store.platform.control.platformDb().execute({ sql: "SELECT action, diff FROM audit_log WHERE tenant_id = ? AND resource = ? ORDER BY at DESC LIMIT 1", args: [a.id, `member:${owner2.id}`] })).rows[0];
    eq(row?.action, "team.owner", "audited as team.owner");
    eq(JSON.parse(row.diff).targetWasOwner, true, "diff.targetWasOwner");
    const staffRow = (await store.platform.control.platformDb().execute({ sql: "SELECT action, diff FROM audit_log WHERE tenant_id = ? AND resource = ? ORDER BY at DESC LIMIT 1", args: [a.id, `member:${store.users.staff.id}`] })).rows[0];
    eq(staffRow?.action, "team.manage", "a non-owner change stays team.manage");
    eq(JSON.parse(staffRow.diff).targetWasOwner, false, "diff.targetWasOwner false");
  } finally {
    await I.removeMembership(owner2.id, a.id);
  }
});

// --- 1.8 fail closed ------------------------------------------------------------------
await t("fail closed: a store with members refuses its legacy shared-password token (401)", async () => {
  eq(process.env.ADMIN_PASSWORD, "", "ADMIN_PASSWORD unset");
  ok(await S.tenantHasMembers(a.id), "store A has members");
  const legacy = await adminSessionTokenFor(a.id, a.tenant.secrets.admin_password);
  for (const r of ADMIN_ROUTES.filter((x) => x.method === "GET")) {
    const res = await call("signed-out", r.path, r.method, { ...(r.probe ?? {}), cookies: { _admin: legacy } });
    eq(res.status, 401, rowName(r));
  }
});

// --- 1.7 exempt routes ------------------------------------------------------------------
const EVIL = { origin: "https://evil.test" };
const adminCookie = (res) => res.setCookie.find((c) => c.startsWith("_admin="));
const mxCookie = (res) => res.setCookie.find((c) => /^_mx=[^;]+/.test(c));

await t("exempt login: cross-origin 403; {} 400; wrong password 401 with no _admin cookie", async () => {
  eq((await call("signed-out", "login", "POST", { body: { email: "owner@perm-a.test", password: "x" }, ...EVIL })).status, 403, "cross-origin");
  eq((await call("signed-out", "login", "POST", { body: {} })).status, 400, "{}");
  const wrong = await call("signed-out", "login", "POST", { body: { email: "owner@perm-a.test", password: "not-the-password" } });
  eq(wrong.status, 401, "wrong password");
  eq(adminCookie(wrong), undefined, "no _admin cookie");
  const noEmail = await call("signed-out", "login", "POST", { body: { password: a.tenant.secrets.admin_password } });
  eq(noEmail.status, 401, "the shared password on a store with members");
  eq(adminCookie(noEmail), undefined, "no _admin cookie for the shared password");
});

for (const path of ["accept-invite", "reset"]) {
  await t(`exempt ${path}: cross-origin 403; {} 400; a bad token 400; never 401`, async () => {
    const seen = [];
    const go = async (caller, opts) => {
      const res = await call(caller, path, "POST", opts);
      seen.push(res.status);
      return res.status;
    };
    eq(await go("signed-out", { body: { token: "bogus", password: "long-enough-pass" }, ...EVIL }), 403, "cross-origin");
    eq(await go("signed-out", { body: {} }), 400, "{}");
    eq(await go("signed-out", { body: { token: "bogus", password: "long-enough-pass" } }), 400, "bad token");
    eq(await go("owner", { body: { token: "bogus", password: "long-enough-pass" } }), 400, "bad token, signed in");
    ok(!seen.includes(401), "never 401");
  });
}

await t("exempt recover: cross-origin 403; {} 400; an unknown email 200 with the generic body", async () => {
  eq((await call("signed-out", "recover", "POST", { body: { email: "nobody@perm-a.test" }, ...EVIL })).status, 403, "cross-origin");
  eq((await call("signed-out", "recover", "POST", { body: {} })).status, 400, "{}");
  const res = await call("signed-out", "recover", "POST", { body: { email: "nobody@perm-a.test" } });
  eq(res.status, 200, "unknown email");
  eq(res.body?.message, "If that account exists, a reset link is on its way.", "generic body");
});

// Phase 3 line 5: an operator's support session never gets an _mx pass (it
// would outlive the grant); it lifts the curtain only while the grant is open
await t("exempt maintenance-pass: always 302 to /admin/login; _mx only for a verified member or operator session, never a support session", async () => {
  ok(a.tenant.secrets.order_link_secret, "the store has its pass secret (order_link_secret)");
  const want = { owner: true, admin: true, staff: true, support: true, "operator-support": true, "operator-support-entry": false, "signed-out": false, "owner-b": false };
  for (const caller of H.CALLERS) {
    const res = await call(caller, "maintenance-pass", "GET");
    eq(res.status, 302, `${caller} status`);
    eq(new URL(res.headers.get("location")).pathname, "/admin/login", `${caller} location`);
    eq(Boolean(mxCookie(res)), want[caller], `${caller} _mx`);
  }
});

// Phase 3 line 5: the cross-host entry. Only a live, unused, 60-second token
// for THIS host's store's open grant gets a cookie: a used one, an expired one,
// store A's on store B and one for a closed grant get 400 and set no cookie.
const SP = await import("../lib/platform/support.js");
const supportCookie = (res) => res.setCookie.find((c) => c.startsWith("__Host-support="));
const OP = { kind: "operator", id: store.users.operator.id };
const enter = (caller, token, host = a.tenant.domains[0]) => call(caller, "support-entry", "POST", { form: { token }, host, origin: H.CONSOLE_ORIGIN });
await t("exempt support-entry: a fresh token → 303 /admin with a host-only HttpOnly Secure Lax __Host-support cookie; used again → 400, no cookie", async () => {
  const { token } = await SP.mintSupportEntry({ tenantId: a.id, operator: OP, consoleOrigin: H.CONSOLE_ORIGIN });
  const res = await enter("signed-out", token);
  eq(res.status, 303, `first use ${res.text.slice(0, 120)}`);
  eq(new URL(res.headers.get("location")).pathname, "/admin", "location path");
  eq(new URL(res.headers.get("location")).host, a.tenant.domains[0], "location host: the store's own (requestOrigin), never the server's bind address");
  const c = supportCookie(res) || "";
  ok(/HttpOnly/i.test(c) && /Secure/i.test(c) && /SameSite=Lax/i.test(c) && /Path=\//i.test(c), `cookie attributes: ${c.replace(/=[^;]+/, "=…")}`);
  ok(!/Domain=/i.test(c), "host-only: no Domain attribute");
  ok(!res.headers.get("location").includes(token) && !res.text.includes(token), "the token is not echoed");
  const again = await enter("signed-out", token);
  eq(again.status, 400, "second use");
  eq(supportCookie(again), undefined, "no cookie on the second use");
});
await t("exempt support-entry: of 6 racing uses of one token exactly one gets the cookie (a conditional UPDATE)", async () => {
  const { token } = await SP.mintSupportEntry({ tenantId: a.id, operator: OP, consoleOrigin: H.CONSOLE_ORIGIN });
  const all = await Promise.all(Array.from({ length: 6 }, () => enter("signed-out", token)));
  eq(all.filter((r) => r.status === 303).length, 1, "303s");
  eq(all.filter((r) => supportCookie(r)).length, 1, "cookies");
  ok(all.every((r) => r.status === 303 || r.status === 400), "the rest 400");
});
await t("exempt support-entry: an expired token, store A's on store B, a closed grant's, a made-up and a missing one → 400, no cookie, never 401; any caller", async () => {
  const grantA = await SP.activeSupportGrant(a.id);
  const exp = await S.createSession({ userId: OP.id, kind: "support_entry", ttlMs: -1000, grantId: grantA.id });
  await store.platform.control.platformDb().execute({ sql: "UPDATE sessions SET entry_origin = ? WHERE id = ?", args: [H.CONSOLE_ORIGIN, exp.id] }); // only its age is wrong
  const expired = exp.token;
  const onB = (await SP.mintSupportEntry({ tenantId: a.id, operator: OP, consoleOrigin: H.CONSOLE_ORIGIN })).token;
  const gB = await SP.createSupportGrant({ tenantId: store.b.id, reason: "perm closed grant probe", hours: 1, operator: OP });
  const closed = (await SP.mintSupportEntry({ tenantId: store.b.id, operator: OP, consoleOrigin: H.CONSOLE_ORIGIN })).token;
  await SP.revokeSupportGrant(gB.id, { operator: OP });
  const cases = [
    ["expired", () => enter("signed-out", expired)],
    ["store A's token on store B", () => enter("signed-out", onB, store.b.tenant.domains[0])],
    ["store A's token, spent on B, then on A", () => enter("signed-out", onB)],
    ["a closed grant's", () => enter("signed-out", closed, store.b.tenant.domains[0])],
    ["made up", () => enter("signed-out", "f".repeat(64))],
    ["missing", () => call("signed-out", "support-entry", "POST", { form: {} })],
    ["as the owner", () => enter("owner", "f".repeat(64))],
    ["as support", () => enter("support", "f".repeat(64))],
    ["as operator-support", () => enter("operator-support", "f".repeat(64))],
  ];
  const bad = [];
  for (const [label, go] of cases) {
    const res = await go();
    if (res.status !== 400) bad.push(`${label}: ${res.status}`);
    if (supportCookie(res)) bad.push(`${label}: set a cookie`);
  }
  eq(bad.join("\n"), "", "");
});

await t("exempt support-entry: a form from another origin, one with no Origin and a JSON body → 400, no cookie, and none of them spends the token", async () => {
  const { token } = await SP.mintSupportEntry({ tenantId: a.id, operator: OP, consoleOrigin: H.CONSOLE_ORIGIN });
  const cases = [
    ["a form from another origin", () => call("signed-out", "support-entry", "POST", { form: { token }, origin: "https://evil.test" })],
    ["a form from the store itself", () => call("signed-out", "support-entry", "POST", { form: { token } })],
    ["a form with no Origin", () => call("signed-out", "support-entry", "POST", { form: { token }, origin: null })],
    ["a JSON body from the console's origin", () => call("signed-out", "support-entry", "POST", { body: { token }, origin: H.CONSOLE_ORIGIN })],
  ];
  const bad = [];
  for (const [label, go] of cases) {
    const res = await go();
    if (res.status !== 400) bad.push(`${label}: ${res.status}`);
    if (supportCookie(res)) bad.push(`${label}: set a cookie`);
  }
  eq(bad.join("\n"), "", "");
  eq((await enter("signed-out", token)).status, 303, "the token still works from the console's origin");
});

// last: logout revokes the session it is called with
await t("exempt logout: cross-origin 403; signed-out 200 clearing _admin; a session is revoked", async () => {
  eq((await call("signed-out", "logout", "POST", EVIL)).status, 403, "cross-origin");
  const out = await call("signed-out", "logout", "POST");
  eq(out.status, 200, "signed-out");
  ok(/^_admin=;/.test(adminCookie(out) || "") && /max-age=0/i.test(adminCookie(out)), "clears _admin");
  const throwaway = await store.session("staff");
  ok(await S.verifySession(throwaway, "merchant"), "throwaway session live");
  eq((await call("staff", "logout", "POST", { cookies: { _admin: throwaway } })).status, 200, "with a session");
  eq(await S.verifySession(throwaway, "merchant"), null, "revoked");
  ok(await S.verifySession(store.cookies.staff._admin, "merchant"), "the staff caller's own session untouched");
});

await t("no network: no route reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

const gated = ADMIN_ROUTES.length;
console.log(`\n${gated} rows × ${H.CALLERS.length} callers, ${EXEMPT_ROUTES.length} exempt routes, ${routeFiles.length} route files`);
await store.cleanup(); // every .test-perm-*.db file, the default database included
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
