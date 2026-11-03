// What a shopper may read from a caught error (GEN-03). lib/customers.js and
// lib/returns.js throw plain `new Error("…")` with copy written for shoppers.
// Anything else (a database error with a code, a TypeError from a failed fetch)
// carries internals, so the caller's fallback shows instead.
export function shopperErrorMessage(e, fallback) {
  if (e?.name === "Error" && !e.code && e.message) return e.message;
  return fallback;
}

// The /api/checkout messages that are safe to show as written.
const SHOPPER_CHECKOUT_ERRORS = /^(please fill all required fields|this checkout attempt no longer matches|online payment isn.t available|too many requests)/i;

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
  if (SHOPPER_CHECKOUT_ERRORS.test(data.error || "")) return data.error;
  return "Could not continue — your cart is untouched, please retry.";
}
