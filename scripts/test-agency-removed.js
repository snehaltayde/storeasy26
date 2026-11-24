// The agency partner programme is removed (Phase 0 line 4).
//   pnpm test:agency-removed
// Owner decision: the routes, screens, links and the suite go; the agency
// tables stay (migrations are additive) and no data is deleted. This suite:
//   1. route table: none of the former paths has a page or route of its own;
//      the only match is the storefront catch-all, which calls notFound();
//   2. reference allowlist: the agency table names and former paths appear
//      only in migrations, this file, the agency-gone drill and the retired
//      drills, each with a reason;
//   3. auth: an agency session opens nothing, an agency-member invite makes no
//      membership, and a user with only an agency_members row can't sign in;
//   4. no guard table row names a former path; ROUTE_CLASSES has no "agency".
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const network = H.blockNetwork();
process.env.DATABASE_URL = "file:.test-agone-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.message || e).split("\n").join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const same = (a, b, m = "") => eq(JSON.stringify(a), JSON.stringify(b), m);
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const rel = (f) => relative(ROOT, f).split(sep).join("/");

// The paths the programme served (pages and API).
const FORMER_PATHS = ["/partners", "/approve/x", "/api/partners", "/api/partners/auth", "/api/approve", "/api/admin/agency-grants", "/api/platform/partners"];
const CATCH_ALL = "app/(storefront)/[...unmatched]/page.js";

// ---------------------------------------------------------------------------
console.log("— 1. route table");

// app/ entry files → URL segment patterns, (group) segments stripped.
const ENTRY_RE = /(^|\/)(page|route)\.(js|jsx|ts|tsx|mjs)$/;
const entries = (await walk(join(ROOT, "app")))
  .map(rel)
  .filter((f) => ENTRY_RE.test(f))
  .map((f) => ({ file: f, segs: f.split("/").slice(1, -1).filter((s) => !/^\(.*\)$/.test(s)) }));

function matches(segs, url) {
  const parts = url.split("/").filter(Boolean);
  const go = (i, j) => {
    if (i === segs.length) return j === parts.length;
    const s = segs[i];
    if (/^\[\[\.\.\..+\]\]$/.test(s)) return true; // optional catch-all: 0 or more
    if (/^\[\.\.\..+\]$/.test(s)) return j < parts.length; // catch-all: 1 or more
    if (j >= parts.length) return false;
    if (/^\[.+\]$/.test(s) || s === parts[j]) return go(i + 1, j + 1);
    return false;
  };
  return go(0, 0);
}

await t("no former path has a page or route of its own: the only match is the storefront catch-all", async () => {
  const found = FORMER_PATHS.map((p) => [p, entries.filter((e) => matches(e.segs, p)).map((e) => e.file)]);
  // the API catch-all answers every unknown /api path 404 JSON (test-api-unmatched)
  const API_CATCH_ALL = "app/api/[...unmatched]/route.js";
  same(found.filter(([, files]) => files.some((f) => f !== CATCH_ALL && f !== API_CATCH_ALL)), [], "[former path, files]");
});

