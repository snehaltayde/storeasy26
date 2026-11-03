// GEN-02 suite: an honest first sync. A fake Shopify answers every Admin and
// Storefront query the real fetchers send (no network: anything else throws),
// and a simulated clock lets each Shopify page "take" seconds, so the 60-second
// route limit is real here: an invocation that runs past it is killed mid-page,
// the way the platform ends a function, and whatever it hadn't committed is
// gone. Everything else is the real code path: the connect callback, the
// console route, the tick route, the scheduled and operator routes, the worker,
// the queue and real tenant databases.
//   pnpm test:first-sync
import { readFile, rm } from "node:fs/promises";
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);

// next/server: the real NextResponse, with after() captured, so the suite
// decides when deferred work runs and can kill it with its invocation.
globalThis.__fsyncNext = require("next/server.js");
globalThis.__fsyncAfter = [];
const NEXT_SERVER_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "const n = globalThis.__fsyncNext; export const NextResponse = n.NextResponse; export const NextRequest = n.NextRequest; export const after = (fn) => { globalThis.__fsyncAfter.push(fn); };",
  );
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/server") return { url: NEXT_SERVER_STUB, shortCircuit: true };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(root, spec.endsWith(".js") ? spec.slice(2) : `${spec.slice(2)}.js`)).href, ctx);
    if (/^next\/(headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

Object.assign(process.env, {
  TURSO_DB_URL: "",
  TURSO_DB_AUTH_TOKEN: "",
  DATABASE_URL: "file:.test-fsync-default.db",
  PLATFORM_DB_URL: "file:.test-fsync-platform.db",
  PLATFORM_DB_TOKEN: "",
  PLATFORM_SECRET: "test-platform-secret",
  PLATFORM_CACHE_MS: "50",
  PLATFORM_ADMIN_PASSWORD: "operator-test-pw",
  ALERT_WEBHOOK_URL: "",
  CRON_SECRET: "",
  PLATFORM_URL: "",
  RATE_LIMIT_DISABLED: "1",
});
for (const k of ["TYPESENSE_HOST", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "SHOPIFY_STOREFRONT_TOKEN", "SHOPIFY_STOREFRONT_PRIVATE_TOKEN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "ADMIN_PASSWORD"]) {
  delete process.env[k];
}

const TENANTS = ["connect", "kill", "fail", "prune", "write", "gen", "callers", "cli", "nocreds", "deny"];
const dbs = [".test-fsync-default.db", ".test-fsync-platform.db", ...TENANTS.map((t) => `.test-fsync-${t}.db`)];
for (const f of dbs) await rm(join(root, f), { force: true });

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const J = await import("../lib/platform/jobs.js");
const W = await import("../lib/platform/worker.js");
const S = await import("../lib/sync.js");
const O = await import("../lib/platform/oauth.js");
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db, libsql } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { applyTenantSchema } = await import("../lib/platform/provision.js");
const { platformSessionToken } = await import("../lib/platform/admin-auth.js");
const adminSync = await import("../app/api/admin/sync/route.js");
const callback = await import("../app/api/connect/shopify/callback/route.js");
const tickRoute = await import("../app/api/jobs/tick/route.js");
const scheduled = await import("../app/api/jobs/sync-catalog/route.js");
const operator = await import("../app/api/platform/tenants/[id]/route.js");
const optional = async (p) => {
  try {
    return await import(p);
  } catch {
    return null;
  }
};
const V = await optional("../lib/admin/sync-view.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const quiet = async (fn) => {
  const [err, log] = [console.error, console.log];
  console.error = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
    console.log = log;
  }
};

// --- simulated time and the 60-second route limit -------------------------------
const clock = { t: Date.parse("2026-11-03T10:00:00.000Z"), now: () => clock.t };
if (W.workerClock) W.workerClock.now = clock.now;
const ROUTE_LIMIT_MS = 60_000;
let invocation = null;
const invocations = [];

async function drainAfter() {
  while (globalThis.__fsyncAfter.length) await globalThis.__fsyncAfter.shift()();
}

// One function invocation: the handler, then its after() work, all inside the
// route limit. A kill abandons the rest, exactly like the platform would.
async function invoke(label, fn) {
  let kill;
  const killed = new Promise((r) => (kill = r));
  invocation = { label, start: clock.t, kill: () => kill({ killed: true }) };
  try {
    const out = await Promise.race([
      (async () => {
        const value = await fn();
        await drainAfter();
        return { value };
      })(),
      killed,
    ]);
    invocations.push({ label, ms: clock.t - invocation.start, killed: Boolean(out.killed) });
    return out;
  } finally {
    invocation = null;
    globalThis.__fsyncAfter.length = 0;
  }
}

// --- the fake Shopify -------------------------------------------------------------
const SHOP = "fsync-test.myshopify.com";
const shop = { products: [], collections: [], pageMs: 0, calls: [], fault: null };
const enc = (i) => Buffer.from(`at:${i}`).toString("base64");
const dec = (c) => (c ? Number(Buffer.from(c, "base64").toString().slice(3)) : 0);
function pageOf(list, cursor, size) {
  const start = dec(cursor);
  const nodes = list.slice(start, start + size);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < list.length, endCursor: nodes.length ? enc(end) : null } };
}
const pid = (i) => `gid://shopify/Product/${100000 + i}`;
function mkProduct(i, { variants = (i % 3) + 1, images = (i % 2) + 1, handle = `item-${i}`, title = `Item ${i}` } = {}) {
  return {
    id: pid(i),
    handle,
    title,
    variants: Array.from({ length: variants }, (_, k) => ({ id: `gid://shopify/ProductVariant/${(100000 + i) * 1000 + k}`, title: `Size ${k + 1}` })),
    images: Array.from({ length: images }, (_, k) => `https://cdn.fsync.test/${i}/${k}.jpg`),
  };
}
const mkCollection = (j, members) => ({ id: `gid://shopify/Collection/${5000 + j}`, handle: `group-${j}`, title: `Group ${j}`, members });
const adminVariants = (p, cursor, size) => {
  const pg = pageOf(p.variants, cursor, size);
  return {
    pageInfo: pg.pageInfo,
    nodes: pg.nodes.map((v) => ({ id: v.id, title: v.title, sku: `${v.id}-sku`, price: "499.00", compareAtPrice: null, availableForSale: true, inventoryQuantity: 4, selectedOptions: [{ name: "Size", value: v.title }], image: null })),
  };
};
const money = { amount: "499.00", currencyCode: "INR" };
const adminProduct = (p) => ({
  id: p.id,
  handle: p.handle,
  title: p.title,
  description: `About ${p.title}`,
  descriptionHtml: `<p>About ${p.title}</p>`,
  productType: "Goods",
  vendor: "Test Maker",
  tags: ["test"],
  totalInventory: 4,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  priceRangeV2: { minVariantPrice: money, maxVariantPrice: money },
  featuredImage: p.images[0] ? { url: p.images[0], altText: null } : null,
  images: { nodes: p.images.map((url) => ({ url, altText: null, width: 800, height: 800 })) },
  options: [{ name: "Size", optionValues: p.variants.map((v) => ({ name: v.title })) }],
  variants: adminVariants(p, null, 50),
});
const storefrontProduct = (p) => ({
  id: p.id,
  handle: p.handle,
  title: p.title,
  description: `About ${p.title}`,
  descriptionHtml: `<p>About ${p.title}</p>`,
  productType: "Goods",
  vendor: "Test Maker",
  tags: ["test"],
  totalInventory: 4,
  availableForSale: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  priceRange: { minVariantPrice: money, maxVariantPrice: money },
  compareAtPriceRange: { minVariantPrice: { amount: "0.0", currencyCode: "INR" } },
  featuredImage: p.images[0] ? { url: p.images[0], altText: null } : null,
  images: { nodes: p.images.map((url) => ({ url, altText: null, width: 800, height: 800 })) },
  options: [{ name: "Size", values: p.variants.map((v) => v.title) }],
  variants: { nodes: p.variants.map((v) => ({ id: v.id, title: v.title, sku: `${v.id}-sku`, availableForSale: true, price: money, compareAtPrice: null, selectedOptions: [{ name: "Size", value: v.title }], image: null })) },
});
const adminCollection = (c) => ({
  id: c.id,
  handle: c.handle,
  title: c.title,
  description: "",
  updatedAt: "2026-10-01T00:00:00Z",
  image: null,
  products: pageOf(c.members.map((id) => ({ id })), null, 250),
});

