// Upsell / cross-sell placements (Session 23). SERVER-ONLY.
// - pdp_pairs:   per-product "Pairs well with" — manual targets first, else an
//                automatic same-collection fallback so every PDP has a strip.
// - cart_upsell: one global cart-drawer slot — shown ONLY when configured
//                (no auto fallback; an untouched cart stays exactly pre-CMS).
import { db } from "../db.js";

const CARD_COLUMNS = ["id", "handle", "title", "price_min", "compare_at_min", "currency", "available", "featured_image", "featured_image_alt"];
const parse = (s, fallback) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};
const shape = (r) => ({ ...r, available: !!r.available });

export const PLACEMENT_KINDS = ["pdp_pairs", "cart_upsell"];

// ---- CRUD (console) ---------------------------------------------------------

export async function listPlacements() {
  try {
    const rows = await db.selectFrom("placements").selectAll().orderBy("kind").orderBy("position").execute();
    return rows.map((r) => ({ ...r, enabled: !!r.enabled, target_product_ids: parse(r.target_product_ids, []) }));
  } catch {
    return [];
  }
}

export async function upsertPlacement({ id, kind, sourceProductId = null, targetProductIds = [], title = null, enabled = true, position = 0 }) {
  if (!PLACEMENT_KINDS.includes(kind)) throw new Error(`kind must be one of ${PLACEMENT_KINDS.join(", ")}`);
  if (kind === "pdp_pairs" && !sourceProductId) throw new Error("pdp_pairs needs a source product");
  if (!Array.isArray(targetProductIds) || targetProductIds.length === 0) throw new Error("at least one target product required");
  const now = new Date().toISOString();
  const row = {
    id: id || `pl_${kind}_${Date.now().toString(36)}`,
    kind,
    source_product_id: kind === "cart_upsell" ? null : sourceProductId,
    target_product_ids: JSON.stringify(targetProductIds),
    title: title?.trim() || null,
    enabled: enabled ? 1 : 0,
    position: Number(position) || 0,
    updated_at: now,
  };
  await db
    .insertInto("placements")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet(row))
    .execute();
  return row.id;
}

export async function deletePlacement(id) {
  await db.deleteFrom("placements").where("id", "=", id).execute();
}

// Console convenience: merchants type product HANDLES; storage uses gids.
export async function resolveHandles(handles) {
  const clean = handles.map((h) => String(h).trim()).filter(Boolean);
  if (!clean.length) return { ids: [], missing: [] };
  const rows = await db.selectFrom("products").select(["id", "handle"]).where("handle", "in", clean).execute();
  const byHandle = new Map(rows.map((r) => [r.handle, r.id]));
  return {
    ids: clean.map((h) => byHandle.get(h)).filter(Boolean),
    missing: clean.filter((h) => !byHandle.has(h)),
  };
}

// ---- storefront reads --------------------------------------------------------

async function productsByIds(ids, limit) {
  if (!ids.length) return [];
  const rows = await db
    .selectFrom("products")
    .select(CARD_COLUMNS)
    .where("id", "in", ids)
    .where("available", "=", 1)
    .execute();
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .map(shape)
    .sort((a, b) => order.get(a.id) - order.get(b.id))
    .slice(0, limit);
}

// "Pairs well with": manual placement first; else products sharing the most
// collections with this one (deterministic: shared count, then title).
export async function getPdpPairs(productId, { limit = 4 } = {}) {
  try {
    const manual = await db
      .selectFrom("placements")
      .selectAll()
      .where("kind", "=", "pdp_pairs")
      .where("source_product_id", "=", productId)
      .where("enabled", "=", 1)
      .orderBy("position")
      .executeTakeFirst();
    if (manual) {
      const products = await productsByIds(parse(manual.target_product_ids, []), limit);
      if (products.length) return { title: manual.title || "Pairs well with", products, source: "manual" };
    }

    const rows = await db
      .selectFrom("collection_products as mine")
      .innerJoin("collection_products as theirs", "theirs.collection_id", "mine.collection_id")
      .innerJoin("products as p", "p.id", "theirs.product_id")
      .where("mine.product_id", "=", productId)
      .where("theirs.product_id", "!=", productId)
      .where("p.available", "=", 1)
      .select(CARD_COLUMNS.map((c) => `p.${c}`))
      .select((eb) => eb.fn.count("theirs.collection_id").as("shared"))
      .groupBy(CARD_COLUMNS.map((c) => `p.${c}`))
      .orderBy("shared", "desc")
      .orderBy("p.title", "asc")
      .limit(limit)
      .execute();
    return { title: "Pairs well with", products: rows.map(shape), source: "auto" };
  } catch {
    return { title: "Pairs well with", products: [], source: "none" };
  }
}

// Cart-drawer slot: enabled cart_upsell placements by position, targets not
// already in the cart, each with its first available variant for one-tap add.
export async function getCartUpsell(excludeProductIds = [], { limit = 3 } = {}) {
  try {
    const placements = await db
      .selectFrom("placements")
      .selectAll()
      .where("kind", "=", "cart_upsell")
      .where("enabled", "=", 1)
      .orderBy("position")
      .execute();
    if (!placements.length) return { title: null, products: [] };

    const exclude = new Set(excludeProductIds);
    const ids = [];
    for (const pl of placements) {
      for (const id of parse(pl.target_product_ids, [])) {
        if (!exclude.has(id) && !ids.includes(id)) ids.push(id);
      }
    }
    const products = await productsByIds(ids, limit);
    if (!products.length) return { title: null, products: [] };

    const variants = await db
      .selectFrom("variants")
      .select(["id", "product_id", "price", "currency"])
      .where("product_id", "in", products.map((p) => p.id))
      .where("available", "=", 1)
      .orderBy("position")
      .execute();
    const firstVariant = new Map();
    for (const v of variants) if (!firstVariant.has(v.product_id)) firstVariant.set(v.product_id, v);

    return {
      title: placements[0].title || "You might also like",
      products: products
        .filter((p) => firstVariant.has(p.id))
        .map((p) => ({ ...p, variant_id: firstVariant.get(p.id).id, variant_price: firstVariant.get(p.id).price })),
    };
  } catch {
    return { title: null, products: [] };
  }
}
