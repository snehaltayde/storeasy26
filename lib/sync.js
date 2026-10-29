import { db, libsql } from "./db.js";
import { tenantSecret, tenantCfg, tenantOwnSecret, tenantOwnCfg, currentTenant, withTenant } from "./tenant-context.js";
import {
  fetchAllProducts as fetchProductsStorefront,
  fetchAllCollections as fetchCollectionsStorefront,
} from "./shopify.js";
import {
  fetchAllProductsAdmin,
  fetchAllCollectionsAdmin,
  fetchProductAdmin,
  fetchCollectionAdmin,
} from "./shopify-admin-catalog.js";
import { getAdminClient, typesenseConfigured, productsCollectionSchema, productsCollection } from "./typesense.js";

// Catalog sync engine (Session 21) — extracted from scripts/sync.js so it runs
// per TENANT: `withTenant(t, () => runCatalogSync())` routes every read/write
// (Shopify creds, db, Typesense collection) through that tenant. The script
// stays a thin wrapper; webhooks use the single-entity functions below for
// incremental freshness (targeted REFETCH via Admin GraphQL → the exact same
// reshape/write path as the full sync — no third payload format to maintain).

const nowIso = () => new Date().toISOString();
const num = (x) => (x == null || x === "" ? null : Number(x));
const noop = () => {};

// S53 (audit A3): a PLATFORM tenant's source comes from ITS OWN row only —
// the env fallback used to let a credential-less tenant select the
// storefront source and then ingest the env-configured shop's catalog into
// its own database (wrong-shop ingestion). The env path remains for the
// legacy/_default store alone.
const platformTenant = () => {
  const t = currentTenant();
  return t && t.id !== "_default" ? t : null;
};

// Per-call source detection (tenant-own on the platform; env for legacy).
function catalogSource() {
  if (platformTenant()) {
    const hasStorefront = Boolean(
      tenantOwnCfg("shopify_store_domain", null, null) &&
        (tenantOwnSecret("shopify_storefront_token") || tenantOwnSecret("shopify_storefront_private_token")),
    );
    const hasAdmin = Boolean(
      tenantOwnSecret("shopify_admin_token") ||
        (tenantOwnCfg("shopify_client_id", null, null) && tenantOwnSecret("shopify_client_secret")),
    );
    return hasAdmin ? "admin" : hasStorefront ? "storefront" : null;
  }
  const hasStorefront = Boolean(
    tenantSecret("shopify_storefront_token", "SHOPIFY_STOREFRONT_TOKEN") ||
      tenantSecret("shopify_storefront_private_token", "SHOPIFY_STOREFRONT_PRIVATE_TOKEN"),
  );
  const hasAdmin = Boolean(
    tenantSecret("shopify_admin_token", "SHOPIFY_ADMIN_TOKEN") ||
      (tenantCfg("shopify_client_id", "SHOPIFY_CLIENT_ID") &&
        tenantSecret("shopify_client_secret", "SHOPIFY_CLIENT_SECRET")),
  );
  // Admin is preferred on the platform (single-credential onboarding).
  return hasAdmin ? "admin" : hasStorefront ? "storefront" : null;
}

// Storefront-source credentials: the tenant's own, verbatim (shopify.js
// throws on a provided-but-incomplete creds object instead of touching env);
// null = the legacy env-configured store.
function storefrontCreds() {
  if (!platformTenant()) return null;
  return {
    domain: tenantOwnCfg("shopify_store_domain", null, null),
    privateToken: tenantOwnSecret("shopify_storefront_private_token") || null,
    publicToken: tenantOwnSecret("shopify_storefront_token") || null,
  };
}

