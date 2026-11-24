// P4-SCAFFOLD (MIG-01, MIG-05): file-database tenants for phase 4 suites and
// CLIs. A helper, not a suite: nothing here runs on import.
//
//   assertLocalDbUrl(url)          returns url when it is a "file:" URL, else
//                                  throws. Phase 4 tools never touch a hosted
//                                  or real tenant.
//   makePlatform({ name })         a control plane in .test-<name>-platform.db
//                                  at the repo root, migrated, and made the
//                                  process's PLATFORM_DB_URL. Optional: without
//                                  it, makeTenant hands back an unregistered
//                                  tenant object.
//   makeTenant({ name, stage, products, id, config, secrets })
//     A tenant database in .test-<name>-tenant.db at the repo root, migrated
//     to `stage` and seeded with `products`.
//       stage     '0017' | '0020' | '0022' | '0023' | '0024' | '0025' | '0027' | 'latest'
//                 (default 'latest'). The tenant holds every migration whose
//                 4-digit number is <= stage, through runMigrations(client,
//                 MIGRATIONS.filter(...)) exactly as test-schema-compat does.
//       products  a count (that many fixtureProduct(i)) or a list of partial
//                 products (each merged over fixtureProduct(i)). Each one is
//                 written by lib/sync.js writeProduct(p, syncedAt, generation)
//                 INSIDE withTenant, so it lands as a real sync would put it.
//     -> { id, name, file, url, stage, migrations, tenant, products,
//          run(fn), client(), migrateTo(stage), cleanup() }
//       run(fn)        withTenant(tenant, fn)
//       client()       a fresh raw @libsql/client on the file; close it
//       migrateTo(s)   run the remaining migrations up to stage s
//       cleanup()      remove the file (and its -wal/-shm/-journal)
//
//   P6-FIXTURE (GEN-01, GEN-04, PUB-12) adds, all optional. With none of them
//   makeTenant does exactly what it did before: legacy, no sync_runs row, no
//   collections, products by writeProduct.
//       mode         'legacy' (default) | 'documents'. Documents runs
//                    lib/platform/provision.js applyContentMode on the fresh
//                    database (its DOCUMENTS_FOR_FRESH_STORE_SQL), BEFORE any
//                    product, collection or content row is written, so the
//                    store moves the one way a new store does. Needs stage
//                    '0024' or later (the SQL reads every CONTENT_TABLES table).
//                    The tenant config gets checkout_mode 'direct' unless the
//                    caller's config says otherwise; no maintenance and no
//                    billing snapshot are added.
//       sync         'none' (default) | 'complete' | 'partial' | 'failed'.
//                    'complete' runs the real runCatalogSync with injected
//                    fetchers ({ products, collections }) and a no-op indexer,
//                    inside withTenant: the sync_runs row, prune and the index
//                    step are real. 'partial' leaves the latest run 'running'
//                    after its first products page (the first half of the
//                    catalog). 'failed' runs the real sync and lets its second
//                    products page throw, so the run ends 'failed' with the first
//                    page kept. Needs stage '0020' or later.
//       catalogShape one | few | many | all_sold_out | no_images | long_titles
//                    | empty | no_collections (CATALOG_SHAPES). Replaces
//                    `products`, and brings its own collections.
//       collections  a count or a list of partial collections (each merged
//                    over fixtureCollection(i)), when there is no catalogShape.
//     The handle also carries { mode, sync, collections, syncResult }.
//   fixtureProduct(i, over)        one Shopify-shaped product for writeProduct
//   fixtureCollection(i, over)     one Shopify-shaped collection for the sync
//   catalogFor(shape)              -> { products, collections } of a shape
//   stageMigrations(stage, all)    the migrations a stage holds
//   removeFixtureFiles(name)       remove every .test-<name>-*.db file
//
// The caller sets TURSO_DB_URL / DATABASE_URL / PLATFORM_* in its own process
// before importing lib/ modules, as every suite does; makePlatform only sets
// PLATFORM_DB_URL, PLATFORM_DB_TOKEN and (when unset) PLATFORM_SECRET.
// Existing suites are not moved onto this helper.
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STAGES = Object.freeze(["0017", "0020", "0022", "0023", "0024", "0025", "0027", "latest"]);
export const MODES = Object.freeze(["legacy", "documents"]);
export const SYNCS = Object.freeze(["none", "complete", "partial", "failed"]);
export const CATALOG_SHAPES = Object.freeze(["one", "few", "many", "all_sold_out", "no_images", "long_titles", "empty", "no_collections"]);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function assertLocalDbUrl(url) {
  const s = typeof url === "string" ? url.trim() : "";
  // file: only. libsql://, https://, ws://, http://127.0.0.1 (a sqld) and a
  // bare path are all refused here; the harness's sqld has its own helpers.
  if (!/^file:/i.test(s) || /^file:\/\/[^/]/i.test(s)) {
    throw new Error(`tenant-fixture: refusing "${String(url).slice(0, 80)}": only local file: databases are allowed`);
  }
  return s;
}

