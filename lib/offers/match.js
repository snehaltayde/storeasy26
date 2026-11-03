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
    default:
      return false;
  }
}
