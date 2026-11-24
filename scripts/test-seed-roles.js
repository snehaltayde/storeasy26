// One command seeds a store with every role (Phase 0 line 5).
//   pnpm test:seed-roles
// Seeds the roles store (scripts/seed-roles-store.js) into file: databases in
// a temp folder, then signs in as every role through the real login and
// account routes, and checks what each one sees. Then the refusals: a second
// seed, a seeded data folder, hosted database URLs, a running harness, real
// keys in the environment. Last, the roles harness profile
// (scripts/design-harness.js) runs in a temp root with stand-in sqld, seed and
// Next, and is shown never to touch a sibling .design-data/ folder, while the
// default profile still behaves as pnpm seed:design always has.
// Outside services are blanked and fetch() is blocked (the harness check
// allows loopback only). Nothing here touches the repo's own data folders.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const realFetch = globalThis.fetch;
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const fetchCalls = H.blockNetwork();
const blockedFetch = globalThis.fetch;
process.env.TURSO_DB_URL = "";
process.env.PLATFORM_SECRET = "test-platform-secret";

let pass = 0;
let fail = 0;
const realLog = console.log;
const realErr = console.error;
async function t(name, fn) {
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
    console.log = realLog;
    console.error = realErr;
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    console.log = realLog;
    console.error = realErr;
    fail++;
    console.error(`✗ ${name}\n    ${e?.stack?.split("\n").slice(0, 4).join("\n    ") || e}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg);
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
async function throwsLike(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    ok(re.test(String(e?.message || e)), `${msg}: wrong error: ${String(e?.message || e).slice(0, 300)}`);
    return e;
  }
  throw new Error(`${msg}: did not throw`);
}

const temps = [];
const tempDir = async (tag) => {
  const d = await mkdtemp(join(tmpdir(), `seed-roles-${tag}-`));
  temps.push(d);
  return d;
};
const urlsIn = (dir) => ({ platformUrl: `file:${join(dir, "platform.db")}`, tenantUrl: `file:${join(dir, "tenant.db")}`, defaultUrl: `file:${join(dir, "default.db")}` });

const R = await import("./seed-roles-store.js");
const Harness = await import("./design-harness.js");
const { createClient } = await import("@libsql/client");

// ---------------------------------------------------------------------------
// the seed
// ---------------------------------------------------------------------------
const dir = await tempDir("main");
const URLS = urlsIn(dir);
const summary = await R.seedRolesStore({ ...URLS, dataDir: dir, host: "roles.localhost" });
const seedFile = join(dir, R.ROLES_SEED_FILE);
const logins = JSON.parse(readFileSync(seedFile, "utf8"));
const HOST = "roles.localhost";
const member = (role) => logins.members.find((m) => m.role === role);

const C = await import("../lib/platform/control.js");
const tenant = await C.getTenant("roles", { fresh: true });
const { withTenant } = await import("../lib/tenant-context.js");
const { catalogFor } = await import("./support/tenant-fixture.js");
const { computeShipping } = await import("../lib/shipping.js");
const { totpCode } = await import("../lib/platform/identity.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const ROUTES = {
  "admin/login": await import("../app/api/admin/login/route.js"),
  "admin/settings": await import("../app/api/admin/settings/route.js"),
  "admin/orders": await import("../app/api/admin/orders/route.js"),
  "admin/orders/[id]": await import("../app/api/admin/orders/[id]/route.js"),
  "platform/login": await import("../app/api/platform/login/route.js"),
  account: await import("../app/api/account/route.js"),
};

async function call(route, method, { cookies = {}, body, query = "", params, path = route } = {}) {
  const headers = { host: HOST };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers.origin = `http://${HOST}`;
  }
  const jar = Object.entries(cookies).filter(([, v]) => v != null);
  if (jar.length) headers.cookie = jar.map(([k, v]) => `${k}=${v}`).join("; ");
  const req = new NextRequest(`http://${HOST}/api/${path}${query ? `?${query}` : ""}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const res = await ROUTES[route][method](req, { params: Promise.resolve(params ?? {}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text, setCookie: res.headers.getSetCookie() };
}
const cookieFrom = (r, name) => r.setCookie.map((c) => c.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find((v) => v) ?? null;
const rows = async (sql, args = [], url = URLS.tenantUrl) => {
  const c = createClient({ url });
  try {
    return (await c.execute({ sql, args })).rows.map((r) => ({ ...r }));
  } finally {
    c.close();
  }
};
const count = async (sql, url) => Number((await rows(sql, [], url))[0].n);

// 1 ---------------------------------------------------------------------------
await t("1. roles-seed.json is 0600 in a 0700 folder with all six identities; the summary carries no secret", async () => {
  eq(statSync(seedFile).mode & 0o777, 0o600, "file mode");
  eq(statSync(dir).mode & 0o777, 0o700, "folder mode");
  eq(logins.members.map((m) => m.role).join(","), "owner,admin,staff,support", "members");
  for (const m of logins.members) ok(m.email.endsWith("@roles.test") && m.password.length >= 12, `${m.role} login`);
  ok(logins.operator.email === "operator@roles.test" && logins.operator.password && logins.operator.totpSecret && logins.operator.otpauth.startsWith("otpauth://"), "operator login");
  ok(logins.shopper.email === "shopper@roles.test" && logins.shopper.orderId, "shopper identity");
  ok(logins.shopper.email !== "snehal@mediastic.in", "not the owner's test email");
  eq(new Set([...logins.members.map((m) => m.password), logins.operator.password]).size, 5, "distinct passwords");
  ok(logins.store.id === "roles" && logins.store.host === HOST && logins.store.url === "http://roles.localhost:3018" && logins.seededAt, "store and seed time");
  ok(logins.catalog.products === 4 && logins.catalog.collections >= 1 && logins.catalog.syncStatus === "complete", "catalog figures");
  const out = JSON.stringify(summary) + R.summaryLine(summary);
  for (const s of [...logins.members.map((m) => m.password), logins.operator.password, logins.operator.totpSecret, logins.operator.otpauth]) ok(!out.includes(s), "a secret is in the summary");
  ok(!/password|totp|otpauth|secret/i.test(out), `summary names a secret field: ${out.slice(0, 200)}`);
  ok(/^✓ roles store on http:\/\/roles\.localhost:3018: owner, admin, staff, support, 1 operator, shopper with order \S+ \(₹[\d,.]+, COD\), 4 products, sync complete\. Store is closed \(nothing published\)\. Logins: \.design-data-roles\/roles-seed\.json$/.test(R.summaryLine(summary)), R.summaryLine(summary));
});

// 2 ---------------------------------------------------------------------------
const adminCookie = {};
await t("2. every member signs in; owner and admin read settings, staff and support get 403; support reads orders; a wrong password is 401", async () => {
  for (const m of logins.members) {
    const r = await call("admin/login", "POST", { body: { email: m.email, password: m.password } });
    eq(r.status, 200, `${m.role} login (${r.text.slice(0, 120)})`);
    adminCookie[m.role] = cookieFrom(r, "_admin");
    ok(adminCookie[m.role], `${m.role} _admin cookie`);
  }
  for (const [role, want] of [["owner", 200], ["admin", 200], ["staff", 403], ["support", 403]]) {
    const r = await call("admin/settings", "GET", { cookies: { _admin: adminCookie[role] } });
    eq(r.status, want, `${role} settings GET`);
  }
  eq((await call("admin/orders", "GET", { cookies: { _admin: adminCookie.support } })).status, 200, "support orders GET");
  eq((await call("admin/login", "POST", { body: { email: member("owner").email, password: `${member("owner").password}x` } })).status, 401, "wrong password");
});

// 3 ---------------------------------------------------------------------------
await t("3. the operator signs in with password and a TOTP code; without a code it is 401", async () => {
  const none = await call("platform/login", "POST", { body: { email: logins.operator.email, password: logins.operator.password } });
  eq(none.status, 401, "no code");
  eq(none.body?.error, "Authenticator code required", "no-code message");
  const r = await call("platform/login", "POST", { body: { email: logins.operator.email, password: logins.operator.password, totp: totpCode(logins.operator.totpSecret) } });
  eq(r.status, 200, `operator login (${r.text.slice(0, 120)})`);
  ok(cookieFrom(r, "_platform"), "_platform cookie");
});

// 4 ---------------------------------------------------------------------------
let shopperCookie = null;
const fixture = catalogFor("few");
await t("4. the shopper signs in by email code and sees the order; its total is the fixture prices plus COD shipping", async () => {
  const req = await call("account", "POST", { body: { action: "request_otp", email: logins.shopper.email } });
  eq(req.status, 200, "request_otp");
  const code = await R.latestShopperCode({ tenantUrl: URLS.tenantUrl });
  ok(/^\d{6}$/.test(code?.code || ""), "a code in notifications");
  const v = await call("account", "POST", { body: { action: "verify", email: logins.shopper.email, code: code.code } });
  eq(v.status, 200, `verify (${v.text.slice(0, 120)})`);
  shopperCookie = cookieFrom(v, "_customer");
  ok(shopperCookie, "_customer cookie");
  const r = await call("account", "GET", { cookies: { _customer: shopperCookie }, query: "view=orders" });
  eq(r.status, 200, "orders view");
  const order = r.body.orders.find((o) => o.id === logins.shopper.orderId);
  ok(order, `order in the account (${r.text.slice(0, 200)})`);
  const price = (i) => Number(fixture.products[i].variants.nodes[0].price.amount);
  const goods = price(0) * 2 + price(1);
  const shipping = computeShipping({ subtotal: goods, paymentMethod: "cod", pincode: "411001" }).total;
  eq(Number(order.total), goods + shipping, "order total");
  eq(summary.shopper.subtotal, goods, "order subtotal = fixture prices");
  const items = await rows("SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY position", [logins.shopper.orderId]);
  eq(JSON.stringify(items.map((i) => [i.quantity, Number(i.unit_price)])), JSON.stringify([[2, price(0)], [1, price(1)]]), "order lines");
  const o = (await rows("SELECT customer_id, payment_method, status, city FROM orders WHERE id = ?", [logins.shopper.orderId]))[0];
  ok(o.customer_id === summary.shopper.customerId && o.payment_method === "cod" && o.status === "cod_pending" && o.city === "Pune", JSON.stringify(o));
});

// 5 ---------------------------------------------------------------------------
await t("5. signed out, the account answers authenticated:false and names no order", async () => {
  const r = await call("account", "GET", { query: "view=orders" });
  eq(r.status, 200, "status");
  eq(r.body?.authenticated, false, "authenticated");
  ok(!r.text.includes(logins.shopper.orderId), "order id in a signed-out answer");
});

// 6 ---------------------------------------------------------------------------
await t("6. support sees the order but not the shopper's email, phone or address; the owner sees them", async () => {
  const id = logins.shopper.orderId;
  const pii = [logins.shopper.email, "9800000001", "Koregaon"];
  for (const [path, opts] of [["admin/orders", {}], ["admin/orders/[id]", { params: { id }, path: `admin/orders/${id}` }]]) {
    const s = await call(path, "GET", { cookies: { _admin: adminCookie.support }, ...opts });
    eq(s.status, 200, `support ${path}`);
    ok(s.text.includes(id), `support ${path} has the order`);
    for (const p of pii) ok(!s.text.includes(p), `support ${path} shows ${p}`);
  }
  const o = await call("admin/orders/[id]", "GET", { cookies: { _admin: adminCookie.owner }, params: { id }, path: `admin/orders/${id}` });
  eq(o.status, 200, "owner order");
  for (const p of pii) ok(o.text.includes(p), `owner's order lacks ${p}`);
  const list = await call("admin/orders", "GET", { cookies: { _admin: adminCookie.owner } });
  ok(list.text.includes(id) && list.text.includes(logins.shopper.email), "owner's list has the order and email");
});

