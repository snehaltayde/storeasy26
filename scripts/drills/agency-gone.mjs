// Drill: the agency partner programme is gone from a running store (Phase 0 line 4).
//   pnpm drill:agency-gone            (the design harness on http://localhost:3017)
//   AGENCY_GONE_BASE_URL=http://localhost:3017 pnpm drill:agency-gone
// Fetch only: it never seeds, never writes and starts no server. Every former
// path is asked as anonymous, support and owner: GET → 404; POST to a former
// API path → 404 or 405, never 2xx.
// Sign-ins (POST /api/admin/login, the real form's endpoint):
//   owner    AGENCY_GONE_OWNER_EMAIL / _PASSWORD, else .design-data/p6-seed.json logins.owner
//   support  AGENCY_GONE_SUPPORT_EMAIL / _PASSWORD (the harness seeds no support login)
// A role without a sign-in is reported NOT RUN and the drill exits 2 (incomplete).
// Exit: 0 all checks ran and passed, 1 a check failed, 2 incomplete.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = (process.env.AGENCY_GONE_BASE_URL || "http://localhost:3017").replace(/\/$/, "");

const PAGES = ["/partners", "/approve/x"];
const APIS = ["/api/partners", "/api/partners/auth", "/api/approve", "/api/admin/agency-grants", "/api/platform/partners"];

async function seededOwner() {
  try {
    const seed = JSON.parse(await readFile(join(ROOT, ".design-data/p6-seed.json"), "utf8"));
    return seed?.logins?.owner?.email ? { email: seed.logins.owner.email, password: seed.logins.owner.password } : null;
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
  console.error(`✗ Nothing answers at ${BASE}. Start the harness (pnpm dev:design) or set AGENCY_GONE_BASE_URL.`);
  process.exit(2);
}

const roles = { anonymous: "" };
const notRun = [];
for (const [role, creds] of [["owner", fromEnv("OWNER") || (await seededOwner())], ["support", fromEnv("SUPPORT")]]) {
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
  await res.arrayBuffer();
  const good = method === "GET" ? res.status === 404 : [404, 405].includes(res.status);
  if (good) pass++;
  else fail++;
  console.log(`${good ? "✓" : "✗"} ${role.padEnd(9)} ${method.padEnd(4)} ${path} → ${res.status}${good ? "" : method === "GET" ? " (want 404)" : " (want 404 or 405)"}`);
}

for (const role of Object.keys(roles)) {
  for (const path of [...PAGES, ...APIS]) await check(role, "GET", path);
  for (const path of APIS) await check(role, "POST", path);
}

console.log(`\n${pass} passed, ${fail} failed against ${BASE}`);
for (const n of notRun) console.log(`NOT RUN  ${n}`);
process.exit(fail ? 1 : notRun.length ? 2 : 0);
