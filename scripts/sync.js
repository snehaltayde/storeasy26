// Sync the BeastLife catalog: Shopify Storefront API → Turso (libSQL) → Typesense.
//   pnpm sync               # full pull + DB write + search index
//   pnpm sync:search        # reindex Typesense from the local DB (no Shopify pull)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { libsql, db } from "../lib/db.js";
import {
  fetchAllProducts as fetchProductsStorefront,
  fetchAllCollections as fetchCollectionsStorefront,
} from "../lib/shopify.js";
import { fetchAllProductsAdmin, fetchAllCollectionsAdmin } from "../lib/shopify-admin-catalog.js";

// Prefer the Storefront API when a token exists (buyer-facing semantics);
// otherwise pull from the Admin API (the single-credential setup).
const HAS_STOREFRONT = !!(
  process.env.SHOPIFY_STOREFRONT_TOKEN || process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN
);
const HAS_ADMIN = !!(
  process.env.SHOPIFY_ADMIN_TOKEN ||
  (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)
);
const CATALOG_SOURCE = HAS_STOREFRONT ? "storefront" : HAS_ADMIN ? "admin" : null;
const fetchAllProducts = CATALOG_SOURCE === "admin" ? fetchAllProductsAdmin : fetchProductsStorefront;
const fetchAllCollections =
  CATALOG_SOURCE === "admin" ? fetchAllCollectionsAdmin : fetchCollectionsStorefront;
import {
  getAdminClient,
  typesenseConfigured,
  productsCollectionSchema,
  PRODUCTS_COLLECTION,
} from "../lib/typesense.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEARCH_ONLY = process.argv.includes("--search-only");

const nowIso = () => new Date().toISOString();
const num = (x) => (x == null || x === "" ? null : Number(x));

async function ensureSchema() {
  const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
  await libsql.executeMultiple(schema);
}

async function upsert(table, row, conflictCol = "id") {
  const updateSet = Object.fromEntries(
    Object.entries(row).filter(([k]) => k !== conflictCol),
  );
  await db
    .insertInto(table)
    .values(row)
    .onConflict((oc) => oc.column(conflictCol).doUpdateSet(updateSet))
    .execute();
}

async function insertRows(table, rows, chunk = 80) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    if (slice.length) await db.insertInto(table).values(slice).execute();
  }
}

