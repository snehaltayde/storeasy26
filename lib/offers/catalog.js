// The store's own catalog, read for the offer console (COM-03): the store's
// currency, the current names of the products offers point at, the products
// the simulator builds its example carts from, and the tags and product
// types a founder can pick. Read-only; tenant scope comes from the active
// tenant context like every other db read.
//
// P4-SEARCH (OVL-05, OVL-06): the names here are the PUBLISHED names shoppers
// see (product_content_live over Shopify's, never a draft), so an offer, its
// example carts and its picker read the name the founder gave a product.
// Logic (product type, tags, which variants an offer covers) stays on
// Shopify's raw values. A store with no live rows reads exactly as before.
import { sql } from "kysely";
import { db } from "../db.js";
import { tenantOwnCfg } from "../tenant-context.js";
import { liveTableReady } from "../catalog/effective.js";

const titleOf = (live) => sql.raw(live ? "COALESCE(c.title, p.title)" : "p.title");
const withLive = (live) => (q) => (live ? q.leftJoin("product_content_live as c", "c.product_id", "p.id") : q);

const parseTags = (s) => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

// The currency the store's prices are in: the catalog's own (what the cart
// charges in), then the store's setting, then INR.
export async function storeCurrency() {
  try {
    const row = await db
      .selectFrom("products")
      .select(["currency", ({ fn }) => fn.countAll().as("n")])
      .where("currency", "is not", null)
      .where("currency", "!=", "")
      .groupBy("currency")
      .orderBy("n", "desc")
      .orderBy("currency", "asc")
      .executeTakeFirst();
    if (row?.currency) return String(row.currency).toUpperCase();
  } catch {
    // no catalog table yet: fall through to the setting
  }
  const cfg = tenantOwnCfg("currency");
  return cfg ? String(cfg).toUpperCase() : "INR";
}

const variantName = (productTitle, variantTitle) =>
  variantTitle && !/^default( title)?$/i.test(variantTitle) ? `${productTitle} — ${variantTitle}` : productTitle;

// Current catalog names for the product, variant and handle values that the
// given offers point at: { [value]: name }. Values the catalog lost are left
// out, so the offer's saved label (or a neutral phrase) shows instead.
export async function offerTargetNames(offers) {
  const want = { productId: new Set(), handle: new Set(), variantId: new Set() };
  for (const o of offers || []) {
    const t = o?.target || o?.config?.target;
    if (t && want[t.kind] && t.value) want[t.kind].add(String(t.value));
  }
  const names = {};
  const any = want.productId.size || want.handle.size || want.variantId.size;
  const live = any ? await liveTableReady() : false;
  if (want.productId.size) {
    const rows = await db.selectFrom("products as p").$call(withLive(live)).select(["p.id"]).select(titleOf(live).as("title")).where("p.id", "in", [...want.productId]).execute();
    for (const r of rows) names[r.id] = r.title;
  }
  if (want.handle.size) {
    const rows = await db.selectFrom("products as p").$call(withLive(live)).select(["p.handle"]).select(titleOf(live).as("title")).where("p.handle", "in", [...want.handle]).execute();
    for (const r of rows) names[r.handle] = r.title;
  }
  if (want.variantId.size) {
    const rows = await db
      .selectFrom("variants as v")
      .innerJoin("products as p", "p.id", "v.product_id")
      .$call(withLive(live))
      .select(["v.id", "v.title as variantTitle"])
      .select(titleOf(live).as("productTitle"))
      .where("v.id", "in", [...want.variantId])
      .execute();
    for (const r of rows) names[r.id] = variantName(r.productTitle, r.variantTitle);
  }
  return names;
}

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// Catalog lines (engine shape, no quantity) for an offer's example carts:
// the products a Buy some / Buy more offer covers, or the store's cheapest
// products for a gift or a code. Available first, then a stable order, so the
// same catalog always gives the same example.
export async function exampleCatalog(offer, { limit = 500 } = {}) {
  let live = false;
  try {
    live = await liveTableReady();
  } catch {
    return [];
  }
  const title = titleOf(live);
  let q = db
    .selectFrom("variants as v")
    .innerJoin("products as p", "p.id", "v.product_id")
    .$call(withLive(live))
    .select([
      "v.id as variantId",
      "v.product_id as productId",
      "p.handle as handle",
    ])
    .select(title.as("title"))
    .select([
      "v.title as variantTitle",
      "p.product_type as productType",
      "p.tags as tags",
      "v.price as price",
      "v.available as available",
      // the cart's lines carry their currency, and the engine words money with it
      sql`coalesce(nullif(v.currency, ''), p.currency)`.as("currency"),
    ])
    .where("v.price", ">", 0);
  const target = offer?.target;
  const targeted = offer?.type === "BXGY" || offer?.type === "TIERED_QTY";
  if (targeted) {
    const v = String(target?.value ?? "");
    switch (target?.kind) {
      case "productId":
        q = q.where("p.id", "=", v);
        break;
      case "handle":
        q = q.where("p.handle", "=", v);
        break;
      case "variantId":
        q = q.where("v.id", "=", v);
        break;
      case "productType":
        q = q.where("p.product_type", "=", v);
        break;
      case "tag":
        // narrowed in SQL, matched exactly by the engine's own rule after
        q = q.where(sql`p.tags LIKE ${`%${likeEscape(JSON.stringify(v))}%`} ESCAPE '\\'`);
        break;
      default:
        return [];
    }
    q = q.orderBy("v.available", "desc").orderBy(title, "asc").orderBy("v.position", "asc").orderBy("v.id", "asc");
  } else {
    q = q.where("v.available", "=", 1).orderBy("v.price", "asc").orderBy(title, "asc").orderBy("v.id", "asc");
  }
  let rows;
  try {
    // up to 500 rows: everything a targeted offer covers, so the dearest is
    // known; for a gift or a code, cheapest first, so a high spend can still
    // be reached with few items
    rows = await q.limit(limit).execute();
  } catch {
    return [];
  }
  return rows
    .map((r) => ({ ...r, price: Number(r.price), tags: parseTags(r.tags), productType: r.productType || null, available: !!r.available, currency: r.currency || undefined }))
    .filter((r) => (target?.kind === "tag" && targeted ? r.tags.includes(String(target.value)) : true));
}

// The dearest price among the products an offer covers: what one free item
// can be worth at most (the form's free-item warning).
export const maxPrice = (catalog) => (catalog || []).reduce((m, i) => Math.max(m, Number(i.price) || 0), 0);

// Tags and product types in the store, with how many products carry each and
// the dearest of them, for the "All products with a tag / of one type" pickers.
export async function offerTargetOptions({ max = 300 } = {}) {
  const rows = await db.selectFrom("products").select(["tags", "product_type", "price_max", "price_min"]).execute();
  const tags = new Map();
  const types = new Map();
  const bump = (map, value, price) => {
    const cur = map.get(value) || { value, count: 0, maxPrice: 0 };
    cur.count++;
    cur.maxPrice = Math.max(cur.maxPrice, Number(price) || 0);
    map.set(value, cur);
  };
  for (const r of rows) {
    const price = r.price_max ?? r.price_min;
    for (const tag of new Set(parseTags(r.tags))) if (tag.trim()) bump(tags, tag, price);
    if (r.product_type && String(r.product_type).trim()) bump(types, String(r.product_type), price);
  }
  const order = (a, b) => b.count - a.count || a.value.localeCompare(b.value);
  return { tags: [...tags.values()].sort(order).slice(0, max), types: [...types.values()].sort(order).slice(0, max) };
}