function checkName(name) {
  if (!NAME_RE.test(String(name ?? ""))) throw new Error(`tenant-fixture: name "${name}" must be lower-case letters, digits and -`);
  return name;
}

export function stageMigrations(stage, all) {
  if (!STAGES.includes(stage)) throw new Error(`tenant-fixture: unknown stage "${stage}" (use ${STAGES.join(", ")})`);
  if (stage === "latest") return all.slice();
  // "0023_document_refs" <= "0023" is false as strings, so compare the number
  return all.filter((m) => m.id.slice(0, 4) <= stage);
}

export function fixtureProduct(i = 1, over = {}) {
  const n = Number(i) || 1;
  const id = over.id || `gid://shopify/Product/${9100 + n}`;
  const handle = over.handle || `fixture-product-${n}`;
  const title = over.title || `Fixture product ${n}`;
  const price = String(over.price ?? 100 * n);
  const base = {
    id,
    handle,
    title,
    description: `${title} description`,
    descriptionHtml: `<p>${title} description</p>`,
    productType: "Fixture",
    vendor: "Fixture Labs",
    tags: ["fixture"],
    priceRange: { minVariantPrice: { amount: price, currencyCode: "INR" }, maxVariantPrice: { amount: price, currencyCode: "INR" } },
    availableForSale: true,
    totalInventory: 10,
    featuredImage: { url: `https://cdn.shopify.com/fixture/${handle}.png`, altText: title },
    images: { nodes: [{ url: `https://cdn.shopify.com/fixture/${handle}.png`, altText: title, width: 800, height: 800 }] },
    options: [],
    variants: {
      nodes: [{ id: `gid://shopify/ProductVariant/${9100 + n}1`, title: "Default Title", sku: `FX-${n}`, price: { amount: price, currencyCode: "INR" }, availableForSale: true, selectedOptions: [], image: null }],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const { price: _p, ...rest } = over;
  return { ...base, ...rest };
}

// One Shopify-shaped collection, as the sync's collections reader hands it
// over: its members are `products.nodes` ([{ id }]). `over.productIds` is a
// short way to give the members.
export function fixtureCollection(i = 1, over = {}) {
  const n = Number(i) || 1;
  const handle = over.handle || `fixture-collection-${n}`;
  const title = over.title || `Fixture collection ${n}`;
  const { productIds, ...rest } = over;
  const base = {
    id: `gid://shopify/Collection/${9200 + n}`,
    handle,
    title,
    description: `${title} description`,
    image: { url: `https://cdn.shopify.com/fixture/${handle}.png`, altText: title },
    updatedAt: "2026-01-01T00:00:00Z",
    products: { nodes: (productIds || []).map((id) => ({ id })) },
  };
  return { ...base, ...rest };
}

const LONG_WORDS = "Hand-finished everyday piece in a generous size with a soft brushed surface, made to last, easy to care for and ready to wear or use from the first day it arrives at your door";
const longTitle = (n) => `Fixture product ${n}: ${LONG_WORDS}, edition ${n}`; // over 200 characters
const longImage = (name) => `https://cdn.shopify.com/s/files/1/0000/0001/fixture/${"long-path-segment-".repeat(26)}${name}.png?v=1700000000`; // over 500

const soldOut = (p) => ({
  ...p,
  availableForSale: false,
  totalInventory: 0,
  variants: { nodes: p.variants.nodes.map((v) => ({ ...v, availableForSale: false })) },
});
const noImages = (p) => ({ ...p, featuredImage: null, images: { nodes: [] }, variants: { nodes: p.variants.nodes.map((v) => ({ ...v, image: null })) } });
const products = (count, map = (p) => p) => Array.from({ length: count }, (_, i) => map(fixtureProduct(i + 1)));
// `groups` collections splitting the products in order
const split = (list, groups, over = () => ({})) =>
  Array.from({ length: groups }, (_, g) => {
    const size = Math.ceil(list.length / groups);
    return fixtureCollection(g + 1, { productIds: list.slice(g * size, (g + 1) * size).map((p) => p.id), ...over(g + 1) });
  });

// The catalog of a preset: { products, collections }, built fresh each call.
export function catalogFor(shape) {
  switch (shape) {
    case "one": {
      const p = products(1);
      return { products: p, collections: split(p, 1) };
    }
    case "few": {
      const p = products(4);
      return { products: p, collections: split(p, 2) };
    }
    case "many": {
      const p = products(40);
      return { products: p, collections: split(p, 4) };
    }
    case "all_sold_out": {
      const p = products(4, soldOut);
      return { products: p, collections: split(p, 1) };
    }
    case "no_images": {
      const p = products(4, noImages);
      return { products: p, collections: split(p, 1, () => ({ image: null })) };
    }
    case "long_titles": {
      const p = Array.from({ length: 3 }, (_, i) => {
        const n = i + 1;
        const title = longTitle(n);
        const url = longImage(`fixture-product-${n}`);
        return fixtureProduct(n, {
          title,
          description: `${title} description`,
          descriptionHtml: `<p>${title} description</p>`,
          featuredImage: { url, altText: title },
          images: { nodes: [{ url, altText: title, width: 800, height: 800 }] },
        });
      });
      return { products: p, collections: split(p, 1, (n) => ({ title: `Fixture collection ${n}: ${LONG_WORDS}, edition ${n}`, image: { url: longImage(`fixture-collection-${n}`), altText: `Fixture collection ${n}` } })) };
    }
    case "empty":
      return { products: [], collections: [] };
    case "no_collections":
      return { products: products(4), collections: [] };
    default:
      throw new Error(`tenant-fixture: unknown catalogShape "${shape}" (use ${CATALOG_SHAPES.join(", ")})`);
  }
}

async function removeDbFile(file) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, `${file}${suffix}`), { force: true });
}

