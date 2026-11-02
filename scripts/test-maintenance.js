// Maintenance bypass suite: a cookie lifts the curtain only when its VALUE
// verifies for this tenant. Forged, cross-tenant, wrong-kind and expired values
// get the closed page; genuine staff keep the real site; checkout stays closed.
// Runs on Node against file DBs — this covers the decision logic and which files
// use the gate, NOT the edge runtime or real responses. For those, run
// `pnpm drill:maintenance-edge`.
//   pnpm test:maintenance
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-mx-default.db";
process.env.PLATFORM_DB_URL = "file:.test-mx-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_ADMIN_PASSWORD = "operator-bootstrap-pass";
process.env.ADMIN_PASSWORD = "legacy-admin-pass";
process.env.ORDER_LINK_SECRET = "legacy-order-secret";

const dbs = [".test-mx-default.db", ".test-mx-platform.db", ".test-mx-a.db", ".test-mx-b.db", ".test-mx-boot.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const I = await import("../lib/platform/identity.js");
const { createSession, revokeSessionByToken, OPERATOR_SESSION_TTL_MS, MERCHANT_SESSION_TTL_MS } = await import("../lib/platform/sessions.js");
const { platformSessionToken } = await import("../lib/platform/admin-auth.js");
const { adminSessionToken } = await import("../lib/admin-auth.js");
const { checkoutCapability } = await import("../lib/commerce/adapter.js");
const { maintenanceCurtain, maintenanceBypass, issueMaintenancePass, verifyMaintenancePass, MAINTENANCE_PASS_TTL_S } = await import("../lib/maintenance.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});

const MESSAGE = "Back by 6pm IST";
const closed = { enabled: true, message: MESSAGE };
for (const [id, file, secrets] of [
  ["ma", ".test-mx-a.db", { order_link_secret: "ma-secret", admin_password: "ma-pass" }],
  ["mb", ".test-mx-b.db", { order_link_secret: "mb-secret", admin_password: "mb-pass" }],
  ["boot", ".test-mx-boot.db", { order_link_secret: "boot-secret", admin_password: "boot-pass" }],
  ["nosecret", ".test-mx-boot.db", { admin_password: "nosecret-pass" }],
]) {
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: { maintenance: closed }, secrets });
}
const inTenant = async (id, fn) => withTenant(await C.getTenant(id), fn);

// A cookie jar shaped like next/headers cookies() and request.cookies.
const jar = (cookies = {}) => ({ get: (name) => (cookies[name] === undefined ? undefined : { name, value: cookies[name] }) });

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (a, b, msg = "") => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const curtained = async (tenant, cookies) => {
  const c = await inTenant(tenant, () => maintenanceCurtain(jar(cookies)));
  eq(c?.message, MESSAGE, `${JSON.stringify(Object.keys(cookies))} should see the curtain:`);
};
const open = async (tenant, cookies) => {
  eq(await inTenant(tenant, () => maintenanceCurtain(jar(cookies))), null, `${JSON.stringify(Object.keys(cookies))} should see the store:`);
};

// fixtures: a member of ma, a member of mb, and an operator
const member = await I.createUser({ email: "member@x.test", password: "member-pass-123" });
await I.addMembership(member.id, "ma", "owner");
const other = await I.createUser({ email: "other@x.test", password: "other-pass-123" });
await I.addMembership(other.id, "mb", "owner");
const merchantSession = (userId) => createSession({ userId, kind: "merchant", ttlMs: MERCHANT_SESSION_TTL_MS }).then((s) => s.token);
const adminToken = await merchantSession(member.id);
const otherAdminToken = await merchantSession(other.id);
const operator = await I.createOperator({ email: "op@x.test", password: "operator-pass-123" });
const { token: operatorToken } = await createSession({ userId: operator.id, kind: "operator", ttlMs: OPERATOR_SESSION_TTL_MS });

console.log("— anonymous and forged cookies");

await t("no cookies → curtain, carrying the configured message", () => curtained("ma", {}));
for (const value of ["x", "1", "true", "", "undefined", "null"]) {
  await t(`forged _admin=${JSON.stringify(value)} → curtain`, () => curtained("ma", { _admin: value }));
  await t(`forged _platform=${JSON.stringify(value)} → curtain`, () => curtained("ma", { _platform: value }));
  await t(`forged _mx=${JSON.stringify(value)} → curtain`, () => curtained("ma", { _mx: value }));
}
await t("all three forged together → curtain", () => curtained("ma", { _admin: "x", _platform: "x", _mx: "1" }));
await t("a well-formed _mx with a bad signature → curtain", () =>
  curtained("ma", { _mx: `m.${Math.floor(Date.now() / 1000) + 600}.${"0".repeat(64)}` }));
