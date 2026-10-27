// Sample-cart offer simulator (Session 32 / BE07+MC14). Runs the EXACT pure
// engine (evaluateOffers + computeShipping) on deterministic fixture carts —
// the merchant proves an offer before enabling it, and combination behavior
// with the other active offers is shown instead of guessed. No DB writes; the
// only read is the active-offer list for combination preview.
import { evaluateOffers } from "./engine.js";
import { getActiveOffers } from "./store.js";
import { computeShipping } from "../shipping.js";
import { tenantShippingConfig } from "../tenant-context.js";
import { validateOffer } from "./validate.js";

// Canned carts: tags/types cover the common rule targets. Deterministic by
// construction (fixed prices/quantities; the engine is pure).
export const SAMPLE_CARTS = {
  small: {
    label: "Small basket (₹499)",
    items: [
      { variantId: "gid://sim/V1", productId: "gid://sim/P1", handle: "sim-whey", title: "Sim Whey 500g", productType: "Protein", tags: ["protein", "bestseller"], price: 499, quantity: 1 },
    ],
  },
  medium: {
    label: "Medium basket (₹1,897)",
    items: [
      { variantId: "gid://sim/V1", productId: "gid://sim/P1", handle: "sim-whey", title: "Sim Whey 500g", productType: "Protein", tags: ["protein", "bestseller"], price: 499, quantity: 2 },
      { variantId: "gid://sim/V2", productId: "gid://sim/P2", handle: "sim-creatine", title: "Sim Creatine", productType: "Creatine", tags: ["creatine"], price: 899, quantity: 1 },
    ],
  },
  large: {
    label: "Large basket (₹4,296)",
    items: [
      { variantId: "gid://sim/V3", productId: "gid://sim/P3", handle: "sim-isolate", title: "Sim Isolate 2kg", productType: "Protein", tags: ["protein", "isolate"], price: 2999, quantity: 1 },
      { variantId: "gid://sim/V2", productId: "gid://sim/P2", handle: "sim-creatine", title: "Sim Creatine", productType: "Creatine", tags: ["creatine"], price: 899, quantity: 1 },
      { variantId: "gid://sim/V4", productId: "gid://sim/P4", handle: "sim-shaker", title: "Sim Shaker", productType: "Accessory", tags: ["accessory"], price: 398, quantity: 1 },
    ],
  },
};

// Simulate ONE candidate offer (validated first) on a sample cart:
//   alone        — only this offer
//   combined     — this offer alongside the tenant's currently ACTIVE offers
// Returns applied/why-not, discounts, gifts, coupon status, shipping estimate,
// and combination notes (e.g. a second coupon that can never co-apply).
export async function simulateOffer({ offer, enabled = true, cartKey = "medium", coupon = null }) {
  const sample = SAMPLE_CARTS[cartKey] || SAMPLE_CARTS.medium;
  const errors = validateOffer(offer);
  if (errors.length) return { ok: false, errors };

  const candidate = { ...offer };
  const isCoupon = String(candidate.type || "").toLowerCase().startsWith("coupon");
  const useCoupon = coupon ?? (isCoupon ? candidate.code : null);

  const run = (offers) => {
    const result = evaluateOffers(sample.items, { offers, coupon: useCoupon });
    const shipping = computeShipping({
      subtotal: result.subtotal,
      discountTotal: result.discountTotal,
      paymentMethod: "prepaid",
      config: tenantShippingConfig(),
    });
    return {
      subtotal: result.subtotal,
      discountTotal: result.discountTotal,
      total: result.total,
      appliedOffers: result.appliedOffers,
      gifts: (result.gifts || []).map((g) => ({ title: g.title, variantId: g.variantId })),
      couponStatus: result.couponStatus || null,
      shippingEstimate: shipping.total,
    };
  };

  const alone = run(enabled ? [candidate] : []);
  const active = await getActiveOffers();
  const others = active.filter((o) => o.id !== candidate.id);
  const combined = run(enabled ? [...others, candidate] : others);

  const appliedAlone = alone.appliedOffers.some((a) => a.id === candidate.id);
  const appliedCombined = combined.appliedOffers.some((a) => a.id === candidate.id);
  const notes = [];
  if (!enabled) notes.push("Offer is disabled — simulated as inactive.");
  if (enabled && !appliedAlone) {
    notes.push(
      isCoupon && !useCoupon
        ? "Coupon offers apply only when the shopper enters the code — simulated without it."
        : "Did not apply to this sample cart (threshold/targeting not met).",
    );
  }
  if (enabled && appliedAlone && !appliedCombined) {
    notes.push("Applies alone but NOT alongside the currently active offers (combination conflict — e.g. one coupon per cart).");
  }
  const otherCoupons = others.filter((o) => String(o.type || "").toLowerCase().startsWith("coupon"));
  if (isCoupon && otherCoupons.length) {
    notes.push(`Note: ${otherCoupons.length} other coupon offer(s) exist — only one coupon code applies per cart.`);
  }

  return {
    ok: true,
    cart: { key: cartKey, label: sample.label, items: sample.items.map((i) => ({ title: i.title, price: i.price, quantity: i.quantity })) },
    alone,
    combined,
    applied: { alone: appliedAlone, combined: appliedCombined },
    activeOfferCount: others.length,
    notes,
  };
}