function answer(op, v) {
  switch (op) {
    case "AdminProducts": {
      const pg = pageOf(shop.products, v.cursor, 30);
      return { products: { pageInfo: pg.pageInfo, nodes: pg.nodes.map(adminProduct) } };
    }
    case "ProductVariants": {
      const p = shop.products.find((x) => x.id === v.id);
      return { product: p ? { variants: adminVariants(p, v.cursor, 100) } : null };
    }
    case "AdminProductsCount":
      return { productsCount: { count: shop.products.length, precision: "EXACT" } };
    case "AdminCollections": {
      const pg = pageOf(shop.collections, v.cursor, 50);
      return { collections: { pageInfo: pg.pageInfo, nodes: pg.nodes.map(adminCollection) } };
    }
    case "CollectionProducts": {
      const c = shop.collections.find((x) => x.id === v.id);
      const pg = pageOf(c.members.map((id) => ({ id })), v.cursor, 250);
      return { collection: { products: pg } };
    }
    case "Products": {
      const pg = pageOf(shop.products, v.cursor, v.first);
      return { products: { pageInfo: pg.pageInfo, nodes: pg.nodes.map(storefrontProduct) } };
    }
    case "Collections": {
      const pg = pageOf(shop.collections, v.cursor, v.first);
      return {
        collections: {
          pageInfo: pg.pageInfo,
          nodes: pg.nodes.map((c) => ({
            id: c.id,
            handle: c.handle,
            title: c.title,
            description: "",
            updatedAt: "2026-10-01T00:00:00Z",
            image: null,
            products: { pageInfo: { hasNextPage: c.members.length > v.productsFirst }, nodes: c.members.slice(0, v.productsFirst).map((id) => ({ id })) },
          })),
        },
      };
    }
    default:
      throw new Error(`the fake Shopify has no answer for "${op}"`);
  }
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith(`https://${SHOP}/`)) throw new Error(`the suite reached for the network: ${u}`);
  if (u.endsWith("/admin/oauth/access_token")) {
    shop.calls.push({ op: "token" });
    return Response.json({ access_token: "test-admin-token-from-oauth", scope: O.OAUTH_SCOPES });
  }
  const { query, variables = {} } = JSON.parse(init.body || "{}");
  const op = /^\s*query\s+(\w+)/.exec(query)?.[1] || "anonymous";
  const call = { op, cursor: variables.cursor ?? null, id: variables.id ?? null, storefront: !u.includes("/admin/") };
  shop.calls.push(call);
  clock.t += shop.pageMs;
  if (invocation && clock.t - invocation.start > ROUTE_LIMIT_MS) {
    invocation.kill(); // the platform ends the function mid-page
    return new Promise(() => {});
  }
  const f = shop.fault ? shop.fault(call) : null;
  if (f === "hang") {
    invocation?.kill();
    return new Promise(() => {});
  }
  if (f?.status) return new Response(f.body || "upstream trouble", { status: f.status });
  return Response.json({ data: answer(op, variables) });
};
const callsSince = (n, op) => shop.calls.slice(n).filter((c) => !op || c.op === op);

// --- database faults: an answer lost after the commit ------------------------------
// libsql's local client class, patched under db.js's wrapper. `dbFault(sqlOf)`
// returns "lost" (throw a transient error the db layer retries, after the
// write committed), "lost-no-retry" (an unknown-outcome error the db layer
// does not retry, as writes are on claude/gallant-keller-7d3213) or
// "hang-after" (commit, then the function is killed before the answer).
const proto = Object.getPrototypeOf(createClient({ url: "file::memory:" }));
const [realBatch, realExecute] = [proto.batch, proto.execute];
let dbFault = null;
const sqlText = (s) => (typeof s === "string" ? s : `${s?.sql || ""} ${JSON.stringify(s?.args ?? [])}`);
async function faulted(kind) {
  if (kind === "lost") throw new Error("fetch failed");
  if (kind === "lost-no-retry") throw new Error("socket hang up");
  if (kind === "hang-after") {
    invocation?.kill();
    return new Promise(() => {});
  }
}
proto.batch = async function (stmts, mode) {
  const kind = dbFault?.(stmts.map(sqlText).join("\n"));
  const out = await realBatch.call(this, stmts, mode);
  if (kind) await faulted(kind);
  return out;
};
proto.execute = async function (stmt, ...rest) {
  const kind = dbFault?.(sqlText(stmt));
  const out = await realExecute.call(this, stmt, ...rest);
  if (kind) await faulted(kind);
  return out;
};
const once = (test) => {
  let fired = false;
  return (sql) => {
    if (fired) return null;
    const k = test(sql);
    if (k) fired = true;
    return k;
  };
};

// --- fixtures ------------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"));

const tenants = {};
async function mkTenant(name, { connected = true } = {}) {
  const id = `fs-${name}`;
  const linked = connected !== "none";
  await C.upsertTenant({
    id,
    name: `Fsync ${name}`,
    domains: [`${id}.test`],
    dbUrl: `file:.test-fsync-${name}.db`,
    config: linked ? { shopify_store_domain: SHOP, shopify_client_id: "test-client-id" } : {},
    secrets: linked ? { shopify_client_secret: "test-client-secret", ...(connected === true ? { shopify_admin_token: "test-admin-token" } : {}) } : {},
  });
  const client = createClient({ url: `file:.test-fsync-${name}.db` });
  await applyTenantSchema(client);
  client.close?.();
  tenants[name] = await C.getTenant(id);
  return tenants[name];
}
const inT = (name, fn) => withTenant(tenants[name], fn);
const fresh = async (name) => (tenants[name] = await C.getTenant(`fs-${name}`));

for (const name of TENANTS) await mkTenant(name, { connected: name === "connect" ? false : name === "nocreds" ? "none" : true });

const owner = await I.createUser({ email: "owner@fsync.test", password: "owner-pass-fsync" });
const helper = await I.createUser({ email: "support@fsync.test", password: "support-pass-fsync" });
for (const name of TENANTS) {
  await I.addMembership(owner.id, `fs-${name}`, "owner");
  await I.addMembership(helper.id, `fs-${name}`, "support");
}
const ownerTok = (await Sess.createSession({ userId: owner.id, kind: "merchant", ttlMs: 3_600_000 })).token;
const supportTok = (await Sess.createSession({ userId: helper.id, kind: "merchant", ttlMs: 3_600_000 })).token;

