import { sql } from "kysely";
import { db } from "./db.js";
import { cardRows, collectionCount, productPage, search as effectiveSearch, displayHits, COLLECTION_SORTS as SORTS } from "./catalog/effective.js";

// ---- helpers --------------------------------------------------------------

// P4-EFFECTIVE (OVL-03): every product read a shopper sees goes through
// lib/catalog/effective.js, which picks the founder's published values over
// Shopify's. Cards carry display_type (no product_type); the product page also
// carries display_vendor, the description pair, seo_*, og_image and the raw
// logic_tags / logic_type.
const CARD_KEYS = ["handle", "title", "display_type", "price_min", "price_max", "compare_at_min", "currency", "available", "featured_image", "featured_image_alt"];
const card = (r) => Object.fromEntries(CARD_KEYS.map((k) => [k, r[k]]));

// ---- products -------------------------------------------------------------

export async function getNewestProducts(limit = 12) {
  return (await cardRows({ order: "newest", limit })).map(card);
}

export async function getProductByHandle(handle) {
  return productPage(handle);
}

export async function getProductHandles(limit = 1000) {
  const rows = await db
    .selectFrom("products")
    .select("handle")
    .limit(limit)
    .execute();
  return rows.map((r) => r.handle);
}

// ---- collections ----------------------------------------------------------

// The home collections grid (lib/cms/section-data.js). P2-PERF: no description,
// which CollectionCard never shows (handle, title, image, image_alt, count).
export async function getFeaturedCollections(limit = 6) {
  const rows = await db
    .selectFrom("collections as c")
    .innerJoin("collection_products as cp", "cp.collection_id", "c.id")
    .select(["c.handle", "c.title", "c.image", "c.image_alt"])
    .select((eb) => eb.fn.count("cp.product_id").as("product_count"))
    .groupBy(["c.handle", "c.title", "c.image", "c.image_alt"])
    .orderBy("product_count", "desc")
    .orderBy("c.title", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, product_count: Number(r.product_count) }));
}

export async function getAllCollections() {
  const rows = await db
    .selectFrom("collections as c")
    .leftJoin("collection_products as cp", "cp.collection_id", "c.id")
    .select(["c.handle", "c.title", "c.image", "c.image_alt"])
    .select((eb) => eb.fn.count("cp.product_id").as("product_count"))
    .groupBy(["c.handle", "c.title", "c.image", "c.image_alt"])
    .having((eb) => eb.fn.count("cp.product_id"), ">", 0)
    .orderBy("c.title", "asc")
    .execute();
  return rows.map((r) => ({ ...r, product_count: Number(r.product_count) }));
}

// S38 (SF02): fetch specific collections preserving the given handle order.
export async function getCollectionsByHandles(handles) {
  if (!Array.isArray(handles) || !handles.length) return [];
  const rows = await db
    .selectFrom("collections as c")
    .leftJoin("collection_products as cp", "cp.collection_id", "c.id")
    .select(["c.handle", "c.title", "c.description", "c.image", "c.image_alt"])
    .select((eb) => eb.fn.count("cp.product_id").as("product_count"))
    .where("c.handle", "in", handles)
    .groupBy(["c.handle", "c.title", "c.description", "c.image", "c.image_alt"])
    .execute();
  const byHandle = new Map(rows.map((r) => [r.handle, { ...r, product_count: Number(r.product_count) }]));
  return handles.map((h) => byHandle.get(h)).filter(Boolean);
}

// S57 (ref migration): current handles for stored collection IDS — the
// healing lookup that makes handle references rename-proof.
export async function getCollectionHandlesByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  return db.selectFrom("collections").select(["id", "handle"]).where("id", "in", ids).execute();
}

export async function getCollectionByHandle(handle) {
  return db
    .selectFrom("collections")
    .selectAll()
    .where("handle", "=", handle)
    .executeTakeFirst();
}

// S38 (SF03): URL-backed sort + filters. sort: featured (merchant position,
// the default) | new | price-asc | price-desc; filters: inStock, product type.
export const COLLECTION_SORTS = SORTS;

// S53 (0B-2): `pins` injects the published pin order (the collection page
// and the home rails resolve it); undefined means no pins.
// P2-PERF: `withTotal: false` skips the count (`total` is then null). The home
// rails show only the products, so they don't pay one more statement each.
// P4-EFFECTIVE: the cards come from the effective read; `type` filters on
// Shopify's raw product type (the filter stays on raw values by design).
export async function getProductsInCollection(handle, { limit = 24, offset = 0, sort = "featured", inStock = false, type = "", pins, withTotal = true } = {}) {
  const pinned = sort === "featured" || !COLLECTION_SORTS.includes(sort) ? (Array.isArray(pins) ? pins.slice(0, 24) : []) : [];
  const rows = await cardRows({ collection: { handle, sort, inStock, type, pins: pinned }, limit, offset });
  const products = rows.map(card);
  if (!withTotal) return { products, total: null };
  return { products, total: await collectionCount({ handle, inStock, type }) };
}

// Facets for the collection filter bar: product types with counts (unfiltered,
// so a selected type still shows its siblings). P4-EFFECTIVE: Shopify's RAW
// product type by design (filters are logic, OVL-01); a founder's display type
// never changes which filter a product falls under. On the guard's allowlist
// in scripts/test-effective-read.js.
export async function getCollectionTypeFacets(handle) {
  const rows = await db
    .selectFrom("products as p")
    .innerJoin("collection_products as cp", "cp.product_id", "p.id")
    .innerJoin("collections as c", "c.id", "cp.collection_id")
    .where("c.handle", "=", handle)
    .where("p.product_type", "is not", null)
    .where("p.product_type", "!=", "")
    .select(["p.product_type"])
    .select((eb) => eb.fn.count("p.id").as("n"))
    .groupBy("p.product_type")
    .orderBy("n", "desc")
    .orderBy("p.product_type", "asc")
    .execute();
  return rows.map((r) => ({ type: r.product_type, count: Number(r.n) }));
}

// ---- search fallback (used when Typesense is not configured) ---------------

// S38 (BE05 decision): SQL IS the supported search engine — Typesense stays an
// optional env-configured upgrade. Multi-term AND matching with deterministic
// ranking. P4-EFFECTIVE (OVL-05): it matches and sorts on the EFFECTIVE title,
// display type and vendor (lib/catalog/effective.js search); hits carry
// display_type.
export async function searchProductsInDb(q, limit = 8) {
  return effectiveSearch(q, limit);
}

// Typesense hits shaped the same way (display_type), for the search route and page.
export { displayHits };

// ---- counts (home / health) -----------------------------------------------

// P2-PERF: both counts in one statement (it was two, one round trip each).
export async function getCatalogStats() {
  try {
    const { rows } = await sql`select (select count("id") from "products") as "products", (select count("id") from "collections") as "collections"`.execute(db);
    const r = rows[0];
    return { products: Number(r?.products ?? 0), collections: Number(r?.collections ?? 0) };
  } catch {
    return { products: 0, collections: 0 };
  }
}
