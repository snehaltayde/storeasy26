import { PRICE_CHANGED, PRICE_CHANGED_MESSAGE } from "./checkout-price.js";
import { isCodSentence } from "./checkout/payment-terms.js";

// What a shopper may read from a caught error (GEN-03). Copy written for shoppers
// is thrown as a ShopperError. Anything else, whatever it looks like, may carry
// internals ("SQLITE_BUSY: database is locked" is a plain Error too), so the
// caller's fallback shows instead.
export class ShopperError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShopperError";
  }
}

export function shopperErrorMessage(e, fallback) {
  return e instanceof ShopperError && e.message ? e.message : fallback;
}

// The /api/checkout messages that are safe to show as written. Exact matches only:
// raw text can start with the same words.
const SHOPPER_CHECKOUT_ERRORS = new Set([
  "Please fill all required fields",
  "This checkout attempt no longer matches your cart. Please retry.",
  "Online payment isn't available for this store right now.",
  "Too many requests",
  "Please enter a valid phone number.", // Phase 8 line 2 (lib/checkout/phone.js)
]);

// S32 (SF07): honest handoff states — the cart is never lost on a failure, say
// so, and explain the recoverable cases instead of parroting codes.
const SUBSCRIPTION_CODES = new Set(["SIGN_IN_TO_SUBSCRIBE", "SUBSCRIPTION_BASE_MARKET", "RENEWAL_CHANGED", "RENEWAL_PAYMENT_PENDING"]);
export function friendlyCheckoutError(data = {}) {
  if (data.code === "CHECKOUT_DISABLED") {
    return "Checkout is temporarily unavailable for this store — your cart is saved, nothing was charged. Please try again later.";
  }
  // P1-RATES: the new total, in the server's own words (lib/checkout-price.js).
  if (data.code === PRICE_CHANGED && PRICE_CHANGED_MESSAGE.test(data.error || "")) return data.error;
  // Phase 8 line 2: COD availability and the COD code, in their own sentences.
  if (/^COD_/.test(data.code || "") && isCodSentence(data.error)) return data.error;
  // Phase 9 line 2: the subscription refusals are written for shoppers (app/api/checkout/route.js)
  if (SUBSCRIPTION_CODES.has(data.code) && typeof data.error === "string" && data.error.length <= 200) return data.error;
  if (/cart is empty|no cart session/i.test(data.error || "")) {
    return "Your cart session expired — your items may still be in the cart. Go back to the cart and try again.";
  }
  // GEN-03: only messages written for shoppers pass through. The route's
  // catch-all forwards raw internals (provider responses, database errors).
  if (SHOPPER_CHECKOUT_ERRORS.has(data.error)) return data.error;
  return "Could not continue — your cart is untouched, please retry.";
}