function req(url, { method = "GET", body = null, cookies = {}, origin = true } = {}) {
  const u = new URL(url);
  const h = { host: u.host, ...(origin ? { origin: u.origin } : {}) };
  return {
    method,
    url: u.href,
    nextUrl: u,
    headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
    cookies: { get: (n) => (cookies[n] != null ? { value: cookies[n] } : undefined) },
    json: async () => body ?? {},
  };
}
const consoleUrl = (name) => `http://fs-${name}.test/api/admin/sync`;
async function json(res) {
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const postSync = (name, body = {}, tok = ownerTok) => adminSync.POST(req(consoleUrl(name), { method: "POST", body, cookies: { _admin: tok } }));
const getSync = async (name, tok = ownerTok) => {
  if (typeof adminSync.GET !== "function") throw new Error("the console has no way to read sync progress (no GET /api/admin/sync)");
  return json(await adminSync.GET(req(consoleUrl(name), { cookies: { _admin: tok } })));
};
const tick = (label = "tick") => invoke(label, () => tickRoute.GET(req("https://platform.test/api/jobs/tick", { origin: false })));

const count = async (name, table, where = "") => Number((await inT(name, () => libsql.execute(`SELECT COUNT(*) AS n FROM ${table} ${where}`))).rows[0].n);
const runs = (name) => inT(name, () => libsql.execute("SELECT * FROM sync_runs ORDER BY started_at DESC, rowid DESC")).then((r) => r.rows.map((x) => ({ ...x })));
const latest = async (name) => (await runs(name))[0] || null;
async function letLeasesLapse(name) {
  const past = new Date(Date.now() - 1000).toISOString();
  await C.platformDb().execute({ sql: "UPDATE jobs SET lease_until = ? WHERE status = 'leased'", args: [past] });
  await inT(name, () => libsql.execute({ sql: "UPDATE sync_runs SET lease_until = ? WHERE lease_owner IS NOT NULL", args: [past] })).catch(() => {});
}
const makeDue = () => C.platformDb().execute("UPDATE jobs SET run_after = NULL WHERE status = 'pending'");
async function tickUntilDone(name, max = 30, { between = null } = {}) {
  for (let i = 0; i < max; i++) {
    const r = await latest(name);
    if (r && r.status !== "running") return r;
    await makeDue();
    const out = await quiet(() => tick(`tick ${i + 1}`));
    if (out.killed) await letLeasesLapse(name);
    if (between) await between(i);
  }
  return latest(name);
}
const variantTotal = (list) => list.reduce((n, p) => n + p.variants.length, 0);
const imageTotal = (list) => list.reduce((n, p) => n + p.images.length, 0);
const memberTotal = (colls, productIds) => colls.reduce((n, c) => n + new Set(c.members.filter((m) => productIds.has(m))).size, 0);
async function plantStale(name, i = 999001) {
  await inT(name, () =>
    libsql.batch(
      [
        { sql: "INSERT INTO products (id, handle, title, available, sync_generation, synced_at) VALUES (?, ?, 'Gone upstream', 1, 'sync_old', '2020-01-01T00:00:00.000Z')", args: [pid(i), `stale-${i}`] },
        { sql: "INSERT INTO variants (id, product_id, title) VALUES (?, ?, 'Only')", args: [`gid://shopify/ProductVariant/stale${i}`, pid(i)] },
      ],
      "write",
    ),
  );
}
const hasRow = async (name, id) => (await count(name, "products", `WHERE id = '${id}'`)) === 1;

// =====================================================================================
console.log("— a first sync bigger than one 60-second function");

{
  const catalog = Array.from({ length: 600 }, (_, i) => mkProduct(i, i === 7 ? { variants: 120 } : {}));
  const colls = [mkCollection(0, catalog.map((p) => p.id)), mkCollection(1, [pid(1), pid(2), "gid://shopify/Product/999999"]), ...Array.from({ length: 118 }, (_, j) => mkCollection(j + 2, [pid(j * 5), pid(j * 5 + 1), pid(j * 5 + 2)]))];
  const views = [];

  await t("connecting Shopify queues the first sync, and the queue finishes it across ticks, none past 60 seconds", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 7000, fault: null });
    const mark = shop.calls.length;
    const state = O.signState("fs-connect");
    const params = new URLSearchParams({ code: "test-code", shop: SHOP, state, timestamp: "1700000000" });
    const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    params.set("hmac", crypto.createHmac("sha256", "test-client-secret").update(message).digest("hex"));
    const first = await quiet(() => invoke("connect", () => callback.GET(req(`https://platform.test/api/connect/shopify/callback?${params}`, { origin: false }))));
    ok(!first.killed, "the connect request itself was killed:");
    eq(first.value.status, 200, "connect page:");
    const html = await first.value.text();
    ok(html.includes("Store connected"), "connected page");
    ok(!/pnpm|tenant:sync/i.test(html), "no developer command on the connect page");
    await fresh("connect");
    const after1 = await latest("connect");
    ok(after1, "a sync run was recorded before the response");
    eq(after1.started_by, "connect", "started by:");
    ok(Number(after1.products_fetched) > 0 && Number(after1.products_fetched) < 600, `first slice made progress, not all of it (${after1.products_fetched})`);

    const final = await tickUntilDone("connect", 20, {
      between: async () => views.push((await getSync("connect", supportTok)).body.sync),
    });
    eq(final?.status, "complete", `run status after ${invocations.length} invocations (${JSON.stringify(invocations.slice(-3))}):`);
    eq(await count("connect", "products"), 600, "products:");
    eq(await count("connect", "variants"), variantTotal(catalog), "variants:");
    eq(await count("connect", "product_images"), imageTotal(catalog), "images:");
    eq(await count("connect", "collections"), colls.length, "collections:");
    eq(await count("connect", "collection_products"), memberTotal(colls, new Set(catalog.map((p) => p.id))), "memberships (the draft id filtered out):");
    const all = (await inT("connect", () => libsql.execute(`SELECT product_id, position FROM collection_products WHERE collection_id = '${colls[0].id}' ORDER BY position`))).rows;
    eq(all.map((r) => Number(r.position)), catalog.map((_, i) => i), "the 600-product collection, read over three member pages, keeps Shopify's order:");
    eq(all[599].product_id, pid(599), "last member:");
    const productPages = callsSince(mark, "AdminProducts");
    eq(productPages.length, 20, "each products page fetched exactly once:");
    eq(new Set(productPages.map((c) => c.cursor)).size, 20, "20 distinct positions:");
    const mine = invocations.filter((x) => x.label === "connect" || x.label.startsWith("tick"));
    ok(mine.every((x) => !x.killed && x.ms <= ROUTE_LIMIT_MS), `no invocation ran past 60s: ${JSON.stringify(mine.filter((x) => x.killed || x.ms > ROUTE_LIMIT_MS))}`);
    const shopifySeconds = (shop.calls.length - mark) * 7;
    ok(shopifySeconds > 3 * 60, `the sync needed more than three route limits of Shopify time (${shopifySeconds}s)`);
    ok(mine.filter((x) => x.ms > 0).length >= 4, "the work was spread over several invocations");
  });

  await t("the founder sees progress during it: running, N of 600, rising", async () => {
    ok(views.length >= 2, "progress was read between ticks");
    const running = views.filter((v) => v?.state === "running");
    ok(running.length >= 1, `a running state was shown: ${JSON.stringify(views.map((v) => v?.state))}`);
    const mid = running.find((v) => v.products.done > 0 && v.products.done < 600);
    ok(mid, "a view between the start and the end");
    eq(mid.products.total, 600, "the total comes from Shopify's count:");
    ok(/of 600 products so far/.test(mid.detail), `plain progress line: ${mid.detail}`);
    const done = views.map((v) => v?.products?.done ?? 0);
    ok(done.every((n, i) => i === 0 || n >= done[i - 1] || views[i].state === "complete"), `never goes backwards: ${done}`);
    eq(views.at(-1).state, "complete", "last view:");
    ok(/600 products/.test(views.at(-1).detail), `complete view: ${views.at(-1).detail}`);
  });

  await t("a support login reads progress but never gives the sync work", async () => {
    globalThis.__fsyncAfter.length = 0;
    await getSync("connect", supportTok);
    eq(globalThis.__fsyncAfter.length, 0, "support poll deferred work:");
  });
}

// =====================================================================================
console.log("— a job killed mid-page resumes from the stored cursor");