await t("hostile cookie values are denied, not thrown on", async () => {
  eq(await inTenant("ma", () => maintenanceBypass(jar({ _admin: "../../etc", _platform: "'; DROP TABLE users;--", _mx: "m.x.y" }))), false);
});

console.log("— genuine staff credentials");

await t("valid _admin (member session on this tenant) → real site", () => open("ma", { _admin: adminToken }));
await t("valid _platform (operator session) → real site", () => open("ma", { _platform: operatorToken }));
await t("valid _mx (issued to a verified session) → real site", async () => {
  const value = await inTenant("ma", () => issueMaintenancePass(jar({ _admin: adminToken })));
  eq(typeof value, "string", "pass issued:");
  await open("ma", { _mx: value });
});
await t("a valid credential beats a forged one sent beside it", () => open("ma", { _admin: adminToken, _platform: "x", _mx: "1" }));

console.log("— real values in the wrong place");

await t("a member of another tenant → curtain", () => curtained("ma", { _admin: otherAdminToken }));
await t("a merchant session in _platform → curtain", () => curtained("ma", { _platform: adminToken }));
await t("an operator session in _admin → curtain", () => curtained("ma", { _admin: operatorToken }));
await t("an _mx from another tenant → curtain", async () => {
  const value = await inTenant("mb", () => issueMaintenancePass(jar({ _admin: otherAdminToken })));
  await curtained("ma", { _mx: value });
});
await t("a session token in _mx → curtain", () => curtained("ma", { _mx: adminToken }));
await t("a revoked session → curtain", async () => {
  const token = await merchantSession(member.id);
  await open("ma", { _admin: token });
  await revokeSessionByToken(token);
  await curtained("ma", { _admin: token });
});
await t("an _mx verifies inside its TTL and not after it", async () => {
  const issuedAt = Date.now();
  const value = await inTenant("ma", () => issueMaintenancePass(jar({ _admin: adminToken }), { now: issuedAt }));
  const check = (now) => inTenant("ma", () => verifyMaintenancePass(value, { now }));
  eq(await check(issuedAt + (MAINTENANCE_PASS_TTL_S - 5) * 1000), true, "inside TTL:");
  eq(await check(issuedAt + (MAINTENANCE_PASS_TTL_S + 5) * 1000), false, "past TTL:");
});
await t("a tampered _mx expiry → rejected", async () => {
  const value = await inTenant("ma", () => issueMaintenancePass(jar({ _admin: adminToken })));
  const [m, exp, sig] = value.split(".");
  await curtained("ma", { _mx: `${m}.${Number(exp) + 86400}.${sig}` });
});

console.log("— who can get a pass");

await t("anonymous → no pass (the public sign-in link hands out nothing)", async () => {
  eq(await inTenant("ma", () => issueMaintenancePass(jar())), null);
});
await t("forged cookies → no pass", async () => {
  eq(await inTenant("ma", () => issueMaintenancePass(jar({ _admin: "x", _platform: "x", _mx: "1" }))), null);
});
await t("a pass cannot renew itself", async () => {
  const value = await inTenant("ma", () => issueMaintenancePass(jar({ _admin: adminToken })));
  eq(await inTenant("ma", () => issueMaintenancePass(jar({ _mx: value }))), null);
});
await t("a tenant with no order_link_secret issues no pass; its staff still pass by session", async () => {
  const { token } = await createSession({ userId: member.id, kind: "merchant", ttlMs: MERCHANT_SESSION_TTL_MS });
  await I.addMembership(member.id, "nosecret", "owner");
  eq(await inTenant("nosecret", () => issueMaintenancePass(jar({ _admin: token }))), null);
  await open("nosecret", { _admin: token });
});

console.log("— fail closed");

await t("bootstrap tenant (no members): the derived token passes", async () => {
  const token = await inTenant("boot", () => adminSessionToken());
  await open("boot", { _admin: token });
});
await t("a member-tenant's bootstrap token is dead once it has accounts", async () => {
  const token = await inTenant("ma", () => adminSessionToken());
  await curtained("ma", { _admin: token });
});
await t("control-plane lookup failure → curtain, even for a bootstrap token", async () => {
  const token = await inTenant("boot", () => adminSessionToken());
  await C.platformDb().execute("ALTER TABLE memberships RENAME TO memberships_gone");
  try {
    await curtained("boot", { _admin: token });
  } finally {
    await C.platformDb().execute("ALTER TABLE memberships_gone RENAME TO memberships");
  }
});
await t("operators exist → the shared bootstrap operator token is dead", async () => {
  await curtained("ma", { _platform: await platformSessionToken() });
});

