// Catalog presentation overrides (Session 39 / MC05 + MC06). SERVER-ONLY.
//
// Shopify stays authoritative for every catalog VALUE (title, price, stock,
// description — the console labels them and links to Shopify admin). These
// rows are additive per-tenant PRESENTATION: per-product PDP modules
// (ingredients / usage / specs accordions, the SF04 half that needed real
// per-product data) + a short badge, and per-collection pinned ordering.
// Live-on-save like placements (catalog-adjacent, not release content).
import { db } from "./db.js";
import { sanitizeHtml } from "./sanitize.js";

const parse = (s, fallback) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---- per-product modules (MC05 / SF04) --------------------------------------

export function validateModules(input) {
  const errors = [];
  if (input == null) return { ok: true, errors, value: [] };
  if (!Array.isArray(input)) return { ok: false, errors: ["modules must be a list"], value: [] };
  if (input.length > 6) errors.push("At most 6 modules per product");
  const value = [];
  for (const [i, m] of input.slice(0, 6).entries()) {
    const title = String(m?.title ?? "").trim().slice(0, 80);
    const html = sanitizeHtml(String(m?.html ?? "")).slice(0, 10000); // sanitized AT SAVE
    if (!title) errors.push(`Module ${i + 1}: needs a title`);
    if (!html.trim()) errors.push(`Module ${i + 1}: content is empty`);
    value.push({ title, html });
  }
  return { ok: !errors.length, errors, value };
}

export async function getProductOverride(productId) {
  try {
    const row = await db.selectFrom("product_overrides").selectAll().where("product_id", "=", productId).executeTakeFirst();
    if (!row) return null;
    return { product_id: row.product_id, modules: parse(row.modules, []), badge: row.badge || "", updated_at: row.updated_at };
  } catch {
    return null; // pre-migration tenant
  }
}

export async function setProductOverride(productId, { modules = [], badge = "" }) {
  const product = await db.selectFrom("products").select(["id"]).where("id", "=", productId).executeTakeFirst();
  if (!product) throw new Error("product not in the catalog (deleted or never synced)");
  const v = validateModules(modules);
  if (!v.ok) {
    const err = new Error(v.errors.join(" · "));
    err.errors = v.errors;
    throw err;
  }
  const cleanBadge = String(badge || "").trim().slice(0, 30);
  if (!v.value.length && !cleanBadge) {
    await db.deleteFrom("product_overrides").where("product_id", "=", productId).execute();
    return { product_id: productId, modules: [], badge: "", removed: true };
  }
  const row = { product_id: productId, modules: JSON.stringify(v.value), badge: cleanBadge || null, updated_at: new Date().toISOString() };
  await db
    .insertInto("product_overrides")
    .values(row)
    .onConflict((oc) => oc.column("product_id").doUpdateSet(row))
    .execute();
  return { product_id: productId, modules: v.value, badge: cleanBadge };
}

// Console listing with the DELETED-PRODUCT GUARD: overrides whose product
// vanished from the catalog (full-sync prune) are flagged, never silently
// rendered or silently dropped.
export async function listProductOverrides() {
  try {
    const rows = await db.selectFrom("product_overrides").selectAll().execute();
    if (!rows.length) return [];
    const prods = await db.selectFrom("products").select(["id", "handle", "title"]).where("id", "in", rows.map((r) => r.product_id)).execute();
    const byId = new Map(prods.map((p) => [p.id, p]));
    return rows.map((r) => ({
      product_id: r.product_id,
      modules: parse(r.modules, []),
      badge: r.badge || "",
      handle: byId.get(r.product_id)?.handle || null,
      title: byId.get(r.product_id)?.title || null,
      orphaned: !byId.has(r.product_id), // product deleted from the catalog
      updated_at: r.updated_at,
    }));
  } catch {
    return [];
  }
}

// ---- per-collection pinned order (MC06) -------------------------------------

export async function getCollectionPins(collectionId) {
  try {
    const row = await db.selectFrom("collection_overrides").selectAll().where("collection_id", "=", collectionId).executeTakeFirst();
    return row ? parse(row.pinned, []) : [];
  } catch {
    return [];
  }
}

// Pin products to the head of a collection's "featured" order. Every pinned
// id must be a member of that collection (ownership validation — a pin can't
// smuggle a foreign product into the curated view).
export async function setCollectionPins(collectionId, productIds) {
  const col = await db.selectFrom("collections").select(["id"]).where("id", "=", collectionId).executeTakeFirst();
  if (!col) throw new Error("collection not in the catalog");
  const ids = [...new Set((productIds || []).map(String))].slice(0, 24);
  if (ids.length) {
    const members = await db
      .selectFrom("collection_products")
      .select("product_id")
      .where("collection_id", "=", collectionId)
      .where("product_id", "in", ids)
      .execute();
    const memberSet = new Set(members.map((m) => m.product_id));
    const outsiders = ids.filter((id) => !memberSet.has(id));
    if (outsiders.length) throw new Error(`${outsiders.length} pinned product(s) aren't in this collection`);
  }
  if (!ids.length) {
    await db.deleteFrom("collection_overrides").where("collection_id", "=", collectionId).execute();
    return { collection_id: collectionId, pinned: [], removed: true };
  }
  const row = { collection_id: collectionId, pinned: JSON.stringify(ids), updated_at: new Date().toISOString() };
  await db
    .insertInto("collection_overrides")
    .values(row)
    .onConflict((oc) => oc.column("collection_id").doUpdateSet(row))
    .execute();
  return { collection_id: collectionId, pinned: ids };
}