{
  const catalog = Array.from({ length: 150 }, (_, i) => mkProduct(i));
  const colls = Array.from({ length: 10 }, (_, j) => mkCollection(j, [pid(j), pid(j + 10), pid(j + 100)]));
  let stored;
  let mark;

  await t("killed while fetching page 4: three pages kept with their position, nothing duplicated or pruned", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 1000 });
    await plantStale("kill");
    // product 0 from an older sync, holding a variant Shopify no longer has
    await inT("kill", () =>
      libsql.batch(
        [
          { sql: "INSERT INTO products (id, handle, title, available, sync_generation, synced_at) VALUES (?, 'item-0', 'Old title', 1, 'sync_old', '2020-01-01T00:00:00.000Z')", args: [pid(0)] },
          { sql: "INSERT INTO variants (id, product_id, title) VALUES ('gid://shopify/ProductVariant/retired', ?, 'Retired')", args: [pid(0)] },
        ],
        "write",
      ),
    );
    let pages = 0;
    shop.fault = (c) => (c.op === "AdminProducts" && ++pages === 4 ? "hang" : null);
    const out = await quiet(() => invoke("manual sync", () => postSync("kill")));
    shop.fault = null;
    ok(out.killed, "the invocation was killed mid-page");
    stored = await latest("kill");
    eq(stored.status, "running", "run:");
    eq(stored.phase, "products", "phase:");
    eq(stored.cursor, enc(90), "stored cursor = end of page 3:");
    eq(Number(stored.products_fetched), 90, "products_fetched:");
    eq(await count("kill", "products"), 91, "90 fresh rows + the stale one (product 0 rewritten in place):");
    ok(await hasRow("kill", pid(999001)), "the stale row is NOT pruned by a partial run");
    eq(await count("kill", "variants", `WHERE product_id = '${pid(0)}'`), catalog[0].variants.length, "product 0 has exactly its Shopify variants:");
    eq(await count("kill", "variants"), variantTotal(catalog.slice(0, 90)) + 1, "variants: pages 1-3 + the stale row's one:");
    mark = shop.calls.length;
  });

  await t("…and the next tick picks up at that cursor, not from zero, and finishes exactly", async () => {
    await letLeasesLapse("kill");
    const final = await tickUntilDone("kill");
    eq(final.status, "complete", "run:");
    eq(final.id, stored.id, "same run, resumed:");
    const resumed = callsSince(mark, "AdminProducts");
    eq(resumed[0]?.cursor, enc(90), "first page fetched after the kill:");
    ok(!resumed.some((c) => c.cursor === null), "no restart from the first page");
    eq(resumed.length, 2, "pages 4 and 5 only:");
    eq(Number(final.products_fetched), 150, "progress not double-counted:");
    eq(await count("kill", "products"), 150, "products:");
    ok(!(await hasRow("kill", pid(999001))), "the stale row is pruned now, after the COMPLETE generation");
    eq(Number(final.pruned_products), 1, "pruned:");
    eq(await count("kill", "variants"), variantTotal(catalog), "variants exact:");
    eq(await count("kill", "product_images"), imageTotal(catalog), "images exact:");
    eq(await count("kill", "collection_products"), memberTotal(colls, new Set(catalog.map((p) => p.id))), "memberships exact:");
  });

  await t("killed after a page's write committed but before the answer: the next runner moves on to the next page", async () => {
    await plantStale("kill", 999002);
    const before = shop.calls.length;
    // commit the run's second page, then the function dies before hearing back
    dbFault = once((sql) => (/UPDATE sync_runs SET cursor/.test(sql) && sql.includes(pid(30)) ? "hang-after" : null));
    const out = await quiet(() => invoke("manual sync", () => postSync("kill")));
    dbFault = null;
    ok(out.killed, "killed after the commit");
    const mid = await latest("kill");
    eq(mid.cursor, enc(60), "the committed page moved the cursor:");
    await letLeasesLapse("kill");
    const final = await tickUntilDone("kill");
    eq(final.status, "complete", "run:");
    const pagesFetched = callsSince(before, "AdminProducts").map((c) => dec(c.cursor));
    eq(pagesFetched, [0, 30, 60, 90, 120], "each page fetched once, none repeated:");
    eq(Number(final.products_fetched), 150, "progress exact:");
    eq(await count("kill", "products"), 150, "products:");
    eq(await count("kill", "variants"), variantTotal(catalog), "variants:");
  });
}

// =====================================================================================
console.log("— a failed page: a plain message and a retry");

{
  const catalog = Array.from({ length: 120 }, (_, i) => mkProduct(i));
  const colls = [mkCollection(1, [pid(1), pid(2)])];
  let runId;
  let mark;
  const RAW = /\b500\b|graphql|http|upstream|admin/i;

  await t("Shopify keeps failing on page 3: the console says so in plain words while it retries", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 1000 });
    await plantStale("fail");
    shop.fault = (c) => (c.op === "AdminProducts" && c.cursor === enc(60) ? { status: 500 } : null);
    await quiet(() => invoke("manual sync", () => postSync("fail")));
    const run = await latest("fail");
    runId = run.id;
    eq(run.status, "running", "still running (the queue will retry):");
    eq(Number(run.products_fetched), 60, "pages 1-2 kept:");
    const { body } = await getSync("fail");
    eq(body.sync.state, "retrying", "view:");
    eq(body.sync.message, "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes.", "message:");
    ok(!RAW.test(`${body.sync.headline} ${body.sync.message} ${body.sync.detail}`), `no raw error text: ${JSON.stringify(body.sync)}`);
    ok(body.sync.retryAt, "says when it tries again");
    eq(body.sync.canRetry, true, "a retry is offered:");
  });

  await t("…after the queue gives up the run is failed, keeps its rows, and the console shows the plain message and a retry", async () => {
    const final = await tickUntilDone("fail", 12);
    eq(final.status, "failed", "run:");
    eq(final.id, runId, "same run:");
    eq(await count("fail", "products"), 61, "60 kept + the stale row:");
    ok(await hasRow("fail", pid(999001)), "nothing pruned by the failed run");
    const job = (await J.listJobs({ tenant: "fs-fail" })).find((j) => j.type === "catalog_sync");
    eq(job?.status, "dead", "job:");
    const { body } = await getSync("fail");
    eq(body.sync.state, "failed", "view:");
    eq(body.sync.headline, "Your products didn't finish coming in", "headline:");
    eq(body.sync.message, "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes.", "message:");
    ok(/keeps everything already brought in/.test(body.sync.detail), `detail: ${body.sync.detail}`);
    ok(!RAW.test(JSON.stringify([body.sync.headline, body.sync.message, body.sync.detail])), "no raw error text");
    eq(body.sync.canRetry, true, "retry offered:");
    mark = shop.calls.length;
  });

  await t("Try again resumes the same run at page 3 and finishes it, with no duplicates", async () => {
    shop.fault = null;
    const out = await quiet(() => invoke("try again", () => postSync("fail", { retry: true })));
    const { status, body } = await json(out.value);
    eq(status, 202, "retry:");
    eq(body.action, "resumed", "action:");
    const final = await tickUntilDone("fail");
    eq(final.status, "complete", "run:");
    eq(final.id, runId, "same run, resumed:");
    const pages = callsSince(mark, "AdminProducts").map((c) => dec(c.cursor));
    eq(pages, [60, 90], "only the pages it hadn't got:");
    eq(await count("fail", "products"), 120, "products:");
    eq(await count("fail", "variants"), variantTotal(catalog), "variants:");
    ok(!(await hasRow("fail", pid(999001))), "stale row pruned after the complete generation");
    eq((await getSync("fail")).body.sync.state, "complete", "view:");
  });

  await t("a flaky store that fails now and then still finishes: pages that got in reset the retry budget", async () => {
    await inT("fail", () => libsql.execute("DELETE FROM sync_runs"));
    const big = Array.from({ length: 360 }, (_, i) => mkProduct(i)); // 12 pages
    Object.assign(shop, { products: big, collections: colls, pageMs: 1000 });
    const failedOnce = new Set();
    // every other page fails on its first try: more failures than the five attempts a job gets
    shop.fault = (c) => {
      if (c.op !== "AdminProducts" || dec(c.cursor) % 60 !== 30 || failedOnce.has(c.cursor)) return null;
      failedOnce.add(c.cursor);
      return { status: 503 };
    };
    await quiet(() => invoke("manual sync", () => postSync("fail")));
    const final = await tickUntilDone("fail", 30);
    shop.fault = null;
    ok(failedOnce.size >= 6, `failures injected: ${failedOnce.size}`);
    eq(final.status, "complete", "run:");
    eq(await count("fail", "products"), 360, "products:");
  });

  await t("a refusal no retry can fix (401) fails the run at once, with a plain message about the link", async () => {
    await inT("deny", () => libsql.execute("DELETE FROM sync_runs"));
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 1000 });
    shop.fault = (c) => (c.op === "AdminProducts" && c.cursor === enc(30) ? { status: 401, body: '{"errors":"[API] Invalid API key or access token"}' } : null);
    await quiet(() => invoke("manual sync", () => postSync("deny")));
    shop.fault = null;
    const run = await latest("deny");
    eq(run.status, "failed", "failed at once, no five retries:");
    const { body } = await getSync("deny");
    eq(body.sync.message, "Shopify stopped letting Storeasy into your store. Contact support to link it again, then try again.", "message:");
    ok(!/401|api key|access token/i.test(body.sync.message), "no raw text");
  });

  await t("starting with no Shopify link answers with a plain message, not an internal one", async () => {
    const { status, body } = await json(await postSync("nocreds"));
    eq(status, 409, "status:");
    eq(body.error, "Storeasy isn't linked to your Shopify store. Contact support to link it, then try again.", "error:");
  });
}

