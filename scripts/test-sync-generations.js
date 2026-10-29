// Catalog-sync generation suite (Session 30 / BE04+BE25): generation stamping,
// prune-only-after-a-COMPLETE-run, webhook-race protection, failed-partial
// safety, missed-delete repair, run bookkeeping, and the OAuth scope check.
//   pnpm test:sync-generations
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-gen-default.db";
process.env.PLATFORM_DB_URL = "file:.test-gen-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
delete process.env.TYPESENSE_HOST; // search skipped (non-fatal path)

const dbs = [".test-gen-default.db", ".test-gen-platform.db", ".test-gen-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const S = await import("../lib/sync.js");
const O = await import("../lib/platform/oauth.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { applyTenantSchema } = await import("../lib/platform/provision.js");
const { migratePlatform } = C;
const { readFile } = await import("node:fs/promises");

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
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// fixtures: tenant DB bootstrapped THROUGH the migration ledger (sync_runs etc.)
await migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "sg", name: "SyncGen", domains: [], dbUrl: "file:.test-gen-t1.db", config: {}, secrets: {} });
await applyTenantSchema(createClient({ url: "file:.test-gen-t1.db" }));
const SG = await C.getTenant("sg");
const inT = (fn) => withTenant(SG, fn);

const P = (n, title = `Product ${n}`) => ({
  id: `gid://shopify/Product/${n}`,
  handle: `p${n}`,
  title,
  availableForSale: true,
  tags: [],
  priceRange: { minVariantPrice: { amount: "100", currencyCode: "INR" }, maxVariantPrice: { amount: "100", currencyCode: "INR" } },
  images: { nodes: [{ url: `https://img/${n}.jpg` }] },
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${n}0`, title: "Default", availableForSale: true, price: { amount: "100", currencyCode: "INR" } }] },
});
const COLL = (id, members) => ({
  id: `gid://shopify/Collection/${id}`,
  handle: `c${id}`,
  title: `Collection ${id}`,
  products: { nodes: members.map((m) => ({ id: `gid://shopify/Product/${m}` })) },
});
const fetchersFor = (prods, colls, { onProducts = null } = {}) => ({
  products: async ({ onPage } = {}) => {
    if (onProducts) await onProducts();
    if (onPage) await onPage(prods.length, "cursor-xyz");
    return prods;
  },
  collections: async () => colls,
});

const productIds = () => inT(() => db.selectFrom("products").select(["id", "sync_generation"]).execute());
const count = async (table) => Number((await inT(() => db.selectFrom(table).select((eb) => eb.fn.countAll().as("n")).executeTakeFirst())).n);

// --- 1. first complete run -----------------------------------------------------
let gen1;
await t("complete run: rows stamped with the generation; sync_runs records counts + cursor", async () => {
  const res = await inT(() => S.runCatalogSync({ fetchers: fetchersFor([P(1), P(2)], [COLL("a", [1, 2])]) }));
  gen1 = res.runId;
  ok(gen1?.startsWith("sync_"), "run id");
  eq(res.products, 2, "products");
  eq(res.pruned.products, 0, "nothing to prune yet");
  const rows = await productIds();
  eq(rows.length, 2, "two rows");
  ok(rows.every((r) => r.sync_generation === gen1), "stamped");
  const [run] = await inT(() => S.listSyncRuns({ limit: 1 }));
  eq(run.status, "complete", "run complete");
  eq(Number(run.products), 2, "run count");
  eq(run.cursor, "cursor-xyz", "cursor recorded");
  eq(await count("variants"), 2, "variants written");
});

// --- 2. missed delete repaired by the next complete run --------------------------
await t("missed delete: a product absent from the next complete run is pruned with its children", async () => {
  const res = await inT(() => S.runCatalogSync({ fetchers: fetchersFor([P(1)], [COLL("a", [1])]) }));
  eq(res.pruned.products, 1, "one pruned");
  const rows = await productIds();
  eq(rows.length, 1, "only p1 left");
  eq(rows[0].id, "gid://shopify/Product/1", "p1 survives");
  eq(await count("variants"), 1, "p2's variant gone");
  const members = await inT(() => db.selectFrom("collection_products").selectAll().execute());
  eq(members.length, 1, "membership pruned");
});