// 7 ---------------------------------------------------------------------------
await t("7. the latest sync run is complete, with the whole catalog and at least one collection, and confirmed", async () => {
  const run = (await rows("SELECT status, products, collections, finished_at FROM sync_runs ORDER BY started_at DESC LIMIT 1"))[0];
  ok(run && run.status === "complete" && run.finished_at, JSON.stringify(run));
  eq(Number(run.products), fixture.products.length, "run products");
  eq(await count("SELECT count(*) AS n FROM products"), fixture.products.length, "product rows");
  ok((await count("SELECT count(*) AS n FROM collections")) >= 1, "collections");
  const S = await import("../lib/sync.js");
  eq((await withTenant(tenant, () => S.confirmedCatalogSync())).confirmed, true, "confirmed");
});

// 8 ---------------------------------------------------------------------------
await t("8. documents mode, nothing published, one domain, one seed audit row with no password", async () => {
  eq((await rows("SELECT mode FROM cms_state WHERE id = 1"))[0]?.mode, "documents", "mode");
  eq((await rows("SELECT live_release_id FROM release_state WHERE id = 1"))[0]?.live_release_id ?? null, null, "live release");
  eq(await count("SELECT count(*) AS n FROM publish_log"), 0, "publish_log");
  eq(await count("SELECT count(*) AS n FROM releases"), 0, "releases");
  eq(JSON.stringify(tenant.domains), JSON.stringify([HOST]), "domains");
  const a = await rows("SELECT actor, actor_kind, tenant_id, diff FROM audit_log WHERE action = 'seed.roles_store'", [], URLS.platformUrl);
  eq(a.length, 1, "seed audit rows");
  ok(a[0].actor === "seed-roles" && a[0].actor_kind === "cli" && a[0].tenant_id === "roles", JSON.stringify(a[0]));
  const all = JSON.stringify(await rows("SELECT * FROM audit_log", [], URLS.platformUrl));
  for (const s of [...logins.members.map((m) => m.password), logins.operator.password, logins.operator.totpSecret]) ok(!all.includes(s), "a secret in audit_log");
  ok(!/password/i.test(a[0].diff || ""), "diff names a password");
});