async function upsert(table, row, conflictCol = "id") {
  const updateSet = Object.fromEntries(Object.entries(row).filter(([k]) => k !== conflictCol));
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

// Write ONE storefront-shaped product (the exact S1 shape) + images + variants.
// `generation` (S30): full syncs stamp their run id; webhook writes leave it
// null — their fresh synced_at is what protects them from the post-run prune.
export async function writeProduct(p, syncedAt = nowIso(), generation = null) {
  const currency = p.priceRange?.minVariantPrice?.currencyCode || null;
  await upsert("products", {
    id: p.id,
    ...(generation !== null ? { sync_generation: generation } : {}),
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

export async function writeCollection(c, { onlyExistingProducts = true } = {}, syncedAt = nowIso(), generation = null) {
  await upsert("collections", {
    id: c.id,
    ...(generation !== null ? { sync_generation: generation } : {}),
    handle: c.handle,
    title: c.title,
    description: c.description || null,
    image: c.image?.url || null,
    image_alt: c.image?.altText || null,
    updated_at: c.updatedAt || null,
    synced_at: syncedAt,
  });
  await db.deleteFrom("collection_products").where("collection_id", "=", c.id).execute();
  let members = (c.products?.nodes || []).map((n, i) => ({
    collection_id: c.id,
    product_id: n.id,
    position: i,
  }));
  if (onlyExistingProducts && members.length) {
    const existing = new Set(
      (await db.selectFrom("products").select("id").execute()).map((r) => r.id),
    );
    members = members.filter((m) => existing.has(m.product_id));
  }
  await insertRows("collection_products", members);
}

// ---- incremental (webhook-driven) operations -------------------------------

export async function deleteProductByGid(gid) {
  await db.deleteFrom("variants").where("product_id", "=", gid).execute();
  await db.deleteFrom("product_images").where("product_id", "=", gid).execute();
  await db.deleteFrom("collection_products").where("product_id", "=", gid).execute();
  await db.deleteFrom("products").where("id", "=", gid).execute();
  return { deleted: gid };
}

export async function deleteCollectionByGid(gid) {
  await db.deleteFrom("collection_products").where("collection_id", "=", gid).execute();
  await db.deleteFrom("collections").where("id", "=", gid).execute();
  return { deleted: gid };
}

// Refetch one product from the Admin API and upsert; a product that is gone
// or no longer active is REMOVED (matching the full sync's status:active view).
export async function syncProductByGid(gid, { gql } = {}) {
  const p = await fetchProductAdmin(gid, { gql });
  if (!p) return deleteProductByGid(gid);
  await writeProduct(p);
  return { synced: gid, handle: p.handle };
}

export async function syncCollectionByGid(gid, { gql } = {}) {
  const c = await fetchCollectionAdmin(gid, { gql });
  if (!c) return deleteCollectionByGid(gid);
  await writeCollection(c);
  return { synced: gid, handle: c.handle, members: c.products?.nodes?.length ?? 0 };
}

// ---- search index ----------------------------------------------------------

// NON-FATAL since S21: a dead search cluster must never fail catalog freshness
// (the storefront's SQL fallback keeps search working).
export async function indexTypesense({ log = noop } = {}) {
  if (!typesenseConfigured()) {
    log("• Typesense not configured — search uses the DB fallback");
    return { indexed: 0, skipped: "not configured" };
  }
  // S53 (audit A3 boundary): no own namespace → never index into a shared one
  if (!productsCollection()) {
    log("• No Typesense namespace for this tenant — search uses the DB fallback");
    return { indexed: 0, skipped: "no tenant namespace" };
  }
  try {
    const client = getAdminClient();
    try {
      await client.collections(productsCollection()).delete();
    } catch {
      /* collection didn't exist yet */
    }
    await client.collections().create(productsCollectionSchema());

    const rows = await db
      .selectFrom("products")
      .select(["handle", "title", "description", "product_type", "vendor", "tags", "price_min", "currency", "available", "featured_image"])
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
    if (!docs.length) return { indexed: 0 };
    const results = await client.collections(productsCollection()).documents().import(docs, { action: "upsert" });
    const failed = results.filter((x) => x && x.success === false);
    log(`  ✓ indexed ${docs.length - failed.length}/${docs.length} into Typesense (${productsCollection()})`);
    return { indexed: docs.length - failed.length, failed: failed.length };
  } catch (e) {
    log(`  ! search index failed (catalog sync unaffected): ${String(e?.message || e).slice(0, 120)}`);
    return { indexed: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

// ---- full sync (S30: generation-tracked, prune-after-complete) ---------------

const genId = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return "sync_" + Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
};

export async function listSyncRuns({ limit = 10 } = {}) {
  const rows = await db
    .selectFrom("sync_runs")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(Math.min(Number(limit) || 10, 50))
    .execute();
  return rows.map((r) => ({ ...r }));
}

// Remove rows the complete run didn't see — UNLESS something (a webhook) wrote
// them after the run started. Children go first so nothing orphans.
async function pruneStale(generation, startedAt) {
  const staleProducts = (
    await db
      .selectFrom("products")
      .select("id")
      .where((eb) =>
        eb.and([
          eb.or([eb("sync_generation", "is", null), eb("sync_generation", "!=", generation)]),
          eb.or([eb("synced_at", "is", null), eb("synced_at", "<", startedAt)]),
        ]),
      )
      .execute()
  ).map((r) => r.id);
  for (const id of staleProducts) {
    await db.deleteFrom("variants").where("product_id", "=", id).execute();
    await db.deleteFrom("product_images").where("product_id", "=", id).execute();
    await db.deleteFrom("collection_products").where("product_id", "=", id).execute();
    await db.deleteFrom("products").where("id", "=", id).execute();
  }
  const staleCollections = (
    await db
      .selectFrom("collections")
      .select("id")
      .where((eb) =>
        eb.and([
          eb.or([eb("sync_generation", "is", null), eb("sync_generation", "!=", generation)]),
          eb.or([eb("synced_at", "is", null), eb("synced_at", "<", startedAt)]),
        ]),
      )
      .execute()
  ).map((r) => r.id);
  for (const id of staleCollections) {
    await db.deleteFrom("collection_products").where("collection_id", "=", id).execute();
    await db.deleteFrom("collections").where("id", "=", id).execute();
  }
  return { products: staleProducts.length, collections: staleCollections.length };
}

export async function runCatalogSync({ searchOnly = false, log = noop, schemaSql = null, fetchers = null } = {}) {
  if (schemaSql) await libsql.executeMultiple(schemaSql);

  let products = 0;
  let collections = 0;
  let pruned = null;
  let runId = null;
  if (!searchOnly) {
    const source = fetchers ? "injected" : catalogSource();
    if (!source) throw new Error("No Shopify credentials for this tenant (admin token or storefront token required)");
    log(`→ catalog source: ${source}`);
    const sfCreds = source === "storefront" ? storefrontCreds() : null;
    const fetchProducts =
      fetchers?.products ||
      (source === "admin" ? fetchAllProductsAdmin : (opts = {}) => fetchProductsStorefront({ ...opts, creds: sfCreds }));
    const fetchCollections =
      fetchers?.collections ||
      (source === "admin" ? fetchAllCollectionsAdmin : (opts = {}) => fetchCollectionsStorefront({ ...opts, creds: sfCreds }));

    // Open the run BEFORE fetching: startedAt is the webhook-race watermark —
    // anything written after it survives the prune.
    runId = genId();
    const startedAt = nowIso();
    await db
      .insertInto("sync_runs")
      .values({ id: runId, kind: "full", status: "running", started_at: startedAt })
      .execute();
    // retention: keep the last ~50 runs
    await libsql
      .execute("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT 50)")
      .catch(() => {});
    const progress = async (n, cursor = null) => {
      log(`  fetched ${n} products…`, true);
      await db
        .updateTable("sync_runs")
        .set({ products_fetched: n, ...(cursor ? { cursor } : {}) })
        .where("id", "=", runId)
        .execute()
        .catch(() => {});
    };

    try {
      log("→ pulling products…");
      const prods = await fetchProducts({ pageSize: 50, onPage: progress });
      log("→ pulling collections…");
      const colls = await fetchCollections({ pageSize: 50, productsFirst: 250, onPage: (n) => log(`  fetched ${n} collections…`, true) });

      const syncedAt = nowIso();
      log("→ writing products…");
      for (const p of prods) await writeProduct(p, syncedAt, runId);
      log(`  ✓ ${prods.length} products written`);
      log("→ writing collections + memberships…");
      const productIds = new Set(prods.map((p) => p.id));
      for (const c of colls) {
        const filtered = { ...c, products: { nodes: (c.products?.nodes || []).filter((n) => productIds.has(n.id)) } };
        await writeCollection(filtered, { onlyExistingProducts: false }, syncedAt, runId);
      }
      log(`  ✓ ${colls.length} collections written`);
      products = prods.length;
      collections = colls.length;

      // COMPLETE generation → now (and only now) prune what it didn't see.
      // This is also the missed-delete repair: a deletion whose webhook never
      // arrived is gone after the next complete run.
      pruned = await pruneStale(runId, startedAt);
      if (pruned.products || pruned.collections) {
        log(`  ✓ pruned ${pruned.products} stale product(s), ${pruned.collections} stale collection(s)`);
      }
      await db
        .updateTable("sync_runs")
        .set({
          status: "complete",
          products,
          collections,
          pruned_products: pruned.products,
          pruned_collections: pruned.collections,
          finished_at: nowIso(),
        })
        .where("id", "=", runId)
        .execute();
    } catch (e) {
      // FAILED partial run: record it and touch NOTHING — good rows stay.
      await db
        .updateTable("sync_runs")
        .set({ status: "failed", error: String(e?.message || e).slice(0, 300), finished_at: nowIso() })
        .where("id", "=", runId)
        .execute()
        .catch(() => {});
      throw e;
    }
  }

  const search = await indexTypesense({ log });
  return { products, collections, ...(pruned ? { pruned } : {}), ...(runId ? { runId } : {}), search };
}

// Convenience for operator flows: run a full sync AS a tenant.
export const syncTenantCatalog = (tenant, opts = {}) => withTenant(tenant, () => runCatalogSync(opts));
