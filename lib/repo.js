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

export async function getFeaturedCollections(limit = 6) {
  const rows = await db
    .selectFrom("collections as c")
    .innerJoin("collection_products as cp", "cp.collection_id", "c.id")
    .select(["c.handle", "c.title", "c.description", "c.image", "c.image_alt"])
    .select((eb) => eb.fn.count("cp.product_id").as("product_count"))
    .groupBy(["c.handle", "c.title", "c.description", "c.image", "c.image_alt"])
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

export async function getCollectionByHandle(handle) {
  return db
    .selectFrom("collections")
    .selectAll()
    .where("handle", "=", handle)
    .executeTakeFirst();
}

export async function getProductsInCollection(handle, { limit = 24, offset = 0 } = {}) {
  const rows = await db
    .selectFrom("products as p")
    .innerJoin("collection_products as cp", "cp.product_id", "p.id")
    .innerJoin("collections as c", "c.id", "cp.collection_id")
    .where("c.handle", "=", handle)
    .select(CARD_COLUMNS.map((col) => `p.${col}`))
    .orderBy("cp.position", "asc")
    .limit(limit)
    .offset(offset)
    .execute();

  const total = await db
    .selectFrom("collection_products as cp")
    .innerJoin("collections as c", "c.id", "cp.collection_id")
    .where("c.handle", "=", handle)
    .select((eb) => eb.fn.count("cp.product_id").as("n"))
    .executeTakeFirst();

  return { products: rows.map(shapeProduct), total: Number(total?.n ?? 0) };
}

// ---- search fallback (used when Typesense is not configured) ---------------

export async function searchProductsInDb(q, limit = 8) {
  const term = `%${String(q).replace(/[%_]/g, "")}%`;
  const rows = await db
    .selectFrom("products")
    .select([
      "handle",
      "title",
      "featured_image as image",
      "price_min as price",
      "currency",
      "product_type",
      "available",
    ])
    .where((eb) =>
      eb.or([
        eb("title", "like", term),
        eb("product_type", "like", term),
        eb("vendor", "like", term),
        eb("tags", "like", term),
      ]),
    )
    .orderBy("available", "desc")
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

export async function getCatalogStats() {
  try {
    const [p, c] = await Promise.all([
      db.selectFrom("products").select((eb) => eb.fn.count("id").as("n")).executeTakeFirst(),
      db.selectFrom("collections").select((eb) => eb.fn.count("id").as("n")).executeTakeFirst(),
    ]);
    return { products: Number(p?.n ?? 0), collections: Number(c?.n ?? 0) };
  } catch {
    return { products: 0, collections: 0 };
  }
}