// 9 ---------------------------------------------------------------------------
const snapshot = async () => ({
  platform: await rows("SELECT (SELECT count(*) FROM tenants) t, (SELECT count(*) FROM users) u, (SELECT count(*) FROM memberships) m, (SELECT count(*) FROM audit_log) a", [], URLS.platformUrl),
  store: await rows("SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM orders) o, (SELECT count(*) FROM customers) c, (SELECT count(*) FROM sync_runs) s"),
  file: R.fileHash(seedFile),
});
await t("9. a second seed on the same databases refuses with 'already holds a store' and changes nothing", async () => {
  const before = JSON.stringify(await snapshot());
  await throwsLike(() => R.seedRolesStore({ ...URLS, dataDir: dir }), /already holds a store/, "same folder");
  const other = await tempDir("rerun");
  await throwsLike(() => R.seedRolesStore({ ...URLS, dataDir: other }), /already holds a store/, "same databases, new folder");
  eq(readdirSync(other).length, 0, "new folder stays empty");
  eq(JSON.stringify(await snapshot()), before, "rows and file");
});

// 10 --------------------------------------------------------------------------
await t("10. assertFreshDataDir refuses a seeded folder; with reset it returns a plan and deletes nothing", async () => {
  await throwsLike(() => R.assertFreshDataDir(dir), /already holds a store's data/, "seeded folder");
  const plan = R.assertFreshDataDir(dir, { reset: true });
  eq(plan.reset, true, "reset plan");
  eq(plan.dir, dir, "plan folder");
  ok(existsSync(seedFile), "nothing deleted");
  const fresh = await tempDir("fresh");
  eq(R.assertFreshDataDir(fresh).reset, false, "empty folder");
  eq(R.assertFreshDataDir(join(fresh, "missing")).holdsData, false, "missing folder");
});

// 11 --------------------------------------------------------------------------
await t("11. hosted or remote database URLs are refused for the platform and the store; nothing is written", async () => {
  for (const bad of ["libsql://x.turso.io", "https://x", "wss://x", "http://10.0.0.5:8080", "file://host/x", "http://localhost:8080\\@evil.com:443/", "http://127.0.0.1:1\\@10.0.0.5:8080", "http://user@127.0.0.1:8080", "http://127.0.0.1:8080/x", "http://127.0.0.1:80 80", "file:/tmp/a\nb.db", "http://127.0.0.1"]) {
    for (const which of ["platformUrl", "tenantUrl"]) {
      const d = await tempDir("url");
      await throwsLike(() => R.seedRolesStore({ ...urlsIn(d), [which]: bad, dataDir: d }), /must be a local database/, `${which} ${bad}`);
      eq(readdirSync(d).length, 0, `${which} ${bad}: folder not empty`);
    }
  }
  for (const [good, want] of [["file:/tmp/x.db", "file:/tmp/x.db"], ["file:relative.db", "file:relative.db"], ["file:///tmp/x.db", "file:/tmp/x.db"], ["http://127.0.0.1:18027", "http://127.0.0.1:18027"], ["http://localhost:18028/", "http://localhost:18028"], ["http://[::1]:18029", "http://[::1]:18029"]]) eq(R.assertSeedDbUrl("u", good), want, good);
  // the same checks guard the read-only code lookup
  await throwsLike(() => R.latestShopperCode({ tenantUrl: "http://localhost:8080\\@evil.com:443/" }), /must be a local database/, "latestShopperCode");
});

// 12 --------------------------------------------------------------------------
await t("12. a running harness (either folder) is refused; the stand-in is stopped by its own handle", async () => {
  const root = await tempDir("running");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},3e4)", "dev-design.js"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    for (const name of [".design-data", R.ROLES_DATA_DIR_NAME]) {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      Harness.writePidfile(d, { launcher: { ...Harness.processStamp(child.pid), script: "dev-design.js" } });
      await throwsLike(() => R.assertNoHarnessRunning(root), new RegExp(`using ${name.replace(".", "\\.")}/ is running`), name);
      await rm(d, { recursive: true, force: true });
    }
    R.assertNoHarnessRunning(root); // nothing running now
    const d = join(root, ".design-data");
    mkdirSync(d);
    Harness.writePidfile(d, { launcher: { ...Harness.processStamp(child.pid), script: "dev-design.js" } });
    await throwsLike(
      () => Harness.runHarness({ mode: "seed", root, env: { ...process.env, SQLD_BIN: process.execPath }, log: () => {}, profile: R.ROLES_PROFILE, seedCmd: [process.execPath, ["-e", "process.exit(1)"]] }),
      /\.design-data\/ is running/,
      "runHarness with the roles profile",
    );
    ok(!existsSync(join(root, R.ROLES_DATA_DIR_NAME)), "roles folder made while refused");
  } finally {
    child.kill();
  }
});