async function syncCatalog() {
  if (!CATALOG_SOURCE) {
    throw new Error(
      "No Shopify credentials found. Set SHOPIFY_ADMIN_TOKEN (or SHOPIFY_CLIENT_ID/SECRET), or a Storefront token.",
    );
  }
  console.log(`→ catalog source: ${CATALOG_SOURCE}`);
  console.log("→ pulling products from Shopify…");
  const products = await fetchAllProducts({
    pageSize: 50,
    onPage: (count) => process.stdout.write(`\r  fetched ${count} products…`),
  });
  process.stdout.write("\n");

  console.log("→ pulling collections from Shopify…");
  const collections = await fetchAllCollections({
    pageSize: 50,
    productsFirst: 250,
    onPage: (count) => process.stdout.write(`\r  fetched ${count} collections…`),
  });
  process.stdout.write("\n");

  const syncedAt = nowIso();
  const productIds = new Set(products.map((p) => p.id));

  console.log("→ writing products (+ images + variants)…");
  for (const p of products) {
    const currency = p.priceRange?.minVariantPrice?.currencyCode || null;

    await upsert("products", {
      id: p.id,
      handle: p.handle,
      title: p.title,
      description: p.description || null,
      description_html: p.descriptionHtml || null,
      product_type: p.productType || null,
      vendor: p.vendor || null,
      tags: JSON.stringify(p.tags || []),
      price_min: num(p.priceRange?.minVariantPrice?.amount),
      price_max: num(p.priceRange?.maxVariantPrice?.amount),
      compare_at_min: num(p.compareAtPriceRange?.minVariantPrice?.amount) || null,
      currency,
      available: p.availableForSale ? 1 : 0,
      total_inventory: p.totalInventory ?? null,
      featured_image: p.featuredImage?.url || null,
      featured_image_alt: p.featuredImage?.altText || null,
      options: JSON.stringify(p.options || []),
      created_at: p.createdAt || null,
      updated_at: p.updatedAt || null,
      synced_at: syncedAt,
    });

    await db.deleteFrom("product_images").where("product_id", "=", p.id).execute();
    await insertRows(
      "product_images",
      (p.images?.nodes || []).map((img, i) => ({
        id: `${p.id}::img::${i}`,
        product_id: p.id,
        url: img.url,
        alt: img.altText || null,
        width: img.width ?? null,
        height: img.height ?? null,
        position: i,
      })),
    );

    await db.deleteFrom("variants").where("product_id", "=", p.id).execute();
    await insertRows(
      "variants",
      (p.variants?.nodes || []).map((v, i) => ({
        id: v.id,
        product_id: p.id,
        title: v.title || null,
        sku: v.sku || null,
        price: num(v.price?.amount),
        compare_at_price: num(v.compareAtPrice?.amount) || null,
        currency: v.price?.currencyCode || currency,
        available: v.availableForSale ? 1 : 0,
        selected_options: JSON.stringify(v.selectedOptions || []),
        image_url: v.image?.url || null,
        position: i,
      })),
    );
  }
  console.log(`  ✓ ${products.length} products written`);

  console.log("→ writing collections + memberships…");
  for (const c of collections) {
    await upsert("collections", {
      id: c.id,
      handle: c.handle,
      title: c.title,
      description: c.description || null,
      image: c.image?.url || null,
      image_alt: c.image?.altText || null,
      updated_at: c.updatedAt || null,
      synced_at: syncedAt,
    });

    await db.deleteFrom("collection_products").where("collection_id", "=", c.id).execute();
    const members = (c.products?.nodes || [])
      .map((n, i) => ({ collection_id: c.id, product_id: n.id, position: i }))
      .filter((m) => productIds.has(m.product_id));
    await insertRows("collection_products", members);

    if (c.products?.pageInfo?.hasNextPage) {
      console.warn(`  ! collection "${c.handle}" has >250 products; indexed first 250`);
    }
  }
  console.log(`  ✓ ${collections.length} collections written`);
}

async function indexTypesense() {
  if (!typesenseConfigured()) {
    console.log("• Typesense not configured — skipped. Search uses the DB fallback until you set TYPESENSE_* in .env.local, then run `pnpm sync:search`.");
    return;
  }

  const client = getAdminClient();
  console.log("→ (re)creating Typesense collection…");
  try {
    await client.collections(PRODUCTS_COLLECTION).delete();
  } catch {
    /* collection didn't exist yet */
  }
  await client.collections().create(productsCollectionSchema);

  const rows = await db
    .selectFrom("products")
    .select([
      "handle",
      "title",
      "description",
      "product_type",
      "vendor",
      "tags",
      "price_min",
      "currency",
      "available",
      "featured_image",
    ])
    .execute();

  const docs = rows.map((r) => {
    let tags = [];
    try {
      tags = JSON.parse(r.tags || "[]");
    } catch {
      tags = [];
    }
    return {
      id: r.handle,
      handle: r.handle,
      title: r.title,
      description: r.description || "",
      product_type: r.product_type || "",
      vendor: r.vendor || "",
      tags,
      image: r.featured_image || "",
      price: r.price_min ?? 0,
      currency: r.currency || "INR",
      available: !!r.available,
    };
  });

  if (!docs.length) {
    console.log("  (no products to index yet)");
    return;
  }

  const results = await client
    .collections(PRODUCTS_COLLECTION)
    .documents()
    .import(docs, { action: "upsert" });
  const failed = results.filter((x) => x && x.success === false);
  console.log(`  ✓ indexed ${docs.length - failed.length}/${docs.length} products into Typesense`);
  if (failed.length) console.warn("  ! sample failure:", failed[0]);
}

async function main() {
  await ensureSchema();
  if (SEARCH_ONLY) {
    console.log("• --search-only: reindexing from the local DB (no Shopify pull)");
  } else {
    await syncCatalog();
  }
  await indexTypesense();
  console.log("✓ sync complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ sync failed:", err.message);
  process.exit(1);
});