// =====================================================================================
console.log("— pruning and indexing only after a complete generation");

{
  const catalog = Array.from({ length: 90 }, (_, i) => mkProduct(i));
  const colls = Array.from({ length: 60 }, (_, j) => mkCollection(j, [pid(j)]));
  const setup = async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 1000, fault: null });
    await inT("prune", () => libsql.execute("DELETE FROM sync_runs"));
    await C.platformDb().execute("UPDATE jobs SET status = 'done' WHERE tenant_id = 'fs-prune'");
    if (!(await hasRow("prune", pid(999001)))) await plantStale("prune");
  };
  const deny = (match) => (c) => (match(c) ? { status: 401 } : null);

  await t("a run failing in the products pages prunes nothing", async () => {
    await setup();
    shop.fault = deny((c) => c.op === "AdminProducts" && c.cursor === enc(30));
    await quiet(() => invoke("sync", () => postSync("prune")));
    eq((await latest("prune")).status, "failed", "run:");
    ok(await hasRow("prune", pid(999001)), "stale row kept");
    eq(Number((await latest("prune")).pruned_products), 0, "pruned:");
  });

  await t("a run failing in the collections pages (every product in) prunes nothing", async () => {
    await setup();
    shop.fault = deny((c) => c.op === "AdminCollections" && c.cursor === enc(50));
    await quiet(() => invoke("sync", () => postSync("prune")));
    const run = await latest("prune");
    eq(run.status, "failed", "run:");
    eq(run.phase, "collections", "it got as far as collections:");
    eq(Number(run.products_fetched), 90, "all products were in:");
    ok(await hasRow("prune", pid(999001)), "stale row kept");
  });

  await t("a run killed on its very last page prunes nothing", async () => {
    await setup();
    shop.fault = (c) => (c.op === "AdminCollections" && c.cursor === enc(50) ? "hang" : null);
    const out = await quiet(() => invoke("sync", () => postSync("prune")));
    ok(out.killed, "killed");
    eq((await latest("prune")).phase, "collections", "phase:");
    ok(await hasRow("prune", pid(999001)), "stale row kept");
  });

  await t("the database itself refuses a prune for a run that isn't at its prune step (forged run)", async () => {
    const run = await latest("prune");
    await inT("prune", () => libsql.execute({ sql: "UPDATE sync_runs SET lease_owner = 'suite', lease_until = ? WHERE id = ?", args: [new Date(Date.now() + 60_000).toISOString(), run.id] }));
    const before = await count("prune", "products");
    const res = await inT("prune", () => S.pruneGeneration({ ...run, phase: "prune" }, "suite").catch((e) => ({ threw: e.message })));
    ok(res.lost || res.threw, `refused: ${JSON.stringify(res).slice(0, 120)}`);
    eq(await count("prune", "products"), before, "no row deleted:");
    ok(await hasRow("prune", pid(999001)), "stale row kept");
    eq((await latest("prune")).phase, "collections", "phase unchanged:");
  });

  await t("only the complete run prunes, and search indexing runs once, after the prune", async () => {
    shop.fault = null;
    await inT("prune", () => libsql.execute("UPDATE sync_runs SET lease_until = '2000-01-01T00:00:00.000Z'"));
    const seen = [];
    const indexer = async () => {
      const r = await latest("prune");
      seen.push({ phase: r.phase, pruned: Number(r.pruned_products), status: r.status, stale: await hasRow("prune", pid(999001)) });
      return { indexed: 90 };
    };
    const run = await latest("prune");
    const out = await inT("prune", () => S.runSyncSlice(run.id, { mode: "inline", indexer }));
    eq(out.status, "complete", "run:");
    eq(seen, [{ phase: "index", pruned: 1, status: "running", stale: false }], "indexer calls:");
    ok(!(await hasRow("prune", pid(999001))), "pruned now");
  });

  await t("a failed inline run never indexes", async () => {
    await setup();
    let calls = 0;
    shop.fault = deny((c) => c.op === "AdminProducts" && c.cursor === enc(60));
    await inT("prune", () => S.runCatalogSync({ indexer: async () => (calls++, {}) }).catch(() => null));
    eq(calls, 0, "indexer calls:");
    shop.fault = null;
  });
}

// =====================================================================================
console.log("— idempotent writes (the db layer may or may not retry a write)");