// --- 3. webhook race: rows written DURING the run survive -------------------------
await t("webhook race: a row written mid-run (fresh synced_at, no generation) survives the prune", async () => {
  const res = await inT(() =>
    S.runCatalogSync({
      fetchers: fetchersFor([P(1)], [COLL("a", [1])], {
        onProducts: () => inT(() => S.writeProduct(P(9, "Webhook Nine"))), // webhook-style write, generation null
      }),
    }),
  );
  eq(res.pruned.products, 0, "webhook row NOT pruned");
  const rows = await productIds();
  ok(rows.some((r) => r.id === "gid://shopify/Product/9" && r.sync_generation === null), "p9 alive, unstamped");
});

// --- 4. failed partial run prunes NOTHING ------------------------------------------
await t("failed partial sync: run recorded as failed, no rows pruned (stale included)", async () => {
  // plant a STALE row (old generation, old synced_at) — prunable by a complete run
  await inT(() => S.writeProduct(P(7, "Stale Seven")));
  await inT(() =>
    db.updateTable("products").set({ sync_generation: "sync_ancient", synced_at: "2020-01-01T00:00:00.000Z" }).where("id", "=", "gid://shopify/Product/7").execute(),
  );
  const before = (await productIds()).length;
  let threw = false;
  try {
    await inT(() =>
      S.runCatalogSync({
        fetchers: {
          products: async () => [P(1)],
          collections: async () => {
            throw new Error("Shopify 500 midway");
          },
        },
      }),
    );
  } catch {
    threw = true;
  }
  eq(threw, true, "sync failed loudly");
  eq((await productIds()).length, before, "row count unchanged — nothing pruned");
  ok((await productIds()).some((r) => r.id === "gid://shopify/Product/7"), "stale row untouched by the FAILED run");
  const [run] = await inT(() => S.listSyncRuns({ limit: 1 }));
  eq(run.status, "failed", "run failed");
  ok(/midway/.test(run.error), "error recorded");
});

await t("…and the NEXT complete run repairs it (stale + webhook-gone-stale rows pruned)", async () => {
  // p9's synced_at is now old too (written in test 3) — a webhook-created row
  // that later vanished upstream must also age out on a complete run
  await inT(() => db.updateTable("products").set({ synced_at: "2020-01-02T00:00:00.000Z" }).where("id", "=", "gid://shopify/Product/9").execute());
  const res = await inT(() => S.runCatalogSync({ fetchers: fetchersFor([P(1)], [COLL("a", [1])]) }));
  eq(res.pruned.products, 2, "stale seven + stale nine pruned");
  const rows = await productIds();
  eq(rows.length, 1, "only the live row remains");
  eq(rows[0].id, "gid://shopify/Product/1", "p1");
});

// --- 5. collections prune the same way ----------------------------------------------
await t("collections: one absent from the complete run is pruned with memberships", async () => {
  await inT(() => S.runCatalogSync({ fetchers: fetchersFor([P(1)], [COLL("a", [1]), COLL("b", [1])]) }));
  eq(await count("collections"), 2, "two collections");
  const res = await inT(() => S.runCatalogSync({ fetchers: fetchersFor([P(1)], [COLL("a", [1])]) }));
  eq(res.pruned.collections, 1, "collection b pruned");
  eq(await count("collections"), 1, "one left");
});

// --- 6. searchOnly runs skip generations entirely -------------------------------------
await t("searchOnly: no sync_runs row, no prune", async () => {
  const runsBefore = (await inT(() => S.listSyncRuns({ limit: 50 }))).length;
  const res = await inT(() => S.runCatalogSync({ searchOnly: true }));
  eq(res.runId, undefined, "no run id");
  eq((await inT(() => S.listSyncRuns({ limit: 50 }))).length, runsBefore, "no new run row");
});

// --- 7. BE25: scope check at mint time -------------------------------------------------
await t("missingScopes: full grant passes; partial grant names what's absent", () => {
  eq(O.missingScopes(O.OAUTH_SCOPES).length, 0, "full grant");
  const partial = O.OAUTH_SCOPES.split(",").filter((s) => s !== "write_orders" && s !== "read_orders").join(",");
  const missing = O.missingScopes(partial);
  ok(missing.includes("write_orders") && missing.includes("read_orders"), "names missing scopes");
  eq(O.missingScopes("").length, O.OAUTH_SCOPES.split(",").length, "empty grant misses all");
  ok(O.missingScopes(` ${O.OAUTH_SCOPES.split(",").join(" , ")} `).length === 0, "whitespace tolerated");
  // S51: Shopify implies read when write is granted and echoes only write_x —
  // the real pavos grant (write_orders, no read_orders) must NOT alarm.
  const impliedRead = O.OAUTH_SCOPES.split(",").filter((s) => s !== "read_orders").join(",");
  eq(O.missingScopes(impliedRead).length, 0, "write_orders satisfies read_orders");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
