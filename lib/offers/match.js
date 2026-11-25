// Does a cart line match an offer's target? Pure. The engine's own rule, in a
// file of its own (COM-03) so the console can use it in the browser without
// pulling in lib/offers/config.js (one store's own offers). engine.js
// re-exports it, so every existing import keeps working.
export function matchesTarget(item, target) {
  if (!target) return false;
  switch (target.kind) {
    case "handle":
      return item.handle === target.value;
    case "productId":
      return item.productId === target.value;
    case "variantId":
      return item.variantId === target.value;
    case "tag":
      return Array.isArray(item.tags) && item.tags.includes(target.value);
    case "productType":
      return item.productType === target.value;
    case "collection":
      // the line's collection handles, from this store's collection_products
      // (lib/catalog/effective.js cartRows); a line without them matches none
      return Array.isArray(item.collections) && item.collections.includes(target.value);
    default:
      return false;
  }
}