await t("the storefront catch-all answers notFound()", async () => {
  const src = await readFile(join(ROOT, CATCH_ALL), "utf8");
  ok(/import\s*\{\s*notFound\s*\}\s*from\s*["']next\/navigation["']/.test(src), "imports notFound");
  ok(/\bnotFound\(\)/.test(src), "calls notFound()");
});

// ---------------------------------------------------------------------------
console.log("— 2. reference allowlist");

const REF_PATTERNS = [
  /\b(agencies|agency_members|agency_grants|agency_kits|agency_referrals|agency_commissions|client_approvals)\b/,
  /api\/partners/,
  /["'`]\/partners\b/,
  /api\/approve/,
  /["'`]\/approve\//,
  /agency-grants/,
  /platform\/partners/,
  /platform\/agency/,
  /components\/partners/,
  /"_agency"/,
  /kind: "agency"/,
  /agency-member/,
  /\bagency\.js\b/,
  /\/partners\b/,
];
// file (or folder ending "/") → why it may still name them
const ALLOWED = {
  "migrations/": "the agency tables stay; migrations are additive",
  "scripts/test-agency-removed.js": "this suite names what must be gone",
  "scripts/drills/agency-gone.mjs": "the drill that proves every former path answers 404",
};

await t("every allowlisted file or folder exists", async () => {
  same(Object.keys(ALLOWED).filter((p) => !existsSync(join(ROOT, p))), [], "missing allowlist entries");
});

await t("agency table names and former paths appear only in allowlisted files", async () => {
  const files = [];
  for (const d of ["app", "components", "lib", "scripts"]) files.push(...(await walk(join(ROOT, d))));
  files.push(join(ROOT, "package.json"));
  const hits = [];
  for (const f of files) {
    const r = rel(f);
    if (!/\.(js|jsx|ts|tsx|mjs|cjs|json|sql|md|css)$/.test(r)) continue;
    if (Object.keys(ALLOWED).some((a) => (a.endsWith("/") ? r.startsWith(a) : r === a))) continue;
    const lines = (await readFile(f, "utf8")).split("\n");
    lines.forEach((line, i) => {
      const p = REF_PATTERNS.find((re) => re.test(line));
      if (p) hits.push(`${r}:${i + 1} ${p}`);
    });
  }
  same(hits, [], "references outside the allowlist");
});

// ---------------------------------------------------------------------------
console.log("— 3. auth for former agency callers");

const store = await H.makeRoleStore({ name: "agone" });
const I = await import("../lib/platform/identity.js");
const S = await import("../lib/platform/sessions.js");
const C = await import("../lib/platform/control.js");
const db = () => C.platformDb();
const now = new Date().toISOString();

// A former partner: a control-plane user whose only tie is an agency_members row.
const partner = await I.createUser({ email: "partner@agone.test", password: "partner-pass-agone" });
await db().execute({ sql: "INSERT INTO agencies (id, name, status, created_at, updated_at) VALUES ('agc_00aa', 'Old Studio', 'verified', ?, ?)", args: [now, now] });
await db().execute({ sql: "INSERT INTO agency_members (agency_id, user_id, role, created_at) VALUES ('agc_00aa', ?, 'owner', ?)", args: [partner.id, now] });
const agencyToken = (await S.createSession({ userId: partner.id, kind: "agency", ttlMs: 10 * 60_000 })).token;

const { NextRequest } = await import("./support/next-server-stub.js");
const opReq = (path, { method = "GET", cookies = {}, body } = {}) => {
  const headers = { host: "ops.test" };
  if (method !== "GET") headers.origin = "http://ops.test";
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://ops.test/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
};
const Overview = await import(pathToFileURL(join(ROOT, "app/api/platform/overview/route.js")).href);
const PlatformLogin = await import(pathToFileURL(join(ROOT, "app/api/platform/login/route.js")).href);

await t("an agency session token in the merchant cookie is refused by an admin route (401)", async () => {
  const r = await store.call("signed-out", "orders", "GET", { cookies: { _admin: agencyToken } });
  eq(r.status, 401, "orders GET:");
  const owner = await store.call("owner", "orders", "GET");
  eq(owner.status, 200, "positive control, the owner:");
});

await t("an agency session token in the operator cookie is refused by platform/overview (401)", async () => {
  const r = await Overview.GET(opReq("platform/overview", { cookies: { _platform: agencyToken } }));
  eq(r.status, 401, "overview GET:");
});

await t("only an _agency cookie opens nothing (401 on admin and operator routes)", async () => {
  eq((await store.call("signed-out", "orders", "GET", { cookies: { _agency: agencyToken } })).status, 401, "admin orders:");
  eq((await Overview.GET(opReq("platform/overview", { cookies: { _agency: agencyToken } }))).status, 401, "platform overview:");
});

await t("an agency-member invite posted to /api/admin/accept-invite is refused and creates no membership", async () => {
  const inv = await I.createInvite({ email: "joiner@agone.test", kind: "agency-member", role: "agency-member:agc_00aa", invitedBy: "operator" });
  const r = await store.call("signed-out", "accept-invite", "POST", { body: { token: inv.token, password: "joiner-pass-agone" } });
  eq(r.status, 400, "accept-invite:");
  eq(r.setCookie.length, 0, "no session cookie set:");
  const users = await db().execute({ sql: "SELECT id FROM users WHERE email = ?", args: ["joiner@agone.test"] });
  eq(users.rows.length, 0, "no user created:");
  const used = await db().execute({ sql: "SELECT accepted_at FROM invitations WHERE id = ?", args: [inv.id] });
  eq(used.rows[0].accepted_at, null, "the invite is not consumed:");
});

await t("a user with only an agency_members row can't sign in at /api/admin/login (401)", async () => {
  const r = await store.call("signed-out", "login", "POST", { body: { email: "partner@agone.test", password: "partner-pass-agone" } });
  eq(r.status, 401, "admin login:");
  eq(r.setCookie.filter((c) => c.startsWith("_admin=") && !/max-age=0/i.test(c)).length, 0, "no merchant session:");
  const m = await db().execute({ sql: "SELECT COUNT(*) n FROM memberships WHERE user_id = ?", args: [partner.id] });
  eq(Number(m.rows[0].n), 0, "still no membership:");
});

await t("a user with only an agency_members row can't sign in at /api/platform/login (401)", async () => {
  const r = await PlatformLogin.POST(opReq("platform/login", { method: "POST", body: { email: "partner@agone.test", password: "partner-pass-agone" } }));
  eq(r.status, 401, "platform login:");
  eq(r.headers.getSetCookie().filter((c) => c.startsWith("_platform=")).length, 0, "no operator session:");
});

// ---------------------------------------------------------------------------
console.log("— 4. guard tables");

await t("no ADMIN_ROUTES or SHOPPER_ROUTES row names a former path; ROUTE_CLASSES has no agency", async () => {
  const { ADMIN_ROUTES } = await import("./support/admin-routes.js");
  const { SHOPPER_ROUTES, ROUTE_CLASSES } = await import("./support/shopper-routes.js");
  const formerAdmin = ["agency-grants"];
  const formerShopper = ["approve", "partners", "partners/auth", "platform/partners"];
  same(ADMIN_ROUTES.filter((r) => formerAdmin.includes(r.path)).map((r) => r.path), [], "admin rows:");
  same(SHOPPER_ROUTES.filter((r) => formerShopper.includes(r.path)).map((r) => r.path), [], "shopper rows:");
  same(SHOPPER_ROUTES.filter((r) => r.class === "agency").map((r) => r.path), [], "agency-class rows:");
  ok(!ROUTE_CLASSES.includes("agency"), "ROUTE_CLASSES still has agency");
  ok(SHOPPER_ROUTES.some((r) => r.path === "platform/case-studies" && r.class === "operator"), "platform/case-studies is an operator row");
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

await store.cleanup();
const { rm } = await import("node:fs/promises");
for (const f of [".test-agone-default.db", ".test-agone-default.db-wal", ".test-agone-default.db-shm"]) await rm(join(ROOT, f), { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
