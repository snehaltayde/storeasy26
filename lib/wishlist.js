// Wishlist (Session 49 / SF22). SERVER-ONLY, tenant-scoped.
//
// LOCAL-FIRST by design: the anonymous wishlist lives in the browser
// (per-store origin), and this module only (1) resolves handles against
// TODAY's catalog so the page can label unavailable/gone items honestly,
// and (2) stores what a signed-in customer EXPLICITLY merged — there is no
// implicit identity joining and no cross-device tracking without the merge.
// Per-store isolation is structural: accounts and wishlists live in the
// tenant's own database.
import { db } from "./db.js";
import { cardRows } from "./catalog/effective.js";

const nowIso = () => new Date().toISOString();

export const cleanWishlistItems = (items) =>
  (Array.isArray(items) ? items : [])
    .slice(0, 100)
    .map((i) => ({ handle: String(i?.handle || "").trim().toLowerCase().slice(0, 120), variant_id: i?.variantId ? String(i.variantId).slice(0, 120) : null }))
    .filter((i) => /^[a-z0-9][a-z0-9-]*$/.test(i.handle));

// Current-catalog resolution: ok | unavailable | gone — never hidden.
export async function resolveWishlist(items) {
  const clean = cleanWishlistItems(items);
  if (!clean.length) return [];
  const handles = [...new Set(clean.map((i) => i.handle))];
  // P4-EFFECTIVE (OVL-03): the effective title and image (lib/catalog/effective.js)
  const rows = await cardRows({ handles });
  const byHandle = new Map(rows.map((r) => [r.handle, r]));
  return handles.map((h) => {
    const p = byHandle.get(h);
    if (!p) return { handle: h, state: "gone", title: null };
    return {
      handle: h,
      state: p.available ? "ok" : "unavailable",
      title: p.title,
      image: p.featured_image,
      price: p.price_min,
      currency: p.currency || "INR",
    };
  });
}

// The EXPLICIT merge: dedupes by product identity (handle) per store.
export async function mergeWishlist(customerId, items) {
  const clean = cleanWishlistItems(items);
  let added = 0;
  for (const i of clean) {
    const res = await db
      .insertInto("customer_wishlists")
      .values({ customer_id: customerId, handle: i.handle, variant_id: i.variant_id, created_at: nowIso() })
      .onConflict((oc) => oc.columns(["customer_id", "handle"]).doNothing())
      .execute();
    added += Number(res[0]?.numInsertedOrUpdatedRows ?? 0) ? 1 : 0;
  }
  return { merged: clean.length, added, deduped: clean.length - added };
}

export async function accountWishlist(customerId) {
  try {
    const rows = await db.selectFrom("customer_wishlists").selectAll().where("customer_id", "=", customerId).orderBy("created_at", "desc").execute();
    const resolved = await resolveWishlist(rows.map((r) => ({ handle: r.handle, variantId: r.variant_id })));
    return resolved;
  } catch {
    return []; // pre-migration tenant
  }
}

export async function removeWishlistItem(customerId, handle) {
  await db.deleteFrom("customer_wishlists").where("customer_id", "=", customerId).where("handle", "=", String(handle || "").toLowerCase()).execute();
  return { removed: true };
}

export async function clearWishlist(customerId) {
  await db.deleteFrom("customer_wishlists").where("customer_id", "=", customerId).execute();
  return { cleared: true };
}
