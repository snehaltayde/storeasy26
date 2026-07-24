// Offer validation (Session 19) — guards the admin so a typo can't wedge the
// cart engine. Mirrors exactly what lib/offers/engine.js consumes.

const TARGET_KINDS = ["handle", "productId", "variantId", "tag", "productType"];
const SLUG = /^[a-z0-9][a-z0-9-]{2,60}$/;

export const OFFER_TYPES = ["BXGY", "TIERED_QTY", "FREE_GIFT", "COUPON"];

export function validateOffer(offer) {
  const errors = [];
  if (!offer || typeof offer !== "object") return ["Offer must be an object"];
  if (!SLUG.test(offer.id || "")) errors.push("id: lowercase slug (a-z, 0-9, dashes), 3-60 chars");
  if (!OFFER_TYPES.includes(offer.type)) errors.push(`type: one of ${OFFER_TYPES.join("/")}`);
  if (!offer.title || String(offer.title).length < 3) errors.push("title: required (shown to customers)");
  if (offer.priority != null && !(Number.isFinite(offer.priority) && offer.priority >= 0))
    errors.push("priority: non-negative number");

  const target = () => {
    if (!offer.target || !TARGET_KINDS.includes(offer.target.kind))
      errors.push(`target.kind: one of ${TARGET_KINDS.join("/")}`);
    if (!offer.target?.value) errors.push("target.value: required");
  };

  switch (offer.type) {
    case "BXGY":
      if (offer.scope !== "line") errors.push('BXGY scope must be "line"');
      target();
      if (!(Number.isInteger(offer.buy) && offer.buy >= 1)) errors.push("buy: integer ≥ 1");
      if (!(Number.isInteger(offer.free) && offer.free >= 1)) errors.push("free: integer ≥ 1");
      break;
    case "TIERED_QTY":
      if (offer.scope !== "line") errors.push('TIERED_QTY scope must be "line"');
      target();
      if (!Array.isArray(offer.tiers) || !offer.tiers.length) errors.push("tiers: at least one tier");
      for (const [i, t] of (offer.tiers || []).entries()) {
        if (!(Number.isInteger(t.minQty) && t.minQty >= 1)) errors.push(`tiers[${i}].minQty: integer ≥ 1`);
        if (!(Number.isFinite(t.percent) && t.percent > 0 && t.percent <= 90))
          errors.push(`tiers[${i}].percent: 0–90`);
      }
      break;
    case "FREE_GIFT":
      if (offer.scope !== "gift") errors.push('FREE_GIFT scope must be "gift"');
      if (!(Number.isFinite(offer.threshold) && offer.threshold > 0)) errors.push("threshold: ₹ > 0");
      if (!offer.gift?.variantId?.startsWith("gid://shopify/ProductVariant/"))
        errors.push("gift.variantId: full Shopify variant GID");
      if (!offer.gift?.title) errors.push("gift.title: required");
      break;
    case "COUPON":
      if (offer.scope !== "order") errors.push('COUPON scope must be "order"');
      if (!/^[A-Z0-9]{3,20}$/.test(offer.code || "")) errors.push("code: A-Z/0-9, 3-20 chars");
      if (!["percent", "fixed"].includes(offer.discount?.kind)) errors.push("discount.kind: percent|fixed");
      if (!(Number.isFinite(offer.discount?.value) && offer.discount.value > 0))
        errors.push("discount.value: > 0");
      if (offer.discount?.kind === "percent" && offer.discount.value > 90)
        errors.push("discount.value: percent capped at 90");
      if (offer.minSubtotal != null && !(Number.isFinite(offer.minSubtotal) && offer.minSubtotal >= 0))
        errors.push("minSubtotal: ₹ ≥ 0");
      if (offer.combinable != null && typeof offer.combinable !== "boolean")
        errors.push("combinable: true/false");
      break;
    default:
      break;
  }
  return errors;
}
