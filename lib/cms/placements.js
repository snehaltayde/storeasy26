// Upsell / cross-sell placements (Session 23). SERVER-ONLY.
// - pdp_pairs:   per-product "Pairs well with" — manual targets first, else an
//                automatic same-collection fallback so every PDP has a strip.
// - cart_upsell: one global cart-drawer slot — shown ONLY when configured
//                (no auto fallback; an untouched cart stays exactly pre-CMS).
import { db } from "../db.js";
import { runLegacyBatch } from "../cms-mode.js";
import { byIds, cardRows } from "../catalog/effective.js";

// P4-GUARD (MIG-03): every write here is a compiled Kysely query sent through
// runLegacyBatch (one batch, the legacy guard first), never executed directly.

// P4-EFFECTIVE (OVL-03): the cards the strips show, from the effective read.
// The same keys as before (no type label on these strips).
const CARD_KEYS = ["id", "handle", "title", "price_min", "compare_at_min", "currency", "available", "featured_image", "featured_image_alt"];
const card = (r) => Object.fromEntries(CARD_KEYS.map((k) => [k, r[k]]));
const parse = (s, fallback) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

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
  await runLegacyBatch([
    db
      .insertInto("placements")
      .values(row)
      .onConflict((oc) => oc.column("id").doUpdateSet(row)),
  ]);
  return row.id;
}

export async function deletePlacement(id) {
  await runLegacyBatch([db.deleteFrom("placements").where("id", "=", id)]);
}

// Console convenience: merchants type product HANDLES; storage uses gids.
// Reads id and handle only (on the P4-EFFECTIVE guard's allowlist).
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
  return (await byIds(ids, { availableOnly: true })).map(card).slice(0, limit);
}

// "Pairs well with": manual placement first; else products sharing the most
// collections with this one (deterministic: shared count, then title).
// S53 (0B-2): `placementRows` injects the rows a RELEASE froze (normalized
// {source_product_id, target_product_ids:[], title, enabled} objects) — the
// resolver passes them in live mode; undefined reads the draft table. The
// automatic shared-collections fallback stays a live catalog computation.
export async function getPdpPairs(productId, { limit = 4, placementRows } = {}) {
  try {
    const manual = Array.isArray(placementRows)
      ? placementRows.find((p) => p.source_product_id === productId) || null
      : await db
          .selectFrom("placements")
          .selectAll()
          .where("kind", "=", "pdp_pairs")
          .where("source_product_id", "=", productId)
          .where("enabled", "=", 1)
          .orderBy("position")
          .executeTakeFirst();
    if (manual) {
      const targets = Array.isArray(manual.target_product_ids) ? manual.target_product_ids : parse(manual.target_product_ids, []);
      const products = await productsByIds(targets, limit);
      if (products.length) return { title: manual.title || "Pairs well with", products, source: "manual" };
    }

    // automatic: most shared collections first, then the EFFECTIVE title
    const rows = await cardRows({ sharedWith: productId, availableOnly: true, limit });
    return { title: "Pairs well with", products: rows.map((r) => ({ ...card(r), shared: r.shared })), source: "auto" };
  } catch {
    return { title: "Pairs well with", products: [], source: "none" };
  }
}

// Cart-drawer slot: enabled cart_upsell placements by position, targets not
// already in the cart, each with its first available variant for one-tap add.
export async function getCartUpsell(excludeProductIds = [], { limit = 3, placementRows } = {}) {
  try {
    const placements = Array.isArray(placementRows)
      ? placementRows
      : await db
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
