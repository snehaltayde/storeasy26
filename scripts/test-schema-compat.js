// MIG-05 suite: schema before code.
//   1. The deploy gate, `scripts/tenant-migrate.js --check`, run as the real CLI
//      against LOCAL FILE databases only: one tenant behind fails, every tenant
//      current passes, and the check writes nothing.
//   2. lib/schema-compat.js: a new column is detected once per database, never
//      with a PRAGMA and never per request, and each database answers for itself.
//   3. Cart, product page data, search and order creation against a tenant at
//      the older schema (OLDER_SCHEMA), side by side with a tenant at the current
//      schema. Cart and search go through their real API routes.
//   pnpm test:schema-compat
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// The tenant at the older schema stops here. Move it to the migration before
// yours when you add one that cart, product page, search or orders depend on.
const OLDER_SCHEMA = "0017_cms_approvals";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-compat-default.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TYPESENSE_HOST = "";
process.env.TYPESENSE_ADMIN_API_KEY = "";

const GATE_PLATFORM = ".test-compat-gate-platform.db";
const MAIN_PLATFORM = ".test-compat-platform.db";
const dbs = [
  ".test-compat-default.db",
  GATE_PLATFORM,
  MAIN_PLATFORM,
  ".test-compat-empty-platform.db",
  ".test-compat-bare-platform.db",
  ".test-compat-gate-a.db",
  ".test-compat-gate-b.db",
  ".test-compat-gate-c.db",
  ".test-compat-old.db",
  ".test-compat-cur.db",
  ".test-compat-spare.db",
];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

// Plain Node can't resolve the app's "@/…" alias or "next/headers" (next has no
// exports map), so the real routes and lib/content/resolve.js load through this.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db, libsql, currentDatabase } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { hasColumns, __schemaCompat } = await import("../lib/schema-compat.js");