{
  const catalog = Array.from({ length: 60 }, (_, i) => mkProduct(i));
  const colls = [mkCollection(1, [pid(1), pid(31)])];
  const reset = async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 0, fault: null });
    await inT("write", () => libsql.executeMultiple("DELETE FROM sync_runs; DELETE FROM products; DELETE FROM variants; DELETE FROM product_images; DELETE FROM collections; DELETE FROM collection_products;"));
  };
  const exact = async (label) => {
    eq(await count("write", "products"), 60, `${label} products:`);
    eq(await count("write", "variants"), variantTotal(catalog), `${label} variants:`);
    eq(await count("write", "product_images"), imageTotal(catalog), `${label} images:`);
    eq(await count("write", "collection_products"), 2, `${label} memberships:`);
  };

  // One slice, so the same runner has to recognise its own commit and carry
  // on (handing off would leave the run waiting out its own lease).
  const oneSlice = async () => {
    const { run } = await inT("write", () => S.requestCatalogSync());
    return inT("write", () => S.runSyncSlice(run.id, { mode: "inline" }));
  };

  await t("a page write whose answer is lost and which the db layer retries: the page counts once", async () => {
    await reset();
    dbFault = once((sql) => (/insert into "?product_images"?/i.test(sql) ? "lost" : null));
    const res = await oneSlice().catch((e) => ({ error: e.message }));
    dbFault = null;
    eq([res.error, res.status], [undefined, "complete"], "the same slice finished:");
    await exact("");
    eq(Number((await latest("write")).products_fetched), 60, "progress not double-counted:");
  });

  await t("a page write whose answer is lost and which the db layer does NOT retry: re-read, then carry on", async () => {
    await reset();
    const mark = shop.calls.length;
    dbFault = once((sql) => (/insert into "?product_images"?/i.test(sql) ? "lost-no-retry" : null));
    const res = await oneSlice().catch((e) => ({ error: e.message }));
    dbFault = null;
    eq([res.error, res.status], [undefined, "complete"], "the same slice finished:");
    await exact("");
    eq(callsSince(mark, "AdminProducts").length, 2, "no page fetched twice:");
  });

  await t("the old code path (pnpm sync) gets through a lost answer too", async () => {
    await reset();
    dbFault = once((sql) => (/insert into "?product_images"?/i.test(sql) ? "lost" : null));
    const res = await inT("write", () => S.runCatalogSync().catch((e) => ({ error: e.message })));
    dbFault = null;
    ok(!res.error, `sync failed: ${res.error}`);
    await exact("");
  });

  await t("writing the same product twice leaves exactly one copy", async () => {
    const p = { ...adminProduct(catalog[3]), priceRange: { minVariantPrice: money, maxVariantPrice: money } };
    await inT("write", () => S.writeProduct(p, new Date().toISOString(), "sync_x"));
    await inT("write", () => S.writeProduct(p, new Date().toISOString(), "sync_x"));
    eq(await count("write", "variants", `WHERE product_id = '${pid(3)}'`), catalog[3].variants.length, "variants:");
    eq(await count("write", "products", `WHERE id = '${pid(3)}'`), 1, "rows:");
  });

  await t("a handle reused by a new Shopify product doesn't block the sync on the old row", async () => {
    await reset();
    await inT("write", () => libsql.execute({ sql: "INSERT INTO products (id, handle, title, available, sync_generation, synced_at) VALUES ('gid://shopify/Product/1', 'item-5', 'Deleted upstream', 1, 'sync_old', '2020-01-01T00:00:00.000Z')" }));
    const res = await inT("write", () => S.runCatalogSync().catch((e) => ({ error: e.message })));
    ok(!res.error, `sync failed: ${res.error}`);
    await exact("");
    ok(!(await hasRow("write", "gid://shopify/Product/1")), "the old row with the reused handle is gone");
  });

  await t("a variant row left under the wrong product can't block a page: it moves to its real product", async () => {
    await reset();
    const vid = catalog[4].variants[0].id;
    await inT("write", () => libsql.execute({ sql: "INSERT INTO variants (id, product_id, title) VALUES (?, 'gid://shopify/Product/orphan', 'Left behind')", args: [vid] }));
    const res = await inT("write", () => S.runCatalogSync().catch((e) => ({ error: e.message })));
    ok(!res.error, `sync failed: ${res.error}`);
    const row = (await inT("write", () => libsql.execute({ sql: "SELECT product_id FROM variants WHERE id = ?", args: [vid] }))).rows[0];
    eq(row.product_id, pid(4), "variant now under:");
    await exact("");
  });

  await t("one runner at a time: a second runner while the first holds the run does nothing", async () => {
    await reset();
    const { run } = await inT("write", () => S.requestCatalogSync());
    let gate;
    shop.fault = (c) => (c.op === "AdminProducts" && !gate ? ((gate = true), "hang") : null);
    await quiet(() => invoke("first runner", () => inT("write", () => S.runSyncSlice(run.id, { mode: "queued" }))));
    shop.fault = null;
    const second = await inT("write", () => S.runSyncSlice(run.id, { mode: "queued" }));
    eq(second.busy, true, "second runner:");
    eq(await count("write", "products"), 0, "nothing written by either:");
  });

  await t("a runner whose lease was taken over can't commit its stale page afterwards", async () => {
    await reset();
    const { run } = await inT("write", () => S.requestCatalogSync());
    let release;
    let held = false;
    // runner A fetches page 1 and stalls before its commit (Shopify answers slowly)
    const gateFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init?.body || "{}");
      if (/AdminProducts/.test(body.query || "") && !held) {
        held = true;
        await new Promise((r) => (release = r));
      }
      return gateFetch(url, init);
    };
    const a = inT("write", () => S.runSyncSlice(run.id, { mode: "queued" }));
    while (!release) await new Promise((r) => setTimeout(r, 5));
    globalThis.fetch = gateFetch;
    // A's lease lapses; runner B takes the run over and finishes it
    await inT("write", () => libsql.execute({ sql: "UPDATE sync_runs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [run.id] }));
    const b = await inT("write", () => S.runSyncSlice(run.id, { mode: "inline" }));
    eq(b.status, "complete", "B finished:");
    const done = await latest("write");
    release();
    const late = await a;
    eq(late.lost, true, "A is told it lost the run:");
    const after = await latest("write");
    eq([after.pages_done, after.products_fetched, after.status], [done.pages_done, done.products_fetched, "complete"], "A's stale page changed nothing:");
    await exact("");
  });

  await t("a stale runner's older copy of a page never wins over the runner that took the run over", async () => {
    await reset();
    const { run } = await inT("write", () => S.requestCatalogSync());
    const gates = [];
    let gated = 0;
    // each of the first two runners gets its page 1 answer, then is held before committing it
    const passFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const res = await passFetch(url, init);
      if (/AdminProducts\b/.test(JSON.parse(init?.body || "{}").query || "") && gated < 2) {
        gated++;
        await new Promise((r) => gates.push(r));
      }
      return res;
    };
    const waitFor = async (n) => {
      while (gates.length < n) await new Promise((r) => setTimeout(r, 5));
    };
    try {
      shop.products = catalog.map((p, i) => (i === 0 ? { ...p, title: "Old title" } : p));
      const a = inT("write", () => S.runSyncSlice(run.id, { mode: "queued" })); // runner A reads the old title
      await waitFor(1);
      await inT("write", () => libsql.execute({ sql: "UPDATE sync_runs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?", args: [run.id] }));
      shop.products = catalog.map((p, i) => (i === 0 ? { ...p, title: "New title" } : p));
      const b = inT("write", () => S.runSyncSlice(run.id, { mode: "inline" })); // runner B takes over, reads the new title
      await waitFor(2);
      gates[0](); // A tries to commit its older page first
      const late = await a;
      eq(late.lost, true, "A is refused:");
      gates[1]();
      eq((await b).status, "complete", "B finished:");
    } finally {
      globalThis.fetch = passFetch;
      shop.products = catalog;
    }
    const title = (await inT("write", () => libsql.execute({ sql: "SELECT title FROM products WHERE id = ?", args: [pid(0)] }))).rows[0].title;
    eq(title, "New title", "the newer copy stands:");
    await exact("");
  });

  await t("one page is all or nothing: a bad row leaves the whole page unwritten and the position unmoved", async () => {
    await reset();
    const broken = catalog.map((p, i) => (i === 40 ? { ...p, title: null } : p)); // title is NOT NULL
    shop.products = broken;
    const res = await inT("write", () => S.runCatalogSync().catch((e) => ({ error: e.message })));
    shop.products = catalog;
    ok(res.error, "the sync reported the failure");
    const run = await latest("write");
    eq(run.status, "failed", "run:");
    eq(run.cursor, enc(30), "position stays after page 1:");
    eq(await count("write", "products"), 30, "only page 1's rows:");
    eq(await count("write", "variants"), variantTotal(catalog.slice(0, 30)), "only page 1's variants:");
  });
}

// =====================================================================================
console.log("— the one question first-run generation asks");