export async function removeFixtureFiles(name) {
  checkName(name);
  const prefix = `.test-${name}-`;
  for (const f of await readdir(ROOT)) if (f.startsWith(prefix) && /\.db(-wal|-shm|-journal)?$/.test(f)) await rm(join(ROOT, f), { force: true });
}

let platform = null;

export async function makePlatform({ name = "p4" } = {}) {
  checkName(name);
  const file = `.test-${name}-platform.db`;
  const url = assertLocalDbUrl(`file:${file}`);
  await removeDbFile(file);
  process.env.PLATFORM_DB_URL = url;
  process.env.PLATFORM_DB_TOKEN = "";
  if (!process.env.PLATFORM_SECRET) process.env.PLATFORM_SECRET = "test-platform-secret";
  const C = await import("../../lib/platform/control.js");
  const { loadMigrations, runMigrations } = await import("../../lib/platform/migrate.js");
  C.__resetPlatformClient();
  await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
  platform = { name, file, url, control: C };
  return {
    ...platform,
    cleanup: async () => {
      C.__resetPlatformClient();
      if (platform?.file === file) platform = null;
      await removeDbFile(file);
    },
  };
}

// Stages are compared by their 4-digit number; 'latest' holds everything.
const atLeast = (stage, min) => stage === "latest" || stage >= min;