console.log("— maintenance switched off");

await t("off → no curtain for anyone, forged cookies and no cookies alike", async () => {
  await C.patchTenant("ma", { config: { maintenance: null } });
  await open("ma", {});
  await open("ma", { _admin: "x", _platform: "x", _mx: "1" });
  await C.patchTenant("ma", { config: { maintenance: { enabled: false } } });
  await open("ma", {});
  await C.patchTenant("ma", { config: { maintenance: closed } });
  await curtained("ma", {});
});
await t("a maintenance switch on one tenant leaves another alone", async () => {
  await C.patchTenant("mb", { config: { maintenance: null } });
  await curtained("ma", {});
  await open("mb", {});
  await C.patchTenant("mb", { config: { maintenance: closed } });
});

console.log("— checkout stays closed for everyone");

await t("checkout is closed however valid the credential", async () => {
  await open("ma", { _admin: adminToken });
  const cap = await inTenant("ma", () => checkoutCapability());
  eq(cap.available, false);
  eq(cap.maintenance, true);
});

console.log("— legacy single-tenant mode (no PLATFORM_DB_URL)");

await t("forged cookies → no bypass; the derived tokens and a pass still work", async () => {
  const saved = process.env.PLATFORM_DB_URL;
  process.env.PLATFORM_DB_URL = "";
  try {
    const bypass = (cookies) => maintenanceBypass(jar(cookies));
    eq(await bypass({ _admin: "x", _platform: "x", _mx: "1" }), false, "forged:");
    const admin = await adminSessionToken();
    eq(await bypass({ _admin: admin }), true, "admin:");
    eq(await bypass({ _platform: await platformSessionToken() }), true, "operator:");
    const value = await issueMaintenancePass(jar({ _admin: admin }));
    eq(await bypass({ _mx: value }), true, "pass:");
  } finally {
    process.env.PLATFORM_DB_URL = saved;
  }
});

console.log("— every storefront data path is gated");

const walk = async (dir) => {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(rel)));
    else out.push(rel);
  }
  return out;
};
const source = (f) => readFile(join(root, f), "utf8");
// Pages with no tenant data: marketing-host pages (404 on a store), the
// catch-all 404, and the browser-side wishlist (its API is gated).
const NO_DATA_PAGES = ["pricing", "legal/[doc]", "verticals/[vertical]", "customers", "customers/[slug]", "integrations", "templates", "trust", "[...unmatched]", "wishlist"];

await t("storefront pages fetch through the gated tfetch only", async () => {
  const pages = (await walk("app/(storefront)")).filter((f) => f.endsWith("page.js"));
  eq(pages.length > 20, true, "found the pages:");
  for (const f of pages) {
    const src = await source(f);
    eq(/tenant-request|withTenant/.test(src), false, `${f} bypasses the gate:`);
    const name = f.replace("app/(storefront)/", "").replace(/\/?page\.js$/, "");
    if (!NO_DATA_PAGES.includes(name)) eq(src.includes('from "@/lib/storefront-request"'), true, `${f} not gated:`);
  }
});
await t("the no-data pages still read no catalog", async () => {
  for (const name of NO_DATA_PAGES) {
    const src = await source(`app/(storefront)/${name}/page.js`);
    eq(/@\/lib\/(db|repo|content\/|cms\/|cart|orders|wishlist)/.test(src), false, `${name} reads data:`);
  }
});
await t("the sitemap and every catalog-returning shopper API are gated", async () => {
  eq((await source("app/sitemap.js")).includes('from "@/lib/storefront-request"'), true, "sitemap:");
  for (const r of ["search", "wishlist", "upsell", "quiz/[slug]", "cart"]) {
    const src = await source(`app/api/${r}/route.js`);
    eq(src.includes("storefrontHandler(") && !src.includes("tenantHandler"), true, `/api/${r}:`);
  }
});
await t("webhooks, jobs and console APIs are NOT gated", async () => {
  const routes = (await walk("app/api")).filter((f) => /app\/api\/(razorpay|shopify|jobs|admin|platform|partners|connect)\//.test(f) && f.endsWith("route.js"));
  eq(routes.length > 20, true, "found the routes:");
  for (const f of routes) eq((await source(f)).includes("storefrontHandler"), false, `${f} gated:`);
});
await t("console pages keep the ungated tfetch (sign-in works during maintenance)", async () => {
  for (const f of (await walk("app/(console)")).filter((x) => x.endsWith(".js"))) {
    eq((await source(f)).includes("storefront-request"), false, `${f} gated:`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
