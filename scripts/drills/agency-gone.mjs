// Drill: the agency partner programme is gone from a running store (Phase 0 line 4).
//   pnpm drill:agency-gone   (scripts/drills/run-isolated.mjs: a throwaway
//                             worktree, its own roles store seeded and started)
// Fetch only: it never seeds, never writes and starts no server. Every former
// path is asked as anonymous, support and owner: GET → 404; POST to a former
// API path → 404 or 405, never 2xx.
// Where: AGENCY_GONE_BASE_URL, else http://roles.localhost:$ROLES_PORT. There
// is no default port (never the owner harness ports).
// Sign-ins (POST /api/admin/login, the real form's endpoint), per role:
//   AGENCY_GONE_<OWNER|SUPPORT>_EMAIL / _PASSWORD, else the roles seed's member
//   (AGENCY_GONE_SEED_FILE, else .design-data-roles/roles-seed.json here)
// A role without a sign-in is reported NOT RUN and the drill exits 2 (incomplete).
// Exit: 0 all checks ran and passed, 1 a check failed, 2 incomplete.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rolesPort = String(process.env.ROLES_PORT ?? "").trim();
const BASE = (process.env.AGENCY_GONE_BASE_URL || (rolesPort ? `http://roles.localhost:${rolesPort}` : "")).replace(/\/$/, "");
if (!BASE) {
  console.error("✗ No store to ask: run pnpm drill:agency-gone (it seeds and starts a roles store in a throwaway worktree), or set AGENCY_GONE_BASE_URL.");
  process.exit(2);
}

const PAGES = ["/partners", "/approve/x"];
const APIS = ["/api/partners", "/api/partners/auth", "/api/approve", "/api/admin/agency-grants", "/api/platform/partners"];

async function seededMember(role) {
  try {
    const seed = JSON.parse(await readFile(process.env.AGENCY_GONE_SEED_FILE || join(ROOT, ".design-data-roles/roles-seed.json"), "utf8"));
    const m = (seed?.members || []).find((x) => x.role === role);
    return m?.email && m?.password ? { email: m.email, password: m.password } : null;
  } catch {
    return null;
  }
}
const fromEnv = (role) => {
  const email = process.env[`AGENCY_GONE_${role}_EMAIL`];
  const password = process.env[`AGENCY_GONE_${role}_PASSWORD`];
  return email && password ? { email, password } : null;
};

async function signIn(creds) {
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(creds),
    redirect: "manual",
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("_admin="));
  if (res.status !== 200 || !cookie) throw new Error(`sign-in answered ${res.status}`);
  return cookie.split(";")[0];
}

try {
  await fetch(`${BASE}/api/health`, { redirect: "manual" });
} catch {
  console.error(`✗ Nothing answers at ${BASE}. Run pnpm drill:agency-gone, or set AGENCY_GONE_BASE_URL.`);
  process.exit(2);
}

const roles = { anonymous: "" };
const notRun = [];
for (const [role, creds] of [["owner", fromEnv("OWNER") || (await seededMember("owner"))], ["support", fromEnv("SUPPORT") || (await seededMember("support"))]]) {
  if (!creds) {
    notRun.push(`${role}: no sign-in given`);
    continue;
  }
  try {
    roles[role] = await signIn(creds);
  } catch (e) {
    notRun.push(`${role}: ${e.message}`);
  }
}

let pass = 0;
let fail = 0;
async function check(role, method, path) {
  const headers = { origin: BASE };
  if (roles[role]) headers.cookie = roles[role];
  if (method === "POST") headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: method === "POST" ? "{}" : undefined, redirect: "manual" });
  const text = await res.text();
  // a page on a closed store is the closed page for every path (no agency
  // screen can show); an /api path is 404 JSON whatever the store's state
  const closedPage = !path.startsWith("/api/") && res.status === 200 && text.includes(CLOSED_TITLE);
  const good = method === "GET" ? res.status === 404 || closedPage : [404, 405].includes(res.status);
  if (good) pass++;
  else fail++;
  console.log(`${good ? "✓" : "✗"} ${role.padEnd(9)} ${method.padEnd(4)} ${path} → ${res.status}${good ? "" : method === "GET" ? " (want 404)" : " (want 404 or 405)"}`);
}

const CLOSED_TITLE = "Opening soon";
for (const role of Object.keys(roles)) {
  for (const path of [...PAGES, ...APIS]) await check(role, "GET", path);
  for (const path of APIS) await check(role, "POST", path);
}

// Any /api path with no route: 404 JSON on this (closed) store; a real route
// keeps its own JSON answer; a storefront page is still the closed page.
async function probe(label, method, path, want) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { origin: BASE, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined, redirect: "manual" });
  const type = res.headers.get("content-type") || "";
  const text = await res.text();
  const good = want(res.status, type, text);
  if (good) pass++;
  else fail++;
  console.log(`${good ? "✓" : "✗"} ${label} → ${res.status} ${type.split(";")[0]}`);
}
await probe("anonymous GET  /api/definitely-not-a-route (404 JSON)", "GET", "/api/definitely-not-a-route", (s, t) => s === 404 && t.includes("application/json"));
await probe("anonymous POST /api/definitely-not-a-route (404 JSON)", "POST", "/api/definitely-not-a-route", (s, t) => s === 404 && t.includes("application/json"));
await probe("anonymous GET  /api/admin/no-such-thing (404 JSON)", "GET", "/api/admin/no-such-thing", (s, t) => s === 404 && t.includes("application/json"));
await probe("anonymous GET  /api/account (its own JSON, not the closed page)", "GET", "/api/account", (s, t, b) => t.includes("application/json") && !b.includes(CLOSED_TITLE));
await probe("anonymous GET  / (the closed page)", "GET", "/", (s, t, b) => s === 200 && b.includes(CLOSED_TITLE));

console.log(`\n${pass} passed, ${fail} failed against ${BASE}`);
for (const n of notRun) console.log(`NOT RUN  ${n}`);
process.exit(fail ? 1 : notRun.length ? 2 : 0);