{
  const catalog = Array.from({ length: 60 }, (_, i) => mkProduct(i));
  const ask = () => inT("gen", () => S.confirmedCatalogSync());

  await t("no sync yet: not confirmed", async () => {
    eq((await ask()).confirmed, false, "confirmed:");
  });

  await t("products from before runs were recorded: not confirmed (but the console doesn't call it missing)", async () => {
    await inT("gen", () => libsql.execute("INSERT INTO products (id, handle, title, available) VALUES ('gid://shopify/Product/42', 'legacy', 'Legacy', 1)"));
    eq((await ask()).confirmed, false, "confirmed:");
    const { view } = await inT("gen", () => S.catalogSyncStatus());
    eq(view.state, "complete", "console view:");
    await inT("gen", () => libsql.execute("DELETE FROM products"));
  });

  await t("partial (a slice that stopped part way): not confirmed", async () => {
    Object.assign(shop, { products: catalog, collections: [], pageMs: 0, fault: null });
    const { run } = await inT("gen", () => S.requestCatalogSync());
    let pages = 0;
    shop.fault = (c) => (c.op === "AdminProducts" && ++pages === 2 ? "hang" : null);
    await quiet(() => invoke("slice", () => inT("gen", () => S.runSyncSlice(run.id, { mode: "queued" }))));
    shop.fault = null;
    const a = await ask();
    eq([a.confirmed, a.reason], [false, "running"], "partial:");
  });

  await t("stalled (no progress for an hour, nobody on it): not confirmed", async () => {
    await inT("gen", () => libsql.execute({ sql: "UPDATE sync_runs SET updated_at = ?, lease_owner = NULL, lease_until = NULL", args: [new Date(Date.now() - 3_600_000).toISOString()] }));
    const a = await ask();
    eq([a.confirmed, a.reason], [false, "stalled"], "stalled:");
  });

  await t("failed: not confirmed", async () => {
    const run = await latest("gen");
    await inT("gen", () => S.failSyncRun(run.id, "Admin GraphQL HTTP 503"));
    const a = await ask();
    eq([a.confirmed, a.reason], [false, "failed"], "failed:");
  });

  await t("complete: confirmed, with what it holds", async () => {
    const res = await inT("gen", () => S.runCatalogSync());
    const a = await ask();
    eq(a.confirmed, true, "confirmed:");
    eq(a.runId, res.runId, "run:");
    eq(a.products, 60, "products:");
    eq(await inT("gen", () => S.hasConfirmedSync()), true, "hasConfirmedSync:");
  });

  await t("a newer sync that is failing or under way: not confirmed until it completes", async () => {
    shop.fault = (c) => (c.op === "AdminProducts" && c.cursor === enc(30) ? { status: 401 } : null);
    await inT("gen", () => S.runCatalogSync().catch(() => null));
    shop.fault = null;
    eq(await inT("gen", () => S.hasConfirmedSync()), false, "after a newer failed run:");
    await inT("gen", () => S.runCatalogSync());
    eq(await inT("gen", () => S.hasConfirmedSync()), true, "after it completes again:");
  });
}

// =====================================================================================
console.log("— every caller still works");

{
  const catalog = Array.from({ length: 90 }, (_, i) => mkProduct(i));
  const colls = [mkCollection(1, [pid(1), pid(2), pid(80)])];

  await t("manual: a second Sync now while one runs joins it (one run, one job)", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 0, fault: null });
    const a = await json(await postSync("callers"));
    globalThis.__fsyncAfter.length = 0; // nothing ran yet
    const b = await json(await postSync("callers"));
    globalThis.__fsyncAfter.length = 0;
    eq([a.status, a.body.action], [202, "started"], "first:");
    eq([b.status, b.body.action], [202, "joined"], "second:");
    eq((await runs("callers")).length, 1, "runs:");
    eq((await J.listJobs({ tenant: "fs-callers" })).filter((j) => j.type === "catalog_sync").length, 1, "jobs:");
    const final = await tickUntilDone("callers");
    eq(final.status, "complete", "run:");
  });

  await t("console poll: while the founder watches, each poll gives the sync its next slice (no tick needed)", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 9000 });
    await quiet(() => invoke("sync", () => postSync("callers")));
    let polls = 0;
    while ((await latest("callers")).status === "running" && polls < 10) {
      polls++;
      await quiet(() => invoke("poll", () => adminSync.GET(req(consoleUrl("callers"), { cookies: { _admin: ownerTok } }))));
    }
    eq((await latest("callers")).status, "complete", `after ${polls} polls:`);
    ok(polls >= 1, "it needed the polls");
  });

  await t("scheduled: GET /api/jobs/sync-catalog queues every active store and the tick finishes them", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 0 });
    const out = await quiet(() => invoke("scheduled", () => scheduled.GET(req("https://platform.test/api/jobs/sync-catalog", { origin: false }))));
    const { status, body } = await json(out.value);
    eq(status, 202, "status:");
    const mine = body.results.find((r) => r.tenant === "fs-callers");
    ok(mine?.ok && mine.runId, `queued: ${JSON.stringify(mine)}`);
    const none = body.results.find((r) => r.tenant === "fs-nocreds");
    eq(none?.ok, false, "a store with no Shopify link is reported, not crashed:");
    const final = await tickUntilDone("callers");
    eq([final.status, final.started_by], ["complete", "scheduled"], "run:");
  });

  await t("operator: the platform console's sync queues and answers at once", async () => {
    const out = await quiet(() =>
      invoke("operator", async () =>
        operator.POST(req("https://platform.test/api/platform/tenants/fs-callers", { method: "POST", cookies: { _platform: await platformSessionToken() } }), { params: Promise.resolve({ id: "fs-callers" }) }),
      ),
    );
    const { status, body } = await json(out.value);
    eq([status, body.queued], [202, true], "answer:");
    const final = await tickUntilDone("callers");
    eq([final.status, final.started_by], ["complete", "operator"], "run:");
  });

  await t("CLI (pnpm tenant:sync): runs to the end in one go, and joins a queued sync already under way", async () => {
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 9000 });
    await quiet(() => invoke("sync", () => postSync("cli")));
    const queued = await latest("cli");
    eq(queued.status, "running", "queued run still going:");
    const res = await S.syncTenantCatalog(tenants.cli);
    eq(res.runId, queued.id, "the CLI finished the same run:");
    eq(res.products, 90, "products:");
    eq((await latest("cli")).status, "complete", "run:");
    const job = (await J.listJobs({ tenant: "fs-cli" })).find((j) => j.type === "catalog_sync");
    await makeDue();
    await quiet(() => tick());
    eq((await J.listJobs({ tenant: "fs-cli" })).find((j) => j.id === job.id).status, "done", "its job completes without redoing anything:");
  });

  await t("legacy _default store (no control plane): Sync now and pnpm sync both run page by page in-process", async () => {
    process.env.PLATFORM_DB_URL = "";
    C.__resetPlatformClient?.();
    process.env.SHOPIFY_STORE_DOMAIN = SHOP;
    process.env.SHOPIFY_ADMIN_TOKEN = "test-legacy-admin-token";
    process.env.ADMIN_PASSWORD = "test-legacy-console-pw";
    try {
      await applyTenantSchema(libsql);
      Object.assign(shop, { products: catalog, collections: colls, pageMs: 9000, fault: null });
      const { adminSessionToken } = await import("../lib/admin-auth.js");
      const tok = await adminSessionToken();
      const out = await quiet(() => invoke("legacy sync", () => adminSync.POST(req("http://legacy.test/api/admin/sync", { method: "POST", body: {}, cookies: { _admin: tok } }))));
      eq(out.value.status, 202, "Sync now:");
      let polls = 0;
      let view;
      do {
        polls++;
        const res = await quiet(() => invoke("legacy poll", () => adminSync.GET(req("http://legacy.test/api/admin/sync", { cookies: { _admin: tok } }))));
        view = (await res.value.json()).sync;
      } while (view.state === "running" && polls < 12);
      eq(view.state, "complete", `after ${polls} polls:`);
      eq(Number((await libsql.execute("SELECT COUNT(*) AS n FROM products")).rows[0].n), 90, "products:");
      shop.pageMs = 0;
      const cli = await S.runCatalogSync();
      eq(cli.products, 90, "pnpm sync:");
    } finally {
      process.env.PLATFORM_DB_URL = "file:.test-fsync-platform.db";
      C.__resetPlatformClient?.();
      for (const k of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "ADMIN_PASSWORD"]) delete process.env[k];
    }
  });

  await t("storefront-token stores page through the Storefront API the same way", async () => {
    await C.patchTenant("fs-cli", { config: { shopify_client_id: null }, secrets: { shopify_admin_token: "", shopify_client_secret: "", shopify_storefront_token: "test-storefront-token" } });
    await fresh("cli");
    Object.assign(shop, { products: catalog, collections: colls, pageMs: 0 });
    const mark = shop.calls.length;
    const res = await S.syncTenantCatalog(tenants.cli);
    eq(res.products, 90, "products:");
    ok(callsSince(mark).every((c) => c.storefront), "only Storefront API calls");
    eq(callsSince(mark, "Products").length, 2, "two pages of 50:");
  });
}

