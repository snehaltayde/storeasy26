import { sql } from "kysely";
import { db } from "./db.js";

// ---- helpers --------------------------------------------------------------

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shapeProduct(row) {
  if (!row) return null;
  return {
    ...row,
    available: !!row.available,
    tags: parseJson(row.tags, []),
    options: parseJson(row.options, []),
  };
}

const CARD_COLUMNS = [
  "handle",
  "title",
  "product_type",
  "price_min",
  "price_max",
  "compare_at_min",
  "currency",
  "available",
  "featured_image",
  "featured_image_alt",
];

// ---- products -------------------------------------------------------------

export async function getNewestProducts(limit = 12) {
  const rows = await db
    .selectFrom("products")
    .select(CARD_COLUMNS)
    .orderBy("available", "desc")
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(shapeProduct);
}

export async function getProductByHandle(handle) {
  const product = await db
    .selectFrom("products")
    .selectAll()
    .where("handle", "=", handle)
    .executeTakeFirst();
  if (!product) return null;

  const [images, variants] = await Promise.all([
    db
      .selectFrom("product_images")
      .selectAll()
      .where("product_id", "=", product.id)
      .orderBy("position", "asc")
      .execute(),
    db
      .selectFrom("variants")
      .selectAll()
      .where("product_id", "=", product.id)
      .orderBy("position", "asc")
      .execute(),
  ]);

  return {
    ...shapeProduct(product),
    // Spread each row into a plain object — libSQL/Kysely rows aren't plain, and
    // these get passed across the server→client boundary (ProductGallery).
    images: images.map((img) => ({ ...img })),
    variants: variants.map((v) => ({
      ...v,
      available: !!v.available,
      selectedOptions: parseJson(v.selected_options, []),
    })),
  };
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
export const COLLECTION_SORTS = ["featured", "new", "price-asc", "price-desc"];

// S53 (0B-2): `pins` injects the release-frozen pin order (the collection
// page resolves it); undefined keeps the draft-table read.
// P2-PERF: `withTotal: false` skips the count (`total` is then null). The home
// rails show only the products, so they don't pay one more statement each.
export async function getProductsInCollection(handle, { limit = 24, offset = 0, sort = "featured", inStock = false, type = "", pins, withTotal = true } = {}) {
  const base = () =>
    db
      .selectFrom("products as p")
      .innerJoin("collection_products as cp", "cp.product_id", "p.id")
      .innerJoin("collections as c", "c.id", "cp.collection_id")
      .where("c.handle", "=", handle)
      .$if(inStock, (q) => q.where("p.available", "=", 1))
      .$if(Boolean(type), (q) => q.where("p.product_type", "=", type));

  let q = base().select(CARD_COLUMNS.map((col) => `p.${col}`));
  if (sort === "new") q = q.orderBy("p.created_at", "desc");
  else if (sort === "price-asc") q = q.orderBy("p.price_min", "asc");
  else if (sort === "price-desc") q = q.orderBy("p.price_min", "desc");
  else {
    // "featured" = merchant pins first (S39 / MC06), then Shopify's position.
    const pinned = Array.isArray(pins) ? pins.slice(0, 24) : await collectionPinsByHandle(handle);
    if (pinned.length) {
      const cases = pinned.map((id, i) => sql`WHEN p.id = ${id} THEN ${i}`);
      q = q.orderBy(sql`CASE ${sql.join(cases, sql` `)} ELSE 9999 END`, "asc");
    }
    q = q.orderBy("cp.position", "asc");
  }
  const rows = await q.orderBy("p.handle", "asc").limit(limit).offset(offset).execute();

  if (!withTotal) return { products: rows.map(shapeProduct), total: null };
  const total = await base()
    .select((eb) => eb.fn.count("cp.product_id").as("n"))
    .executeTakeFirst();

  return { products: rows.map(shapeProduct), total: Number(total?.n ?? 0) };
}

// S39 (MC06): merchant pins for a collection's "featured" order, by handle.
// Exported since S53 — the resolver uses it as the draft-mode read.
export async function collectionPinsByHandle(handle) {
  try {
    const row = await db
      .selectFrom("collection_overrides as co")
      .innerJoin("collections as c", "c.id", "co.collection_id")
      .select("co.pinned")
      .where("c.handle", "=", handle)
      .executeTakeFirst();
    const pinned = row ? JSON.parse(row.pinned || "[]") : [];
    return Array.isArray(pinned) ? pinned.slice(0, 24) : [];
  } catch {
    return []; // pre-migration tenant
  }
}

// P2-PERF: the pins of several collections in one statement, for the home
// rails (one read per rail before). handle → pins, as collectionPinsByHandle
// gives them: at most 24, and [] for a collection with none, with pins that
// aren't a JSON list, or on a pre-migration tenant.
export async function collectionPinsByHandles(handles) {
  const out = new Map();
  const list = [...new Set((handles || []).filter(Boolean))];
  for (const h of list) out.set(h, []);
  if (!list.length) return out;
  let rows;
  try {
    rows = await db
      .selectFrom("collection_overrides as co")
      .innerJoin("collections as c", "c.id", "co.collection_id")
      .select(["c.handle", "co.pinned"])
      .where("c.handle", "in", list)
      .execute();
  } catch {
    return out; // pre-migration tenant
  }
  for (const row of rows) {
    if (out.get(row.handle)?.length) continue; // the first row per handle, as executeTakeFirst
    let pinned = [];
    try {
      pinned = JSON.parse(row.pinned || "[]");
    } catch {
      pinned = [];
    }
    out.set(row.handle, Array.isArray(pinned) ? pinned.slice(0, 24) : []);
  }
  return out;
}

// Facets for the collection filter bar: product types with counts (unfiltered,
// so a selected type still shows its siblings).
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
// optional env-configured upgrade (the free cluster died; reviving it is a
// paid, user-gated call). Upgraded here to earn that role: multi-term AND
// matching (every word must hit somewhere) with deterministic ranking —
// in-stock first, then title-prefix matches, then title matches, then the rest.
export async function searchProductsInDb(q, limit = 8) {
  const terms = String(q)
    .replace(/[%_]/g, "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!terms.length) return { source: "database", found: 0, hits: [] };
  const first = `${terms[0].toLowerCase()}%`;
  const whole = `%${terms.join(" ").toLowerCase()}%`;

  let query = db
    .selectFrom("products")
    .select([
      "handle",
      "title",
      "featured_image as image",
      "price_min as price",
      "currency",
      "product_type",
      "available",
    ]);
  for (const t of terms) {
    const term = `%${t}%`;
    query = query.where((eb) =>
      eb.or([
        eb("title", "like", term),
        eb("product_type", "like", term),
        eb("vendor", "like", term),
        eb("tags", "like", term),
      ]),
    );
  }
  const rows = await query
    .orderBy("available", "desc")
    .orderBy(sql`CASE WHEN lower(title) LIKE ${first} THEN 0 WHEN lower(title) LIKE ${whole} THEN 1 ELSE 2 END`, "asc")
    .orderBy("title", "asc")
    .limit(limit)
    .execute();

  return {
    source: "database",
    found: rows.length,
    hits: rows.map((r) => ({
      handle: r.handle,
      title: r.title,
      image: r.image,
      price: r.price,
      currency: r.currency || "INR",
      product_type: r.product_type,
      available: !!r.available,
    })),
  };
}

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
