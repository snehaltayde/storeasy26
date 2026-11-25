// Shipping calculation engine (Session 13). PURE + config-driven — the single
// source of truth the drawer, checkout (client + API), and the Shopify push all
// call, so the amount shown == charged == pushed.
//
// ⚠ RULES ARE PLACEHOLDERS: BeastLife's public policy states no amounts, so
// these are standard Indian-D2C defaults. When their real rules land, edit
// SHIPPING_CONFIG below (and zones if they ship pincode-differentiated) —
// nothing else changes anywhere in the app.
//
// Client-safe: no secrets, no server imports (CheckoutFlow imports it for the
// live per-payment-method recompute; the checkout API recomputes the same
// inputs server-side and ITS number is what gets charged).

import { estimateDays } from "./delivery-estimate.js";

export const SHIPPING_CONFIG = {
  currency: "INR",
  basis: "net", // threshold compares against subtotal − discounts ("gross" = pre-discount)
  freeThreshold: 999, // goods total ≥ this → base shipping free
  flatRate: 79, // below the threshold
  codFee: 49, // added when paymentMethod === "cod" (0 to disable)
  codFeeWaivedAt: null, // goods total ≥ this waives the COD fee (null = never)
  // Pincode zones (first match wins). Each may override rate/threshold, e.g.:
  //   { prefixes: ["19", "18"], label: "Remote zone", flatRate: 149, freeThreshold: 1999 }
  zones: [],
};

export function zoneFor(pincode, config = SHIPPING_CONFIG) {
  if (!pincode) return null;
  const pin = String(pincode).trim();
  return (
    (config.zones || []).find((z) => (z.prefixes || []).some((p) => pin.startsWith(p))) || null
  );
}

// → { method, label, base, codFee, total, free, freeThreshold, remainingForFree, zone, estimate?, zoneCod? }
//   estimate: { minDays, maxDays } from the store's dispatch + delivery days
//   (lib/delivery-estimate.js), absent when the store set none; zoneCod: false,
//   present only when the pincode's zone turns cash on delivery off (Phase 8
//   line 1). Absent keys keep an existing store's cart and snapshot shapes.
//   method: "free" | "standard"  (Shopify line title comes from `label`)
// Session 20 note: this module stays PURE and client-safe (the checkout UI
// imports it). Server call-sites (getCart, the checkout API) pass the active
// tenant's shipping_config explicitly via tenantShippingConfig() from
// lib/tenant-context.js; the default below is the env/single-store fallback.
export function computeShipping({
  subtotal = 0,
  discountTotal = 0,
  paymentMethod = "prepaid", // "prepaid" (razorpay) | "cod"
  pincode = null,
  config = SHIPPING_CONFIG,
} = {}) {
  const goods = config.basis === "gross" ? subtotal : subtotal - discountTotal;
  const zone = zoneFor(pincode, config);
  const freeThreshold = zone?.freeThreshold ?? config.freeThreshold;
  const flatRate = zone?.flatRate ?? config.flatRate;

  const free = freeThreshold != null && goods >= freeThreshold;
  const base = free ? 0 : flatRate;

  const codFeeWaived =
    config.codFeeWaivedAt != null && goods >= config.codFeeWaivedAt;
  const codFee = paymentMethod === "cod" && !codFeeWaived ? config.codFee || 0 : 0;

  const total = base + codFee;
  const estimate = estimateDays(config, zone);
  const parts = [];
  if (free) parts.push(`Free shipping (₹${freeThreshold}+)`);
  else parts.push(zone?.label ? `${zone.label} shipping` : "Standard shipping");
  if (codFee > 0) parts.push(`COD fee ₹${codFee}`);

  return {
    method: total === 0 ? "free" : "standard",
    label: parts.join(" + "),
    base,
    codFee,
    total,
    free,
    freeThreshold,
    remainingForFree: free || freeThreshold == null ? 0 : Math.max(0, freeThreshold - goods),
    zone: zone?.label || null,
    // only when set, so a store without them keeps its cart and order shapes
    ...(estimate ? { estimate } : {}),
    ...(zone?.cod === false ? { zoneCod: false } : {}),
  };
}