// =====================================================================================
console.log("— the console card, rendered");

{
  const { readFile: rf } = await import("node:fs/promises");
  let SyncProgressBody = null;
  try {
    const swc = require("next/dist/build/swc/index.js");
    await swc.loadBindings();
    const React = require("react");
    const h = React.createElement;
    const stubs = {
      "@/components/console/Card": { Card: ({ children }) => h("section", null, children), CardHeader: ({ title }) => h("h2", null, title) },
      "@/components/console/Banner": { Banner: ({ tone, title, children }) => h("div", { "data-tone": tone, role: tone === "danger" ? "alert" : undefined }, title, children) },
      "@/components/console/Button": { Button: ({ children, onClick, busy, icon, variant }) => h("button", { type: "button", "data-variant": variant, disabled: busy || undefined }, children) },
    };
    const { code } = await swc.transform(await rf(join(root, "components/admin/SyncProgress.js"), "utf8"), {
      filename: "SyncProgress.js",
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    });
    const mod = { exports: {} };
    new Function("require", "module", "exports", code)((id) => stubs[id] ?? require(id), mod, mod.exports);
    SyncProgressBody = mod.exports.SyncProgressBody;
    globalThis.__fsyncCard = mod.exports;
  } catch (e) {
    console.error(`   (card not loadable: ${e.message})`);
  }
  const { renderToStaticMarkup } = require("react-dom/server");
  const React = require("react");
  const render = (view, props = {}) => {
    if (!SyncProgressBody) throw new Error("components/admin/SyncProgress.js has no SyncProgressBody");
    return renderToStaticMarkup(React.createElement(SyncProgressBody, { view, canRun: true, ...props }));
  };
  const run = (over = {}) => ({ id: "sync_x", status: "running", phase: "products", products_fetched: 240, products_total: 600, collections_fetched: 0, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), lease_owner: "x", lease_until: new Date(Date.now() + 60_000).toISOString(), error: null, ...over });
  const view = (r, o) => V.syncView(r, o);

  await t("running: headline, N of M, and a progress bar at the right value", async () => {
    const html = render(view(run()));
    ok(html.includes("Bringing in your products from Shopify"), html);
    ok(html.includes("240 of 600 products so far"), html);
    ok(/role="progressbar"[^>]*aria-valuenow="40"/.test(html), `bar: ${html}`);
    ok(!html.includes("<button"), "no buttons while it simply runs");
  });

  await t("failed: the plain message, kept rows, and a Try again button", async () => {
    const html = render(view(run({ status: "failed", error: "Admin GraphQL HTTP 502: Bad Gateway", lease_owner: null, lease_until: null })));
    ok(html.includes("Your products didn&#x27;t finish coming in"), html);
    ok(html.includes("Shopify didn&#x27;t answer."), html);
    ok(html.includes('role="alert"'), "danger banner");
    ok(/<button[^>]*>Try again<\/button>/.test(html), `button: ${html}`);
    ok(!/502|graphql|bad gateway/i.test(html), "no raw text");
  });

  await t("retrying: a warning, when it tries next, and Try again now", async () => {
    const html = render(view(run({ error: "fetch failed", lease_owner: null, lease_until: null }), { retryAt: new Date(Date.now() + 120_000).toISOString() }));
    ok(html.includes('data-tone="warning"'), html);
    ok(html.includes("Next try at about"), html);
    ok(/>Try again now<\/button>/.test(html), html);
  });

  await t("stalled, none, complete, and a role that can't run a sync", async () => {
    const stalled = render(view(run({ updated_at: new Date(Date.now() - 7_200_000).toISOString(), lease_owner: null, lease_until: null })));
    ok(stalled.includes("stopped partway") && />Try again<\/button>/.test(stalled), stalled);
    ok(/>Bring in products<\/button>/.test(render(view(null))), "none offers a start");
    const done = view({ status: "complete", products: 600, collections: 120, finished_at: new Date().toISOString() }, { hasComplete: true });
    ok(!render(done).includes("<button"), "dashboard: no button once done");
    ok(/>Refresh from Shopify<\/button>/.test(render(done, { showStart: true })), "settings: refresh");
    ok(!render(view(run({ status: "failed", error: "x" })), { canRun: false }).includes("<button"), "support sees no button");
  });

  await t("the card's own requests are the ones the route answers (Try again → resume)", async () => {
    const card = globalThis.__fsyncCard;
    if (!card?.requestSync) throw new Error("no requestSync helper");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (url !== "/api/admin/sync") return realFetch(url, init);
      const body = init.body ? JSON.parse(init.body) : null;
      const r = req(consoleUrl("deny"), { method: init.method || "GET", body, cookies: { _admin: ownerTok } });
      return init.method === "POST" ? adminSync.POST(r) : adminSync.GET(r);
    };
    try {
      shop.fault = null;
      await C.patchTenant("fs-deny", { secrets: { shopify_admin_token: "test-admin-token" } });
      const res = await card.requestSync({ retry: true });
      globalThis.__fsyncAfter.length = 0;
      eq(res.ok, true, `retry: ${JSON.stringify(res)}`);
      eq(res.sync.state, "running", "view after Try again:");
      const read = await card.readSync();
      eq(read.state, "running", "poll:");
      globalThis.__fsyncAfter.length = 0;
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

// =====================================================================================
console.log("— wiring");

await t("the connect callback queues the sync instead of running it in after(); docs drop the CLI step", async () => {
  const src = await readFile(join(root, "app/api/connect/shopify/callback/route.js"), "utf8");
  ok(!/syncTenantCatalog/.test(src), "callback still runs the whole sync itself");
  ok(/startCatalogSync\(/.test(src), "callback queues the sync");
  const doc = await readFile(join(root, "docs/onboarding.md"), "utf8");
  ok(!/Big catalogs: run `pnpm tenant:sync/.test(doc), "onboarding still sends big catalogs to the CLI");
});

await t("the dashboard shows the card while a sync isn't complete; settings uses it too", async () => {
  const dash = await readFile(join(root, "app/(console)/admin/(authed)/dashboard/page.js"), "utf8");
  ok(/catalogSyncStatus\(\)/.test(dash) && /state !== "complete"/.test(dash) && /<SyncProgress/.test(dash), "dashboard card");
  const settings = await readFile(join(root, "components/admin/SettingsAdmin.js"), "utf8");
  ok(/<SyncProgress/.test(settings) && !/Syncing — this can take a minute/.test(settings), "settings card");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(root, f), { force: true });
process.exit(fail ? 1 : 0);