// 13 --------------------------------------------------------------------------
await t("13. a Shopify or payment key, or a Turso URL, in the environment is refused before anything is written", async () => {
  for (const [k, v] of [["SHOPIFY_STORE_DOMAIN", "x.myshopify.com"], ["SHOPIFY_ADMIN_TOKEN", "shpat_x"], ["RAZORPAY_KEY_SECRET", "rzp_x"], ["RAZORPAY_KEY_ID", "rzp_test_x"], ["TURSO_DB_URL", "libsql://x.turso.io"]]) {
    const d = await tempDir("env");
    const was = process.env[k];
    process.env[k] = v;
    try {
      await throwsLike(() => R.seedRolesStore({ ...urlsIn(d), dataDir: d }), /Refusing to seed/, k);
    } finally {
      process.env[k] = was ?? "";
    }
    eq(readdirSync(d).length, 0, `${k}: folder not empty`);
  }
});

// 14 --------------------------------------------------------------------------
await t("14. .design-data-roles/ is gitignored", async () => {
  execFileSync("git", ["check-ignore", "-q", ".design-data-roles/x"], { cwd: ROOT });
  execFileSync("git", ["check-ignore", "-q", `.design-data-roles/${R.ROLES_SEED_FILE}`], { cwd: ROOT });
});

