// Shopify ID normalisation — one canonical form everywhere.
//
// The whole app stores FULL GIDs (gid://shopify/ProductVariant/123), matching
// the synced catalog tables (products.id, variants.id). We convert to the bare
// numeric id ONLY at the Shopify API boundary (cart permalinks, draftOrderCreate).
// Keeping a single canonical form is what stops cart↔catalog join mismatches.

export function isGid(value) {
  return typeof value === "string" && value.startsWith("gid://shopify/");
}

// gid://shopify/ProductVariant/45042167054553 -> "45042167054553"
// Already-numeric input is returned unchanged.
export function numericId(gid) {
  if (gid == null) return null;
  const m = String(gid).match(/(\d+)\s*$/);
  return m ? m[1] : String(gid);
}

// Build a GID from a type + (numeric or gid) id. No-op if already a GID.
export function toGid(type, id) {
  if (id == null) return null;
  return isGid(id) ? id : `gid://shopify/${type}/${id}`;
}

export const toVariantGid = (id) => toGid("ProductVariant", id);
export const toProductGid = (id) => toGid("Product", id);
