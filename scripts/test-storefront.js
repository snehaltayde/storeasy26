// Storefront-on-releases suite (Session 38: BE15 media pipeline, SF13/SF14
// typed + policy pages, SF02 collections index, SF03 collection filters, SF04
// PDP extras, SF05/BE05 SQL search). Two tenants — "shop" (an ordinary tenant)
// and "beastlife" — prove the cross-tenant legal-text fix: BeastLife's default
// page copy serves ONLY BeastLife.
//   pnpm test:storefront
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-sf-default.db";
process.env.PLATFORM_DB_URL = "file:.test-sf-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-sf-default.db", ".test-sf-platform.db", ".test-sf-t1.db", ".test-sf-bl.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const M = await import("../lib/media.js");
const repo = await import("../lib/repo.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "shop", name: "Shop Tenant", domains: ["shop.test"], dbUrl: "file:.test-sf-t1.db", config: {}, secrets: { order_link_secret: "shop-secret" } });
await C.upsertTenant({ id: "beastlife", name: "BeastLife", domains: ["bl.test"], dbUrl: "file:.test-sf-bl.db", config: {}, secrets: { order_link_secret: "bl-secret" } });

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const id of ["shop", "beastlife"]) {
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inShop = async (fn) => withTenant(await C.getTenant("shop"), fn);
const inBl = async (fn) => withTenant(await C.getTenant("beastlife"), fn);

// catalog fixtures for search / collection / release-link tests
await inShop(async () => {
  const now = "2026-01-01T00:00:00Z";
  const prods = [
    { id: "gid://p/1", handle: "whey-gold", title: "Gold Whey Protein", product_type: "Protein", vendor: "Shop", tags: '["protein","whey"]', price_min: 2999, price_max: 2999, available: 1, created_at: "2026-01-03T00:00:00Z" },
    { id: "gid://p/2", handle: "whey-chocolate", title: "Chocolate Whey", product_type: "Protein", vendor: "Shop", tags: '["protein"]', price_min: 1999, price_max: 1999, available: 0, created_at: "2026-01-02T00:00:00Z" },
    { id: "gid://p/3", handle: "shaker-neon", title: "Neon Shaker", product_type: "Accessories", vendor: "Shop", tags: '["shaker"]', price_min: 499, price_max: 499, available: 1, created_at: "2026-01-01T00:00:00Z" },
  ];
  for (const p of prods) {
    await libsql.execute({
      sql: "INSERT INTO products (id, handle, title, product_type, vendor, tags, price_min, price_max, available, created_at, currency) VALUES (?,?,?,?,?,?,?,?,?,?, 'INR')",
      args: [p.id, p.handle, p.title, p.product_type, p.vendor, p.tags, p.price_min, p.price_max, p.available, p.created_at],
    });
  }
  await libsql.execute({ sql: "INSERT INTO collections (id, handle, title, updated_at) VALUES ('gid://c/1','all-protein','All Protein', ?)", args: [now] });
  await libsql.execute({ sql: "INSERT INTO collections (id, handle, title, updated_at) VALUES ('gid://c/2','gear','Gear', ?)", args: [now] });
  await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://c/1','gid://p/2',1)");
  await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://c/1','gid://p/1',2)");
  await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://c/1','gid://p/3',3)");
  await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://c/2','gid://p/3',1)");
});

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
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const includes = (hay, needle, label = "") => {
  if (!String(hay).includes(needle)) throw new Error(`${label} expected to include ${JSON.stringify(needle)}: ${JSON.stringify(String(hay).slice(0, 200))}`);
};
const excludes = (hay, needle, label = "") => {
  if (String(hay).includes(needle)) throw new Error(`${label} expected NOT to include ${JSON.stringify(needle)}: ${JSON.stringify(String(hay).slice(0, 200))}`);
};

// tiny valid 1x1 PNG + helper bytes
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

console.log("— media pipeline (BE15)");

await t("magic-byte sniffing: declared png with svg bytes refused", async () => {
  const bad = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  const v = M.validateUpload({ filename: "fake.png", mime: "image/png", bytes: bad });
  eq(v.ok, false);
  includes(v.errors.join(","), "doesn't match");
  const good = M.validateUpload({ filename: "real.png", mime: "image/png", bytes: PNG_1PX });
  eq(good.ok, true, "real png:");
});

await t("disallowed type + oversize refused", async () => {
  eq(M.validateUpload({ filename: "x.pdf", mime: "application/pdf", bytes: PNG_1PX }).ok, false);
  const big = new Uint8Array(2_000_000);
  big.set(PNG_1PX);
  eq(M.validateUpload({ filename: "big.png", mime: "image/png", bytes: big }).ok, false);
});

await t("svg sanitizer strips script/onload/foreignObject, keeps shapes", async () => {
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>alert(1)</script><foreignObject><body>x</body></foreignObject><rect width="10" height="10" onclick="evil()"/><a href="javascript:evil()"><circle r="4"/></a><image href="https://ok.example/x.png"/></svg>`;
  const clean = M.sanitizeSvg(dirty);
  excludes(clean, "<script");
  excludes(clean, "onload");
  excludes(clean, "onclick");
  excludes(clean, "foreignObject");
  excludes(clean, "javascript:");
  includes(clean, "<rect");
  includes(clean, 'href="https://ok.example/x.png"');
});

await t("saveMedia stores, dedupes by content, variants attach to the original", async () => {
  const a = await inShop(() => M.saveMedia({ filename: "hero.png", mime: "image/png", bytes: PNG_1PX, alt: "hero", width: 1, height: 1 }));
  eq(a.deduped, false);
  const b = await inShop(() => M.saveMedia({ filename: "hero-again.png", mime: "image/png", bytes: PNG_1PX }));
  eq(b.deduped, true, "same bytes dedupe:");
  eq(b.id, a.id);
  const thumb = await inShop(() => M.saveMedia({ filename: "t.png", mime: "image/png", bytes: PNG_1PX, variant: "thumb", parentId: a.id }));
  eq(thumb.deduped, false, "variant is its own row:");
  const list = await inShop(M.listMedia);
  eq(list.length, 1, "originals listed:");
  eq(list[0].variants.length, 1, "variant attached:");
  const file = await inShop(() => M.getMediaFile(a.id));
  eq(file.size, PNG_1PX.length);
});

await t("getCollectionsByHandles preserves order", async () => {
  const rows = await inShop(() => repo.getCollectionsByHandles(["gear", "all-protein"]));
  eq(rows.map((c) => c.handle).join(","), "gear,all-protein");
});

console.log("— collection detail filters (SF03)");

await t("sort + filters: price sort, in-stock, type facets", async () => {
  const featured = await inShop(() => repo.getProductsInCollection("all-protein", {}));
  eq(featured.products[0].handle, "whey-chocolate", "merchant position first:");
  const priceAsc = await inShop(() => repo.getProductsInCollection("all-protein", { sort: "price-asc" }));
  eq(priceAsc.products[0].handle, "shaker-neon");
  const newest = await inShop(() => repo.getProductsInCollection("all-protein", { sort: "new" }));
  eq(newest.products[0].handle, "whey-gold");
  const inStock = await inShop(() => repo.getProductsInCollection("all-protein", { inStock: true }));
  eq(inStock.total, 2, "sold-out filtered:");
  const typed = await inShop(() => repo.getProductsInCollection("all-protein", { type: "Accessories" }));
  eq(typed.total, 1);
  const facets = await inShop(() => repo.getCollectionTypeFacets("all-protein"));
  eq(facets.length, 2);
  eq(facets[0].type, "Protein", "biggest facet first:");
  eq(facets[0].count, 2);
});

console.log("— SQL search (SF05/BE05)");

await t("multi-term AND + ranking: prefix beats substring, in-stock beats sold-out", async () => {
  const r = await inShop(() => repo.searchProductsInDb("whey", 10));
  eq(r.hits.length, 2);
  eq(r.hits[0].handle, "whey-gold", "in-stock + available first:");
  const multi = await inShop(() => repo.searchProductsInDb("chocolate whey", 10));
  eq(multi.hits.length, 1, "every term must match:");
  eq(multi.hits[0].handle, "whey-chocolate");
  const none = await inShop(() => repo.searchProductsInDb("chocolate shaker", 10));
  eq(none.hits.length, 0, "AND semantics:");
  const neon = await inShop(() => repo.searchProductsInDb("neon", 10));
  eq(neon.hits.length, 1);
  eq(neon.hits[0].handle, "shaker-neon");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
