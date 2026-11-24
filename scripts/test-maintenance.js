// Maintenance bypass suite: a cookie lifts the curtain only when its VALUE
// verifies for this tenant. Forged, cross-tenant, wrong-kind and expired values
// get the closed page; genuine staff keep the real site; checkout stays closed.
// Runs on Node against file DBs — this covers the decision logic and which files
// use the gate, NOT the edge runtime or real responses. For those, run
// `pnpm drill:maintenance-edge`.
//   pnpm test:maintenance
import { createHmac } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Next's bundler resolves these; plain Node needs the extension and the @/
// alias, so the suite can load lib/storefront-request.js and the routes.
registerHooks({
  resolve(specifier, context, next) {
    if (/^next\/(headers|navigation|server)$/.test(specifier)) return next(`${specifier}.js`, context);
    if (specifier.startsWith("@/")) {
      const file = join(root, specifier.slice(2));
      return next(pathToFileURL(file.endsWith(".js") ? file : `${file}.js`).href, context);
    }
    return next(specifier, context);
  },
});

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
const { maintenanceCurtain, maintenanceBypass, issueMaintenancePass, verifyMaintenancePass, curtainPalette, MAINTENANCE_PASS_TTL_S } = await import("../lib/maintenance.js");
const { storeCurtain, storefrontHandler } = await import("../lib/storefront-request.js");
const { validateBrand, resolveBrand, contrastRatio } = await import("../lib/brand.js");
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
// The parts of a NextRequest the handlers read.
const request = (host, cookies = {}) => ({ headers: new Headers({ host }), cookies: jar(cookies), url: `http://${host}/` });

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

console.log("— passes signed with the wrong key");

const forgePass = (tenant, key, exp = Math.floor(Date.now() / 1000) + 600) =>
  `m.${exp}.${createHmac("sha256", key).update(`${tenant}|${exp}`).digest("hex")}`;
await t("a pass made with the real key verifies (so the forgeries below are well formed)", () =>
  open("ma", { _mx: forgePass("ma", "ma-secret|maintenance-pass") }));
await t("a pass keyed on the bare order_link_secret → curtain (the pass key has its own purpose)", () =>
  curtained("ma", { _mx: forgePass("ma", "ma-secret") }));
for (const key of ["null", "undefined", "null|maintenance-pass", "undefined|maintenance-pass", "|maintenance-pass"]) {
  await t(`a tenant with no order_link_secret: a pass keyed "${key}" → curtain`, () =>
    curtained("nosecret", { _mx: forgePass("nosecret", key) }));
}

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

console.log("— the gated data path (lib/storefront-request.js)");

await t("storeCurtain fails closed when the cookie jar can't be read", async () => {
  // Outside a request, cookies() throws: that must count as "no credential".
  eq((await inTenant("ma", () => storeCurtain()))?.message, MESSAGE);
});
await t("storeCurtain on an open store → null, without reading cookies", async () => {
  await C.patchTenant("mb", { config: { maintenance: { enabled: false, message: "stale" } } });
  try {
    eq(await inTenant("mb", () => storeCurtain()), null);
  } finally {
    await C.patchTenant("mb", { config: { maintenance: closed } });
  }
});
const gatedApi = storefrontHandler(async () => Response.json({ ran: true }));
await t("storefrontHandler: anonymous, forged, other tenant → 503 STORE_MAINTENANCE, Retry-After, handler not run", async () => {
  for (const cookies of [{}, { _admin: "x", _platform: "x", _mx: "1" }, { _admin: otherAdminToken }]) {
    const res = await gatedApi(request("ma.test", cookies), {});
    eq(res.status, 503, `${JSON.stringify(cookies)}:`);
    const body = await res.json();
    eq(body.code, "STORE_MAINTENANCE");
    eq(body.ran, undefined);
    eq(res.headers.get("retry-after"), "300");
  }
});
await t("storefrontHandler: a staff session or pass → the handler runs", async () => {
  const value = await inTenant("ma", () => issueMaintenancePass(jar({ _admin: adminToken })));
  for (const cookies of [{ _admin: adminToken }, { _platform: operatorToken }, { _mx: value }]) {
    const res = await gatedApi(request("ma.test", cookies), {});
    eq((await res.json()).ran, true, `${Object.keys(cookies)}:`);
  }
});
await t("storefrontHandler: an open store → the handler runs for anyone", async () => {
  await C.patchTenant("mb", { config: { maintenance: null } });
  try {
    eq((await (await gatedApi(request("mb.test"), {})).json()).ran, true);
  } finally {
    await C.patchTenant("mb", { config: { maintenance: closed } });
  }
});

console.log("— the sign-in pass route and sign-out");