const MIGRATIONS = await loadMigrations("tenant");
const NEWEST = MIGRATIONS[MIGRATIONS.length - 1].id;
const upTo = (id) => MIGRATIONS.filter((m) => m.id <= id);
const platformSchema = await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const same = (a, b, m = "") => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m}\n      older: ${A.slice(0, 400)}\n    current: ${B.slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function usePlatform(file) {
  process.env.PLATFORM_DB_URL = `file:${file}`;
  C.__resetPlatformClient();
  await C.migratePlatform(platformSchema);
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
}

// =============================================================================
// 1. The deploy gate: tenant-migrate.js --check, through the real CLI
// =============================================================================
console.log("— the deploy gate (--check), local file databases only");

function cli(args, platformFile = GATE_PLATFORM) {
  const r = spawnSync(process.execPath, ["scripts/tenant-migrate.js", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      PLATFORM_DB_URL: `file:${platformFile}`,
      PLATFORM_DB_TOKEN: "",
      PLATFORM_SECRET: process.env.PLATFORM_SECRET,
      TURSO_DB_URL: "",
      DATABASE_URL: "file:.test-compat-default.db",
    },
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "", stderr: r.stderr || "" };
}
const clientFor = (file) => createClient({ url: `file:${file}` });
async function ledger(file) {
  const c = clientFor(file);
  try {
    return (await c.execute("SELECT id, checksum FROM schema_migrations ORDER BY id")).rows.map((r) => `${r.id}:${r.checksum}`);
  } finally {
    c.close();
  }
}
async function tables(file) {
  const c = clientFor(file);
  try {
    return (await c.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")).rows.map((r) => `${r.type}:${r.name}:${r.sql}`);
  } finally {
    c.close();
  }
}
async function migrateFile(file, list) {
  const c = clientFor(file);
  try {
    await runMigrations(c, list);
  } finally {
    c.close();
  }
}
const auditRows = async () => Number((await C.platformDb().execute("SELECT COUNT(*) AS n FROM audit_log")).rows[0].n);

await usePlatform(GATE_PLATFORM);
await C.upsertTenant({ id: "ca", name: "Current store", dbUrl: "file:.test-compat-gate-a.db" });
await C.upsertTenant({ id: "cb", name: "Behind store", status: "suspended", dbUrl: "file:.test-compat-gate-b.db" });
await migrateFile(".test-compat-gate-a.db", MIGRATIONS);
await migrateFile(".test-compat-gate-b.db", MIGRATIONS.slice(0, -1));

await t(`one tenant behind (a suspended one): --check exits 1, names it and the missing ${NEWEST}`, async () => {
  const r = cli(["--check"]);
  eq(r.status, 1, `exit code (output: ${r.out.trim()}):`);
  ok(r.stderr.includes(`✗ cb: behind, missing ${NEWEST}`), `cb not named as behind:\n${r.out}`);
  ok(r.stdout.includes(`✓ ca: current, all ${MIGRATIONS.length} migrations up to ${NEWEST}`), `ca not shown current:\n${r.out}`);
  ok(r.stderr.includes("Do not deploy"), `no plain "do not deploy":\n${r.out}`);
  ok(!/Safe to deploy/.test(r.out), "said safe to deploy");
});

await t("--check writes nothing: ledgers, tables and the audit log are unchanged", async () => {
  const before = { b: await ledger(".test-compat-gate-b.db"), bt: await tables(".test-compat-gate-b.db"), at: await tables(".test-compat-gate-a.db"), audit: await auditRows() };
  const r = cli(["--check", "--all"]);
  eq(r.status, 1, "still behind:");
  same(await ledger(".test-compat-gate-b.db"), before.b, "cb ledger changed");
  same(await tables(".test-compat-gate-b.db"), before.bt, "cb tables changed");
  same(await tables(".test-compat-gate-a.db"), before.at, "ca tables changed");
  eq(await auditRows(), before.audit, "audit rows:");
});

await t("deploy order: migrate --all exits 0, then --check exits 0 and says it is safe", async () => {
  const m = cli(["--all"]);
  eq(m.status, 0, `migrate --all (output: ${m.out.trim()}):`);
  ok(m.stdout.includes(`✓ cb: 1 applied (${NEWEST})`), `cb not migrated:\n${m.out}`);
  const r = cli(["--check"]);
  eq(r.status, 0, `--check after migrating (output: ${r.out.trim()}):`);
  ok(r.stdout.includes(`✓ all 2 tenant(s) hold every migration up to ${NEWEST}. Safe to deploy.`), r.out);
});

// A store with no ledger at all, and one whose database can't be opened.
await C.upsertTenant({ id: "cc", name: "Never migrated", dbUrl: "file:.test-compat-gate-c.db" });
{
  const c = clientFor(".test-compat-gate-c.db");
  await c.execute("CREATE TABLE IF NOT EXISTS leftover (x TEXT)");
  c.close();
}

await t("a tenant with no ledger is behind on everything, and --check does not create one", async () => {
  const r = cli(["--check"]);
  eq(r.status, 1, "exit code:");
  ok(r.stderr.includes("✗ cc: behind, missing 0001_baseline, 0002_sync_runs"), r.out);
  ok(r.stderr.includes("✗ 1 of 3 tenant(s) not ready"), r.out);
  same(await tables(".test-compat-gate-c.db"), ["table:leftover:CREATE TABLE leftover (x TEXT)"], "cc gained tables");
});

await t("--check --tenant checks one store only", async () => {
  eq(cli(["--check", "--tenant", "ca"]).status, 0, "ca alone:");
  const r = cli(["--check", "--tenant", "cc"]);
  eq(r.status, 1, "cc alone:");
  ok(!r.out.includes("ca:"), "checked another store");
});

await t("a migration file edited after it ran fails the check", async () => {
  const c = clientFor(".test-compat-gate-a.db");
  const orig = (await c.execute("SELECT checksum FROM schema_migrations WHERE id = '0002_sync_runs'")).rows[0].checksum;
  await c.execute("UPDATE schema_migrations SET checksum = 'edited' WHERE id = '0002_sync_runs'");
  try {
    const r = cli(["--check", "--tenant", "ca"]);
    eq(r.status, 1, "exit code:");
    ok(r.stderr.includes("✗ ca: changed since it ran: 0002_sync_runs"), r.out);
  } finally {
    await c.execute({ sql: "UPDATE schema_migrations SET checksum = ? WHERE id = '0002_sync_runs'", args: [orig] });
    c.close();
  }
});

await t("a tenant whose database can't be read fails the check", async () => {
  await C.upsertTenant({ id: "cd", name: "Unreachable", dbUrl: "file:.test-compat-no-such-dir/x.db" });
  try {
    const r = cli(["--check", "--tenant", "cd"]);
    eq(r.status, 1, `exit code (output: ${r.out.trim()}):`);
    ok(r.stderr.includes("✗ cd: could not read its ledger"), r.out);
  } finally {
    await C.platformDb().execute("DELETE FROM tenants WHERE id = 'cd'");
  }
});

await t("a control plane with no tenants, or no tenants table, fails the check", async () => {
  await usePlatform(".test-compat-empty-platform.db");
  const r = cli(["--check"], ".test-compat-empty-platform.db");
  eq(r.status, 1, "empty control plane:");
  ok(r.stderr.includes("no tenants found"), r.out);
  const bare = clientFor(".test-compat-bare-platform.db");
  await bare.execute("CREATE TABLE IF NOT EXISTS unrelated (x TEXT)");
  bare.close();
  const r2 = cli(["--check"], ".test-compat-bare-platform.db");
  eq(r2.status, 1, "no tenants table:");
  ok(r2.stderr.includes("could not list tenants"), r2.out);
});

await t("without --all, --tenant or --check the CLI does nothing and says how to use it", async () => {
  const r = cli([]);
  eq(r.status, 1, "exit code:");
  ok(r.stderr.includes("--check [--tenant <slug>]"), r.out);
});

// =============================================================================
// Tenants for parts 2 and 3: one at OLDER_SCHEMA, one current, one scratch
// =============================================================================
await usePlatform(MAIN_PLATFORM);
for (const [id, file] of [
  ["old", ".test-compat-old.db"],
  ["cur", ".test-compat-cur.db"],
  ["spare", ".test-compat-spare.db"],
]) {
  await C.upsertTenant({ id, name: id.toUpperCase(), domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-secret` } });
}
const inT = async (id, fn) => withTenant(await C.getTenant(id), fn);
await inT("old", () => runMigrations(libsql, upTo(OLDER_SCHEMA)));
await inT("cur", () => runMigrations(libsql, MIGRATIONS));
await inT("spare", () => runMigrations(libsql, MIGRATIONS));

// Every statement sent to one database, for the "asked once, never a PRAGMA" checks.
function spyOn(inst) {
  const seen = [];
  const send = inst.libsql.execute;
  inst.libsql.execute = (stmt, ...rest) => {
    seen.push(typeof stmt === "string" ? stmt : stmt?.sql);
    return send(stmt, ...rest);
  };
  return { seen, stop: () => delete inst.libsql.execute };
}

// =============================================================================
// 2. lib/schema-compat.js
// =============================================================================
console.log("— optional columns, detected once per database");

await inT("cur", () => libsql.execute("CREATE TABLE compat_probe (id TEXT, added_later TEXT)"));
await inT("spare", () => libsql.execute("CREATE TABLE compat_probe (id TEXT)"));

await t("a present column: yes, asked once for 30 callers, with a SELECT and never a PRAGMA", async () => {
  __schemaCompat.forget();
  const inst = await inT("cur", () => currentDatabase());
  const spy = spyOn(inst);
  try {
    const first = await Promise.all(Array.from({ length: 20 }, () => inT("cur", () => hasColumns("order_items", ["title", "variant_title"]))));
    for (let i = 0; i < 10; i++) first.push(await inT("cur", () => hasColumns("order_items", ["title", "variant_title"])));
    ok(first.every((v) => v === true), `answers: ${first}`);
    same(spy.seen, ["SELECT title, variant_title FROM order_items LIMIT 0"], "statements sent");
  } finally {
    spy.stop();
  }
});

await t("an absent column: no, and callers inside the re-check window don't ask again", async () => {
  __schemaCompat.forget();
  const inst = await inT("spare", () => currentDatabase());
  const spy = spyOn(inst);
  try {
    eq(await inT("spare", () => hasColumns("compat_probe", ["id", "added_later"])), false, "first:");
    eq(await inT("spare", () => hasColumns("compat_probe", ["id", "added_later"])), false, "second:");
    eq(spy.seen.length, 1, `statements: ${JSON.stringify(spy.seen)}`);
    ok(!spy.seen.some((s) => /pragma/i.test(s)), "a PRAGMA was sent");
  } finally {
    spy.stop();
  }
});

await t("each database answers for itself", async () => {
  __schemaCompat.forget();
  eq(await inT("cur", () => hasColumns("compat_probe", ["added_later"])), true, "cur:");
  eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), false, "spare:");
  eq(await inT("cur", () => hasColumns("compat_probe", ["added_later"])), true, "cur again:");
});

await t("a column added while the instance is warm is used after the re-check window, then remembered", async () => {
  __schemaCompat.forget();
  __schemaCompat.setRecheckMs(80);
  try {
    eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), false, "before:");
    await inT("spare", () => libsql.execute("ALTER TABLE compat_probe ADD COLUMN added_later TEXT"));
    eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), false, "inside the window (remembered):");
    await sleep(120);
    eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), true, "after the window:");
    const spy = spyOn(await inT("spare", () => currentDatabase()));
    try {
      await sleep(120);
      eq(await inT("spare", () => hasColumns("compat_probe", ["added_later"])), true, "later:");
      eq(spy.seen.length, 0, "asked again after it was present:");
    } finally {
      spy.stop();
    }
  } finally {
    __schemaCompat.forget();
  }
});

await t("a probe that fails for another reason answers no for that call only, and is asked again", async () => {
  __schemaCompat.forget();
  const inst = await inT("cur", () => currentDatabase());
  const send = inst.libsql.execute;
  let calls = 0;
  inst.libsql.execute = (...a) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("SERVER_ERROR: database is locked"));
    return send(...a);
  };
  try {
    eq(await inT("cur", () => hasColumns("order_items", ["title"])), false, "during the failure:");
    eq(await inT("cur", () => hasColumns("order_items", ["title"])), true, "next call:");
    eq(calls, 2, "probes:");
  } finally {
    delete inst.libsql.execute;
  }
});

await t("only plain table and column names are accepted", async () => {
  for (const [table, cols] of [
    ["order_items; DROP TABLE orders", ["title"]],
    ["order_items", ["title, (SELECT 1)"]],
    ["order_items", []],
    ["Order_Items", ["title"]],
  ]) {
    let threw = false;
    try {
      await inT("cur", () => hasColumns(table, cols));
    } catch {
      threw = true;
    }
    ok(threw, `accepted ${table}(${cols})`);
  }
});

await t("lib/schema-compat.js is edge-safe: no node: imports, only ./db.js", async () => {
  const src = (await readFile(join(ROOT, "lib/schema-compat.js"), "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  same(imports, ["./db.js"], "imports");
  ok(!/\bnode:|\brequire\(|\bprocess\.|\bBuffer\b/.test(src), "uses a Node-only API");
});

// =============================================================================
// 3. Cart, product page data, search and order creation at the older schema
// =============================================================================
console.log(`— storefront and order paths: a tenant at ${OLDER_SCHEMA} next to one at ${NEWEST}`);
__schemaCompat.forget();

const P1 = "gid://shopify/Product/101";
const V1 = "gid://shopify/ProductVariant/1011";
const P2 = "gid://shopify/Product/102";
const V2 = "gid://shopify/ProductVariant/1021";
const TS = "2026-01-01T00:00:00.000Z";
async function seedCatalog() {
  const product = (id, handle, title, price) => ({ id, handle, title, description: `${title} for testing`, description_html: `<p>${title}</p>`, product_type: "Protein", vendor: "Test Labs", tags: JSON.stringify(["protein"]), price_min: price, price_max: price, compare_at_min: null, currency: "INR", available: 1, featured_image: `https://cdn.shopify.com/${handle}.png`, featured_image_alt: title, options: "[]", created_at: TS, updated_at: TS, synced_at: TS });
  await db.insertInto("products").values([product(P1, "whey-gold", "Whey Gold", 1000), product(P2, "steel-shaker", "Steel Shaker", 200)]).execute();
  await db
    .insertInto("variants")
    .values([
      { id: V1, product_id: P1, title: "1 kg", sku: "WG-1KG", price: 1000, currency: "INR", available: 1, selected_options: JSON.stringify([{ name: "Size", value: "1 kg" }]), position: 0 },
      { id: V2, product_id: P2, title: "Default Title", sku: "SH-750", price: 200, currency: "INR", available: 1, selected_options: "[]", position: 0 },
    ])
    .execute();
  await db.insertInto("product_images").values({ id: `${P1}::img::0`, product_id: P1, url: "https://cdn.shopify.com/whey-gold.png", alt: "Whey Gold", position: 0 }).execute();
  await db.insertInto("collections").values({ id: "gid://shopify/Collection/1", handle: "all", title: "All", updated_at: TS, synced_at: TS }).execute();
  await db
    .insertInto("collection_products")
    .values([
      { collection_id: "gid://shopify/Collection/1", product_id: P1, position: 0 },
      { collection_id: "gid://shopify/Collection/1", product_id: P2, position: 1 },
    ])
    .execute();
}
await inT("old", seedCatalog);
await inT("cur", seedCatalog);

const cartRoute = await import("../app/api/cart/route.js");
const searchRoute = await import("../app/api/search/route.js");
const { NextRequest } = await import("next/server.js");
const R = await import("../lib/content/resolve.js");
const { getProductByHandle } = await import("../lib/repo.js");
const { getCart } = await import("../lib/cart.js");
const { computeShipping } = await import("../lib/shipping.js");
const O = await import("../lib/orders.js");

await t(`the older tenant really is at ${OLDER_SCHEMA}, a migration this code ships`, async () => {
  ok(MIGRATIONS.some((m) => m.id === OLDER_SCHEMA), `${OLDER_SCHEMA} is not in migrations/tenant`);
  const ids = await inT("old", async () => (await libsql.execute("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id));
  eq(ids[ids.length - 1], OLDER_SCHEMA, "newest in its ledger:");
  const cur = await inT("cur", async () => (await libsql.execute("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1")).rows[0].id);
  eq(cur, NEWEST, "current tenant:");
});

// Cart through the real edge route: add, change quantity, add another, read.
async function cartJourney(host) {
  const call = async (method, body, cookie) => {
    const req = new NextRequest(`https://${host}/api/cart`, {
      method,
      headers: { host, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const res = await cartRoute[method](req);
    return { status: res.status, body: await res.json(), cookie: res.cookies.get("cart_session")?.value };
  };
  const add = await call("POST", { action: "add", variantId: V1, quantity: 1 });
  eq(add.status, 200, `${host} add:`);
  const cookie = `cart_session=${add.cookie}`;
  eq((await call("POST", { action: "setQty", variantId: V1, quantity: 3 }, cookie)).status, 200, `${host} setQty:`);
  eq((await call("POST", { action: "add", variantId: V2, quantity: 1 }, cookie)).status, 200, `${host} add 2:`);
  const read = await call("GET", null, cookie);
  eq(read.status, 200, `${host} read:`);
  return { cartId: add.cookie, cart: read.body };
}
const journeys = {};

await t("cart: add, change quantity and read through the real /api/cart route, the same on both schemas", async () => {
  journeys.old = await cartJourney("old.test");
  journeys.cur = await cartJourney("cur.test");
  const shape = (c) => ({ ...c, id: undefined });
  eq(journeys.old.cart.count, 4, "count:");
  eq(journeys.old.cart.subtotal, 3200, "subtotal:");
  same(shape(journeys.old.cart), shape(journeys.cur.cart), "carts differ");
});

const PAGE_LOADERS = ["getProductByHandle", "resolvedPdpExtras", "resolvedPdpPairs", "resolvedProductOverride", "resolvedSurfaceTemplateFor"];
const pageData = (handle) => async () => {
  const product = await getProductByHandle(handle);
  const [pairs, extras, override, surface] = await Promise.all([
    R.resolvedPdpPairs(product.id, { limit: 4 }),
    R.resolvedPdpExtras(),
    R.resolvedProductOverride(product.id),
    R.resolvedSurfaceTemplateFor("pdp", product.id),
  ]);
  return { product, pairs, extras, override, surface };
};

await t("product page data: every loader the page calls returns the same on both schemas", async () => {
  const src = await readFile(join(ROOT, "app/(storefront)/products/[handle]/page.js"), "utf8");
  const called = [...new Set([...src.matchAll(/\b(getProductByHandle|resolved\w+)\(/g)].map((m) => m[1]))].sort();
  same(called, PAGE_LOADERS, "the product page calls a loader this test does not run; add it to pageData()");
  const old = await inT("old", pageData("whey-gold"));
  const cur = await inT("cur", pageData("whey-gold"));
  eq(old.product.title, "Whey Gold", "title:");
  eq(old.product.variants[0].sku, "WG-1KG", "variant:");
  // getPdpPairs swallows errors into an empty list, so check it found the pair
  ok(old.pairs.products.some((p) => p.handle === "steel-shaker"), `pairs: ${JSON.stringify(old.pairs)}`);
  same(old, cur, "product page data differs");
});

await t("search: the real /api/search route finds the product on both schemas", async () => {
  const run = async (host) => {
    const res = await searchRoute.GET(new Request(`https://${host}/api/search?q=whey%20gold`, { headers: { host } }));
    eq(res.status, 200, `${host} status:`);
    return res.json();
  };
  const old = await run("old.test");
  const cur = await run("cur.test");
  eq(old.source, "database", "engine:");
  eq(old.hits[0]?.handle, "whey-gold", "first hit:");
  same(old, cur, "search differs");
});

const CONTACT = { email: "shopper@example.test", phone: "9000000001", name: "Compat Shopper" };
const ADDRESS = { line1: "1 Test Rd", city: "Pune", state: "MH", pincode: "411001", country: "India" };
let keySeq = 0;
// What the COD checkout route does with the cart: the authoritative server cart,
// shipping from the same pure engine, then createOrder.
async function placeOrder(cartId) {
  const cart = await getCart(cartId);
  const shipping = computeShipping({ subtotal: cart.subtotal, discountTotal: cart.discountTotal, paymentMethod: "cod", pincode: ADDRESS.pincode });
  const order = await O.createOrder({ cartId, cart, contact: CONTACT, address: ADDRESS, paymentMethod: "cod", idempotencyKey: `compat-${++keySeq}`, shipping });
  return O.getOrder(order.id);
}
const orderShape = (o) => ({
  status: o.status,
  total: o.total,
  subtotal: o.subtotal,
  items: o.items.map((i) => ({ variant_id: i.variant_id, product_id: i.product_id, title: i.title, quantity: i.quantity, line_total: i.line_total, is_gift: i.is_gift })),
  events: o.events.map((e) => [e.from_status, e.to_status]),
  snapshotItems: o.snapshot.items.map((i) => ({ variantId: i.variantId, title: i.title, quantity: i.quantity })),
});

await t("order creation: the checkout's createOrder saves the order, its lines and first event on both schemas", async () => {
  const old = await inT("old", () => placeOrder(journeys.old.cartId));
  const cur = await inT("cur", () => placeOrder(journeys.cur.cartId));
  eq(old.items.length, 2, "lines:");
  eq(old.status, "cod_pending", "status:");
  same(orderShape(old), orderShape(cur), "orders differ");
  // and the order moves on as usual
  const moved = await inT("old", () => O.beginShopifySync(old.id));
  eq(moved.status, "syncing_shopify", "transition at the older schema:");
});

// ---- OVL-06's columns (migration 0018) at the older schema ---------------------
const columnsOf = async (id, table) => inT(id, async () => (await libsql.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name));
const linesOf = async (id, orderId) => inT(id, async () => (await libsql.execute({ sql: "SELECT * FROM order_items WHERE order_id = ? ORDER BY position", args: [orderId] })).rows.map((r) => ({ ...r })));
const freshCart = async (id) =>
  inT(id, async () => {
    const { createCart, addItem } = await import("../lib/cart.js");
    const cartId = `compat-fresh-${++keySeq}`;
    await createCart(cartId);
    await addItem(cartId, V1, 1);
    return cartId;
  });

await t("older schema: the order's lines leave out catalog_title and sku, and its snapshot still has them", async () => {
  ok(!(await columnsOf("old", "order_items")).includes("catalog_title"), "the older tenant already has catalog_title");
  const order = await inT("old", async () => placeOrder(await freshCart("old")));
  const lines = await linesOf("old", order.id);
  ok(lines.length === 1 && !("catalog_title" in lines[0]) && !("sku" in lines[0]), `lines: ${JSON.stringify(lines)}`);
  same([order.snapshot.items[0].catalog_title, order.snapshot.items[0].sku], ["Whey Gold", "WG-1KG"], "snapshot");
});

await t("current schema: the order's lines carry catalog_title and sku", async () => {
  const order = await inT("cur", async () => placeOrder(await freshCart("cur")));
  const [line] = await linesOf("cur", order.id);
  same([line.catalog_title, line.sku], ["Whey Gold", "WG-1KG"], "line");
});

await t("orders ask about the columns once per database, never per order and never with a PRAGMA", async () => {
  __schemaCompat.forget();
  const spies = { old: spyOn(await inT("old", () => currentDatabase())), cur: spyOn(await inT("cur", () => currentDatabase())) };
  try {
    for (let i = 0; i < 3; i++) {
      for (const id of ["old", "cur"]) await inT(id, async () => placeOrder(await freshCart(id)));
    }
    for (const [id, spy] of Object.entries(spies)) {
      eq(spy.seen.filter((s) => /catalog_title/.test(s) && /^SELECT/.test(s)).length, 1, `${id} probes:`);
      ok(!spy.seen.some((s) => /pragma/i.test(s)), `${id} sent a PRAGMA`);
    }
  } finally {
    spies.old.stop();
    spies.cur.stop();
  }
});

await t("a tenant migrated while the instance is warm: orders get the columns once the re-check window passes", async () => {
  __schemaCompat.forget();
  __schemaCompat.setRecheckMs(80);
  try {
    const before = await inT("old", async () => placeOrder(await freshCart("old")));
    ok(!("catalog_title" in (await linesOf("old", before.id))[0]), "had the column before migrating");
    await inT("old", () => runMigrations(libsql, MIGRATIONS));
    const inside = await inT("old", async () => placeOrder(await freshCart("old")));
    eq((await linesOf("old", inside.id))[0].catalog_title, null, "inside the window, the column exists but is left out:");
    await sleep(120);
    const after = await inT("old", async () => placeOrder(await freshCart("old")));
    same([(await linesOf("old", after.id))[0].catalog_title, (await linesOf("old", after.id))[0].sku], ["Whey Gold", "WG-1KG"], "after the window");
  } finally {
    __schemaCompat.forget();
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