// 15 --------------------------------------------------------------------------
// A stand-in sqld: answers /health on its --http-listen-addr and makes its
// --db-path folder, as sqld does. Stopped by the harness through its handle.
function standInSqld(binDir) {
  const bin = join(binDir, "sqld");
  writeFileSync(
    bin,
    `#!${process.execPath}
const a = process.argv.slice(2);
const [host, port] = a[a.indexOf("--http-listen-addr") + 1].split(":");
require("node:fs").mkdirSync(a[a.indexOf("--db-path") + 1], { recursive: true });
require("node:http").createServer((q, s) => { s.writeHead(200); s.end("ok"); }).listen(Number(port), host);
process.on("SIGTERM", () => process.exit(0));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
// Every file under a folder with its bytes' hash and mtime.
function tree(d) {
  const out = {};
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else out[relative(d, f)] = `${createHash("sha256").update(readFileSync(f)).digest("hex")}:${statSync(f).mtimeMs}`;
    }
  };
  walk(d);
  return out;
}
// The stand-in seed: records what it was handed, in the folder it was meant for.
const standInSeed = (folder) => [
  process.execPath,
  [
    "-e",
    `const fs=require("node:fs");const e=process.env;const ok=[e.PLATFORM_DB_URL,e.DESIGN_TENANT_DB_URL,e.DATABASE_URL].every(u=>/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(u||""));if(!ok)process.exit(3);fs.mkdirSync(${JSON.stringify(folder)},{recursive:true});fs.writeFileSync(${JSON.stringify(folder)}+"/stand-in-seed.json",JSON.stringify({cwd:process.cwd(),site:e.NEXT_PUBLIC_SITE_URL,designPassword:Boolean(e.DESIGN_ADMIN_PASSWORD),urls:[e.PLATFORM_DB_URL,e.DESIGN_TENANT_DB_URL,e.DATABASE_URL]}))`,
  ],
];

await t("15. the roles profile never touches a sibling .design-data/; the default profile still seeds the design harness as before", async () => {
  const root = await tempDir("harness");
  const sqldBin = standInSqld(await tempDir("bin"));
  // loopback only, for the harness's health checks
  globalThis.fetch = (u, o) => (/^http:\/\/127\.0\.0\.1:\d+\//.test(String(u)) ? realFetch(u, o) : blockedFetch(u, o));
  try {
    // the owner's design data, as a stand-in
    const design = join(root, ".design-data");
    mkdirSync(join(design, "platform.sqld"), { recursive: true });
    writeFileSync(join(design, "seeded.json"), JSON.stringify({ at: "2026-01-01T00:00:00Z" }));
    writeFileSync(join(design, "platform.sqld", "data"), "owner data");
    writeFileSync(join(root, ".design-env"), "DESIGN_ADMIN_PASSWORD=x\n");
    const before = JSON.stringify(tree(design)) + R.fileHash(join(root, ".design-env"));
    const env = { ...process.env, SQLD_BIN: sqldBin, ROLES_PORT: "3958", ROLES_SQLD_PORT: "18957" };
    const roles = join(root, R.ROLES_DATA_DIR_NAME);
    const logs = [];
    const run = (o) => Harness.runHarness({ root, env, log: (l) => logs.push(l), profile: R.ROLES_PROFILE, seedCmd: standInSeed(roles), nextCmd: [process.execPath, ["-e", "process.exit(0)"]], repoint: async (urls, id) => logs.push(`repoint ${id} ${urls.tenant}`), ...o });

    // a seed that fails partway still leaves a 0700 folder, and that data is kept
    await throwsLike(() => run({ mode: "seed", seedCmd: [process.execPath, ["-e", "process.exit(1)"]] }), /Seeding failed.*is kept/s, "failing roles seed");
    eq(statSync(roles).mode & 0o777, 0o700, "roles folder mode after a failed seed");
    // a refused dev:roles (data, but no seeded.json) changes nothing, not even a stale pid file
    Harness.writePidfile(roles, { launcher: { pid: 999999, started: "gone" } });
    const partial = JSON.stringify(tree(roles));
    await throwsLike(() => run({ mode: "dev" }), /already holds data, and this seed never deletes it/, "dev on partial data");
    eq(JSON.stringify(tree(roles)), partial, "refused dev:roles changed the folder");
    eq(await run({ mode: "seed", reset: true }), 0, "roles seed");
    eq(statSync(roles).mode & 0o777, 0o700, "roles folder mode");
    const handed = JSON.parse(readFileSync(join(roles, "stand-in-seed.json"), "utf8"));
    eq(realpathSync(handed.cwd), realpathSync(root), "seed cwd");
    eq(handed.site, "http://roles.localhost:3958", "site url");
    eq(handed.designPassword, false, "design credentials handed to the roles seed");
    eq(handed.urls.join(","), "http://127.0.0.1:18957,http://127.0.0.1:18958,http://127.0.0.1:18959", "roles ports");
    ok(existsSync(join(roles, "seeded.json")) && existsSync(join(roles, "tenant.sqld")), "roles data in its own folder");
    const seeded = JSON.stringify(tree(roles));
    await throwsLike(() => run({ mode: "seed" }), /already holds data, and this seed never deletes it/, "second roles seed");
    eq(JSON.stringify(tree(roles)), seeded, "roles data kept on a refused seed");
    eq(await run({ mode: "dev" }), 0, "roles dev");
    ok(logs.includes("repoint roles http://127.0.0.1:18958"), "repoint names the roles tenant");
    ok(logs.some((l) => l.includes("http://roles.localhost:3958") && l.includes(".design-data-roles/roles-seed.json")), "dev line names the roles store and logins");
    ok(!logs.some((l) => /seed:design|dev:design/.test(l)), "a roles message names a design command");
    eq(await run({ mode: "seed", reset: true }), 0, "roles seed --reset");
    await throwsLike(() => Harness.runHarness({ mode: "seed", root, env, log: () => {}, reset: true }), /reset only applies/, "reset on the design profile");
    eq(JSON.stringify(tree(design)) + R.fileHash(join(root, ".design-env")), before, ".design-data/ or .design-env changed by the roles profile");

    // the default profile: today's ports, env, folder, credentials and messages
    eq(JSON.stringify(Harness.harnessPorts({})), JSON.stringify({ next: 3017, sqld: { platform: 18017, tenant: 18018, default: 18019 } }), "default ports");
    eq(Harness.harnessEnv({}, {}, Harness.harnessPorts({})).NEXT_PUBLIC_SITE_URL, "http://localhost:3017", "default site url");
    const droot = await tempDir("design");
    mkdirSync(join(droot, ".design-data"));
    writeFileSync(join(droot, ".design-data", "old.txt"), "wiped by seed:design");
    const dlogs = [];
    const denv = { ...process.env, SQLD_BIN: sqldBin, DESIGN_PORT: "3967", DESIGN_SQLD_PORT: "18967" };
    eq(await Harness.runHarness({ mode: "seed", root: droot, env: denv, log: (l) => dlogs.push(l), seedCmd: standInSeed(join(droot, ".design-data")) }), 0, "design seed");
    ok(!existsSync(join(droot, ".design-data", "old.txt")), "seed:design still starts from a fresh .design-data/");
    ok(existsSync(join(droot, ".design-env")), "seed:design still generates .design-env");
    const dh = JSON.parse(readFileSync(join(droot, ".design-data", "stand-in-seed.json"), "utf8"));
    ok(dh.designPassword && dh.site === "http://localhost:3967", JSON.stringify(dh));
    ok(dlogs.includes("• seeding the design store over http (databases on ports 18967, 18968, 18969)"), dlogs.join(" | "));
    ok(dlogs.includes("✓ design harness seeded. Start it with pnpm dev:design (http://localhost:3967)."), dlogs.join(" | "));
    ok(!existsSync(join(droot, R.ROLES_DATA_DIR_NAME)), "the design profile made a roles folder");
  } finally {
    globalThis.fetch = blockedFetch;
  }
});

// 16 --------------------------------------------------------------------------
// The real entry, `node scripts/dev-roles.js seed`, run from a temp root: the
// cwd decides where the data goes, the CLI's pre-checks run, and the real
// seed child writes over real local sqld when it is installed (the same
// harness as pnpm seed:roles, on other ports). Only <temp>/.design-data-roles
// appears. Without sqld, the CLI must refuse and create nothing.
const runCli = (cwd, args, env) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts/dev-roles.js"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
await t("16. the real dev-roles.js entry, run from a temp root, creates only <temp>/.design-data-roles", async () => {
  const root = await tempDir("cli");
  const env = { ...process.env, ROLES_PORT: "3978", ROLES_SQLD_PORT: "18977" };
  let sqld = null;
  try {
    sqld = Harness.findSqld({ env });
  } catch {
    // not installed
  }
  const r = await runCli(root, ["seed"], env);
  if (!sqld) {
    eq(r.code, 1, `no sqld: exit (${r.out})`);
    eq(readdirSync(root).length, 0, "no sqld: something was created");
    return;
  }
  eq(r.code, 0, `seed exit (${r.out.slice(-600)})`);
  eq(readdirSync(root).join(","), R.ROLES_DATA_DIR_NAME, "what the seed created in the root");
  const file = join(root, R.ROLES_DATA_DIR_NAME, R.ROLES_SEED_FILE);
  eq(statSync(file).mode & 0o777, 0o600, "logins file mode");
  eq(statSync(join(root, R.ROLES_DATA_DIR_NAME)).mode & 0o777, 0o700, "data folder mode");
  const l = JSON.parse(readFileSync(file, "utf8"));
  ok(/✓ roles store on http:\/\/roles\.localhost:3978: owner, admin, staff, support, 1 operator, shopper with order \S+ \(₹[\d,.]+, COD\), 4 products, sync complete\./.test(r.out), r.out.slice(-400));
  for (const s of [...l.members.map((m) => m.password), l.operator.password, l.operator.totpSecret]) ok(!r.out.includes(s), "a secret was printed");
  const again = await runCli(root, ["seed"], env);
  eq(again.code, 1, "second seed exit");
  ok(/already holds a store's data/.test(again.out), again.out);
  const bad = await runCli(root, ["seed", "--reset", "--x"], env);
  eq(bad.code, 2, "unknown option exit");
  ok(bad.out.includes('Unknown option "--x"'), bad.out);
  eq(readdirSync(root).join(","), R.ROLES_DATA_DIR_NAME, "root after the refusals");
});

await t("no network: nothing reached fetch() outside loopback", async () => {
  eq(fetchCalls.length, 0, `fetch calls: ${fetchCalls.join(", ")}`);
});

C.__resetPlatformClient();
for (const d of temps) await rm(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