const passRoute = await import("../app/api/admin/maintenance-pass/route.js");
const passCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith("_mx=")) || "";
await t("pass route: everyone goes to /admin/login; anonymous, forged and other-tenant get no pass", async () => {
  for (const cookies of [{}, { _admin: "x", _platform: "x", _mx: "1" }, { _admin: otherAdminToken }]) {
    const res = await passRoute.GET(request("ma.test", cookies), {});
    eq(res.status, 302);
    eq(res.headers.get("location"), "http://ma.test/admin/login");
    eq(passCookie(res), "", `${JSON.stringify(cookies)} got a pass:`);
  }
});
await t("pass route: staff get a pass that verifies, HttpOnly, SameSite=Lax, Path=/, 15 minutes", async () => {
  const cookie = passCookie(await passRoute.GET(request("ma.test", { _admin: adminToken }), {}));
  for (const attr of ["httponly", "samesite=lax", "path=/", `max-age=${MAINTENANCE_PASS_TTL_S}`]) {
    eq(cookie.toLowerCase().includes(attr), true, `${attr} in ${cookie}:`);
  }
  eq(await inTenant("ma", () => verifyMaintenancePass(decodeURIComponent(cookie.split(";")[0].slice(4)))), true);
});
for (const kind of ["admin", "platform"]) {
  await t(`${kind} sign-out clears the pass`, async () => {
    const { POST } = await import(`../app/api/${kind}/logout/route.js`);
    const cookie = passCookie(await POST(request("ma.test", { _mx: "m.1.x" }), {}));
    eq(/max-age=0/i.test(cookie), true, `cleared: ${JSON.stringify(cookie)}`);
  });
}

console.log("— the closed page is readable on any brand");

await t("text tones reach 4.5:1 on the brand's own background", async () => {
  const brands = [
    { background: "#111827", foreground: "#f9fafb" },
    { background: "#fff1ee", foreground: "#1c1917" },
    { background: "#595959", foreground: "#ffffff" },
    { background: "#ffffff", foreground: "#767676" },
  ];
  let seed = 7;
  const hex = () => `#${Math.floor(((seed = (seed * 16807) % 2147483647) / 2147483647) * 0xffffff).toString(16).padStart(6, "0")}`;
  while (brands.length < 300) {
    const b = { background: hex(), foreground: hex(), accent: hex() };
    if (validateBrand(b).ok && contrastRatio(b.foreground, b.background) >= 4.5) brands.push(b);
  }
  for (const b of brands) {
    const p = curtainPalette(b);
    eq(p.background, resolveBrand(b).background, "follows the brand:");
    for (const tone of ["foreground", "muted"]) {
      eq(contrastRatio(p[tone], p.background) >= 4.5, true, `${tone} ${p[tone]} on ${p.background}:`);
    }
  }
});
await t("a missing or invalid brand → the default palette, still readable", async () => {
  for (const b of [null, {}, { background: "red" }, { background: "#777777", foreground: "#888888" }]) {
    const p = curtainPalette(b);
    eq(p.background, "#ffffff", `${JSON.stringify(b)}:`);
    eq(contrastRatio(p.muted, p.background) >= 4.5, true);
  }
});
await t("the muted tone is softer than the text where there is room", () => {
  const p = curtainPalette(null);
  eq(p.muted !== p.foreground && contrastRatio(p.muted, p.background) < contrastRatio(p.foreground, p.background), true);
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
  const routes = (await walk("app/api")).filter((f) => /app\/api\/(razorpay|shopify|jobs|admin|platform|connect)\//.test(f) && f.endsWith("route.js"));
  eq(routes.length > 20, true, "found the routes:");
  for (const f of routes) eq((await source(f)).includes("storefrontHandler"), false, `${f} gated:`);
});
await t("no storefront file sets an absolute title (it would skip the closed-store title)", async () => {
  for (const f of (await walk("app/(storefront)")).filter((x) => x.endsWith(".js"))) {
    // PUB-06 "Opening soon" (never-published store) intentionally overrides
    // maintenance; no normal page metadata may set an absolute title.
    const nonOpeningSoon = (await source(f)).split("\n").filter((line) => !line.includes("Opening soon")).join("\n");
    eq(/\babsolute\s*:/.test(nonOpeningSoon), false, `${f}:`);
  }
});
await t("the store 404 reloads once after a client-side click (an open tab's 404 is stale)", async () => {
  eq((await source("app/(storefront)/not-found.js")).includes("<ReloadOnSoftNotFound />"), true);
});
await t("console pages keep the ungated tfetch (sign-in works during maintenance)", async () => {
  for (const f of (await walk("app/(console)")).filter((x) => x.endsWith(".js"))) {
    eq((await source(f)).includes("storefront-request"), false, `${f} gated:`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