// The options P6-FIXTURE added, checked before any file is made.
function checkOptions({ stage, mode, sync, catalogShape, products, collections }) {
  if (!MODES.includes(mode)) throw new Error(`tenant-fixture: unknown mode "${mode}" (use ${MODES.join(", ")})`);
  if (!SYNCS.includes(sync)) throw new Error(`tenant-fixture: unknown sync "${sync}" (use ${SYNCS.join(", ")})`);
  if (catalogShape != null && !CATALOG_SHAPES.includes(catalogShape)) throw new Error(`tenant-fixture: unknown catalogShape "${catalogShape}" (use ${CATALOG_SHAPES.join(", ")})`);
  const hasProducts = typeof products === "number" ? products > 0 : (products || []).length > 0;
  const hasCollections = typeof collections === "number" ? collections > 0 : (collections || []).length > 0;
  if (catalogShape != null && (hasProducts || hasCollections)) throw new Error("tenant-fixture: give a catalogShape or products/collections, not both");
  // DOCUMENTS_FOR_FRESH_STORE_SQL reads every CONTENT_TABLES table (0024 adds the last ones)
  if (mode === "documents" && !atLeast(stage, "0024")) throw new Error(`tenant-fixture: mode "documents" needs stage 0024 or later, not "${stage}"`);
  // a recorded run needs the resumable sync_runs columns (0020)
  if (sync !== "none" && !atLeast(stage, "0020")) throw new Error(`tenant-fixture: sync "${sync}" needs stage 0020 or later, not "${stage}"`);
}

// The catalog's page readers. 'complete' hands the whole catalog to the real
// sync as one page each ({ products, collections }, the shape runCatalogSync
// documents for tests). 'partial' and 'failed' read products in two pages: the
// first half, then the rest. `afterFirst` runs once the first page is read.
function fixtureFetchers(list, cols, sync, afterFirst = () => {}) {
  if (sync === "complete") return { products: async () => list, collections: async () => cols };
  const half = Math.ceil(list.length / 2);
  return {
    productsPage: async (cursor) => {
      if (cursor == null) {
        afterFirst();
        return { nodes: list.slice(0, half), endCursor: "fixture-page-2", hasNextPage: true };
      }
      if (sync === "failed") throw new Error("tenant-fixture: Shopify stopped answering on the second page");
      return { nodes: list.slice(half), endCursor: null, hasNextPage: false };
    },
    collectionsPage: async () => ({ nodes: cols, endCursor: null, hasNextPage: false }),
  };
}

const NO_INDEX = async () => ({ indexed: 0 });

// Runs inside withTenant. Every row it leaves is one lib/sync.js wrote:
//   complete  runCatalogSync to the end (products, collections, prune, index)
//   partial   one runSyncSlice that commits the first products page, then
//             yields on its deadline: the run stays 'running' (phase products)
//   failed    runCatalogSync whose second products page throws: inline, the
//             run is marked 'failed', the first page kept
// -> the latest sync_runs row, plus runCatalogSync's answer for 'complete'
async function fixtureSync(list, cols, sync) {
  const S = await import("../../lib/sync.js");
  if (sync === "complete") {
    const out = await S.runCatalogSync({ fetchers: fixtureFetchers(list, cols, sync), indexer: NO_INDEX });
    return { ...out, run: await S.latestSyncRun() };
  }
  if (sync === "failed") {
    let error = null;
    try {
      await S.runCatalogSync({ fetchers: fixtureFetchers(list, cols, sync), indexer: NO_INDEX });
    } catch (e) {
      error = e.message;
    }
    const run = await S.latestSyncRun();
    if (run?.status !== "failed") throw new Error(`tenant-fixture: the failed sync ended "${run?.status}" (${error})`);
    return { error, run };
  }
  // partial: a clock that jumps past the deadline once the first page is read
  let clock = 0;
  const fetchers = fixtureFetchers(list, cols, sync, () => {
    clock = 2e12;
  });
  const { run: started } = await S.requestCatalogSync({ fetchers });
  const res = await S.runSyncSlice(started.id, { deadline: 1e12, now: () => clock, fetchers, indexer: NO_INDEX });
  const run = await S.latestSyncRun();
  if (!res.yielded || run?.status !== "running") throw new Error(`tenant-fixture: the partial sync did not stop partway (${JSON.stringify({ yielded: res.yielded, status: run?.status })})`);
  return { run };
}

