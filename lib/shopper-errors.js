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
]);

// S32 (SF07): honest handoff states — the cart is never lost on a failure, say
// so, and explain the recoverable cases instead of parroting codes.
export function friendlyCheckoutError(data = {}) {
  if (data.code === "CHECKOUT_DISABLED") {
    return "Checkout is temporarily unavailable for this store — your cart is saved, nothing was charged. Please try again later.";
  }
  if (/cart is empty|no cart session/i.test(data.error || "")) {
    return "Your cart session expired — your items may still be in the cart. Go back to the cart and try again.";
  }
  // GEN-03: only messages written for shoppers pass through. The route's
  // catch-all forwards raw internals (provider responses, database errors).
  if (SHOPPER_CHECKOUT_ERRORS.has(data.error)) return data.error;
  return "Could not continue — your cart is untouched, please retry.";
}
