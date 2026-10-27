// Commerce adapter boundary (Session 32 / BE06). ONE place that says how a
// tenant's cart/checkout work and which mode is allowed — the capability gate
// the handoff requires: payment modes are explicit per-tenant configuration,
// never switched silently, and a disabled checkout fails loudly while the
// storefront keeps browsing/cart intact.
//
//   checkout_mode (tenant config; env CHECKOUT_MODE in legacy mode):
//     "direct"   — the existing first-party checkout (Razorpay prepaid + COD,
//                  server carts, idempotent orders, draft-order push). DEFAULT.
//     "disabled" — checkout off (onboarding/suspension/compliance hold); the
//                  API answers 503 CHECKOUT_DISABLED, the page explains.
//     "shopify"  — RESERVED for the Shopify-hosted checkout handoff (built in a
//                  later wave behind this same gate; selecting it today keeps
//                  checkout OFF rather than pretending).
//
// Cart primitives stay in lib/cart.js and the order machine in lib/orders.js —
// this module is the capability surface in front of them. Edge- and Node-safe.
import { tenantCfg, tenantOwnCfg, tenantOwnSecret } from "../tenant-context.js";

export const CHECKOUT_MODES = ["direct", "disabled", "shopify"];

export function checkoutMode() {
  const raw = String(tenantCfg("checkout_mode", "CHECKOUT_MODE", "direct") || "direct").toLowerCase();
  return CHECKOUT_MODES.includes(raw) ? raw : "disabled"; // unknown value = fail closed, loudly visible
}

// What THIS tenant's shoppers can actually do right now. `available` gates the
// checkout API/page; the method flags drive the UI (COD is always offerable in
// direct mode; prepaid needs the tenant's own Razorpay keys — S24 scoping).
export function checkoutCapability() {
  const mode = checkoutMode();
  if (mode !== "direct") {
    return {
      mode,
      available: false,
      cod: false,
      razorpay: false,
      reason:
        mode === "shopify"
          ? "Shopify-hosted checkout is not implemented yet — mode reserved, checkout disabled"
          : "Checkout is disabled for this store",
    };
  }
  const razorpay = Boolean(
    tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID") &&
      tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET"),
  );
  return { mode, available: true, cod: true, razorpay };
}