export async function makeTenant({ name, stage = "latest", products = [], id, config = {}, secrets = {}, mode = "legacy", sync = "none", catalogShape = null, collections = [] } = {}) {
  checkName(name);
  stageMigrations(stage, []); // an unknown stage is refused before any file is made
  checkOptions({ stage, mode, sync, catalogShape, products, collections });
  // documents fixtures: direct checkout set explicitly, so nothing depends on
  // process.env.CHECKOUT_MODE (the caller's own checkout_mode still wins)
  if (mode === "documents") config = { checkout_mode: "direct", ...config };
  const file = `.test-${name}-tenant.db`;
  const url = assertLocalDbUrl(`file:${file}`);
  const tenantId = id || name;
  await removeDbFile(file);

  const { createClient } = await import("@libsql/client");
  const { loadMigrations, runMigrations } = await import("../../lib/platform/migrate.js");
  const { withTenant } = await import("../../lib/tenant-context.js");
  const { writeProduct } = await import("../../lib/sync.js");
  const MIGRATIONS = await loadMigrations("tenant");

  let tenant;
  if (platform) {
    await platform.control.upsertTenant({ id: tenantId, name, domains: [`${tenantId}.test`], dbUrl: url, config, secrets: { order_link_secret: `${tenantId}-secret`, ...secrets } });
    tenant = await platform.control.getTenant(tenantId, { fresh: true });
  } else {
    tenant = { id: tenantId, name, status: "active", domains: [`${tenantId}.test`], dbUrl: url, dbToken: null, config, secrets: { order_link_secret: `${tenantId}-secret`, ...secrets } };
  }
  assertLocalDbUrl(tenant.dbUrl);

  const migrateTo = async (s) => {
    const c = createClient({ url });
    try {
      return await runMigrations(c, stageMigrations(s, MIGRATIONS));
    } finally {
      c.close();
    }
  };
  await migrateTo(stage);

  // FIRST, on the fresh database: the content mode, the way provisioning sets it
  if (mode === "documents") {
    const { applyContentMode } = await import("../../lib/platform/provision.js");
    const c = createClient({ url });
    let r;
    try {
      r = await applyContentMode(c, { contentMode: "documents" });
    } finally {
      c.close();
    }
    if (r.contentMode !== "documents") throw new Error(`tenant-fixture: the store did not move to documents: ${r.contentModeReason}`);
  } else if (mode === "legacy" && (stage === "latest" || stage >= "0021")) {
    const c = createClient({ url });
    try {
      await c.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
    } catch {
      // pre-0021 stage without cms_state
    } finally {
      c.close();
    }
  }

  let list;
  let cols;
  if (catalogShape != null) ({ products: list, collections: cols } = catalogFor(catalogShape));
  else {
    list = typeof products === "number" ? Array.from({ length: products }, (_, i) => fixtureProduct(i + 1)) : (products || []).map((p, i) => fixtureProduct(i + 1, p || {}));
    const allIds = list.map((p) => p.id);
    cols = typeof collections === "number" ? Array.from({ length: collections }, (_, i) => fixtureCollection(i + 1, { productIds: allIds })) : (collections || []).map((c, i) => fixtureCollection(i + 1, c || {}));
  }
  const syncedAt = new Date().toISOString();
  const run = (fn) => withTenant(tenant, fn);
  let syncResult = null;
  if (sync === "none") {
    for (const p of list) await run(() => writeProduct(p, syncedAt, null));
    if (cols.length) {
      const { writeCollection } = await import("../../lib/sync.js");
      for (const c of cols) await run(() => writeCollection(c));
    }
  } else {
    syncResult = await run(() => fixtureSync(list, cols, sync));
  }

  return {
    mode,
    sync,
    collections: cols,
    syncResult,
    id: tenantId,
    name,
    file,
    url,
    stage,
    migrations: stageMigrations(stage, MIGRATIONS).map((m) => m.id),
    tenant,
    products: list,
    run,
    client: () => createClient({ url }),
    migrateTo,
    cleanup: () => removeDbFile(file),
  };
}
