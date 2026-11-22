// Catalog-hydrated upsell/cross-sell helpers (Documents-only).
// Reads product/variant availability live from the catalog; placements come
// exclusively from published document/entity live rows (never legacy tables).
import { db } from "../db.js";
import { byIds, cardRows } from "./effective.js";

const CARD_KEYS = ["id", "handle", "title", "price_min", "compare_at_min", "currency", "available", "featured_image", "featured_image_alt"];
const card = (r) => Object.fromEntries(CARD_KEYS.map((k) => [k, r[k]]));

const parse = (s, fb = []) => {
  if (Array.isArray(s)) return s;
  try {
    return JSON.parse(s || "[]");
  } catch {
    return fb;
  }
};

async function productsByIds(ids, limit) {
  if (!ids.length) return [];
  return (await byIds(ids, { availableOnly: true })).map(card).slice(0, limit);
}

// "Pairs well with": manual placement first; else products sharing the most
// collections with this one (deterministic: shared count, then effective title).
export async function getPdpPairs(productId, { limit = 4, placementRows = [] } = {}) {
  try {
    const manual = Array.isArray(placementRows)
      ? placementRows.find((p) => p.source_product_id === productId) || null
      : null;
    if (manual) {
      const targets = Array.isArray(manual.target_product_ids) ? manual.target_product_ids : parse(manual.target_product_ids, []);
      const products = await productsByIds(targets, limit);
      if (products.length) return { title: manual.title || "Pairs well with", products, source: "manual" };
    }

    const rows = await cardRows({ sharedWith: productId, availableOnly: true, limit });
    return { title: "Pairs well with", products: rows.map((r) => ({ ...card(r), shared: r.shared })), source: "auto" };
  } catch {
    return { title: "Pairs well with", products: [], source: "none" };
  }
}

// Cart-drawer upsell slot: targets not already in the cart, each with its first
// available variant for one-tap add.
export async function getCartUpsell(excludeProductIds = [], { limit = 3, placementRows = [] } = {}) {
  try {
    const placements = Array.isArray(placementRows) ? placementRows : [];
    if (!placements.length) return { title: null, products: [] };

    const exclude = new Set(excludeProductIds);
    const ids = [];
    for (const pl of placements) {
      const targets = Array.isArray(pl.target_product_ids) ? pl.target_product_ids : parse(pl.target_product_ids, []);
      for (const id of targets) {
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
