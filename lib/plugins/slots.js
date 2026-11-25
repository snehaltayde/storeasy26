// Phase 4 line 2: the named storefront slots a plugin block can sit in. Pure
// and Edge-safe: no React, no Next, no node: imports.
//
// A slot is a fixed place on a storefront page. Each one says the page it is
// on (so "Preview on store" knows where to open), the context it hands to a
// block's data resolver, and how many blocks it holds. The context is picked
// field by field from what the page has (slotContext), so a resolver never
// sees more than the slot promises: public product fields on a product page,
// an order's id and states on an order page (no contact details), nothing in
// the footer. Phase 5 themes place `storeasy:plugin-slot` by these ids.
export const SLOT_MAX_BLOCKS = 3;

const PRODUCT_FIELDS = Object.freeze(["id", "handle", "title", "price_min", "price_max", "currency", "available", "display_vendor"]);
const ORDER_FIELDS = Object.freeze(["id", "status", "fulfillment_status", "created_at"]);

export const SLOTS = Object.freeze({
  "storefront.pdp.under_price": Object.freeze({ page: "product", label: "Product page, under the price", fields: PRODUCT_FIELDS }),
  "storefront.pdp.under_atc": Object.freeze({ page: "product", label: "Product page, under Add to cart", fields: PRODUCT_FIELDS }),
  "storefront.pdp.below_fold": Object.freeze({ page: "product", label: "Product page, below the details", fields: PRODUCT_FIELDS }),
  "storefront.order.status": Object.freeze({ page: "order", label: "Order status page", fields: ORDER_FIELDS }),
  "storefront.footer.above": Object.freeze({ page: "any", label: "Every page, above the footer", fields: Object.freeze([]) }),
});
export const SLOT_IDS = Object.freeze(Object.keys(SLOTS));

export const isSlot = (id) => typeof id === "string" && Object.hasOwn(SLOTS, id);

// The context a slot hands a resolver: only its declared fields, each a
// string, number, boolean or null.
export function slotContext(slot, raw) {
  const out = {};
  if (!isSlot(slot) || raw === null || typeof raw !== "object") return out;
  for (const f of SLOTS[slot].fields) {
    const v = raw[f];
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[f] = v;
  }
  return out;
}
