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
//       stage     '0017' | '0020' | '0022' | '0023' | '0024' | 'latest'
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
//   fixtureProduct(i, over)        one Shopify-shaped product for writeProduct
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

export const STAGES = Object.freeze(["0017", "0020", "0022", "0023", "0024", "latest"]);
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

export async function makeTenant({ name, stage = "latest", products = [], id, config = {}, secrets = {} } = {}) {
  checkName(name);
  stageMigrations(stage, []); // an unknown stage is refused before any file is made
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

  const list = typeof products === "number" ? Array.from({ length: products }, (_, i) => fixtureProduct(i + 1)) : (products || []).map((p, i) => fixtureProduct(i + 1, p || {}));
  const syncedAt = new Date().toISOString();
  const run = (fn) => withTenant(tenant, fn);
  for (const p of list) await run(() => writeProduct(p, syncedAt, null));

  return {
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
