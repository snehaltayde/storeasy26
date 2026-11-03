// What a shopper may read from a caught error (GEN-03). lib/customers.js and
// lib/returns.js throw plain `new Error("…")` with copy written for shoppers.
// Anything else (a database error with a code, a TypeError from a failed fetch)
// carries internals, so the caller's fallback shows instead.
export function shopperErrorMessage(e, fallback) {
  if (e?.name === "Error" && !e.code && e.message) return e.message;
  return fallback;
}
