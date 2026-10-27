// Money definitions (Session 31 / BE36). ONE place for currency metadata,
// minor-unit conversion, rounding and drift-free allocation — every amount
// comparison against a provider (Razorpay paise, Shopify totals) goes through
// minor units here instead of ad-hoc `* 100` and float-epsilon compares.
//
// Semantics across the app (documented, enforced by usage):
//   • cart/checkout figures shown BEFORE an order exists are ESTIMATES
//   • the order row's totals are OUR captured contract
//   • Shopify/Razorpay remain authoritative for charged/refunded money —
//     local projections (refunded_total etc.) mirror them, never invent them.
// Edge- and Node-safe (pure arithmetic).

// exponent = minor units per major unit (10^exp). Currencies we may meet; an
// unknown currency falls back to 2 (the ISO-4217 default) — never assume all
// currencies have two decimals, so the table is explicit where it matters.
const EXPONENT = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0, // zero-decimal
  KRW: 0,
  VND: 0,
  KWD: 3, // three-decimal
  BHD: 3,
  OMR: 3,
};

export const currencyExponent = (currency) => EXPONENT[String(currency || "INR").toUpperCase()] ?? 2;

// major-unit number (possibly float-noisy) → integer minor units
export function toMinor(amount, currency = "INR") {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`not an amount: ${amount}`);
  return Math.round(n * 10 ** currencyExponent(currency));
}

// integer minor units → exact major-unit number
export function fromMinor(minor, currency = "INR") {
  const n = Number(minor);
  if (!Number.isInteger(n)) throw new Error(`minor units must be integers: ${minor}`);
  return n / 10 ** currencyExponent(currency);
}

// snap a major-unit float to its currency's precision (kills float drift)
export const roundMoney = (amount, currency = "INR") => fromMinor(toMinor(amount, currency), currency);

// equality at minor-unit precision — THE way to compare amounts
export const sameAmount = (a, b, currency = "INR") => toMinor(a, currency) === toMinor(b, currency);

// Split `total` proportionally to `weights` with the largest-remainder method:
// the parts are integers in minor units and ALWAYS sum exactly to the total —
// partial-refund / discount allocation without a paisa of drift.
export function allocateProportional(total, weights, currency = "INR") {
  const totalMinor = toMinor(total, currency);
  const ws = weights.map((w) => Math.max(0, Number(w) || 0));
  const weightSum = ws.reduce((a, b) => a + b, 0);
  if (!weightSum) {
    // no weights: everything to the first part (callers decide better splits)
    return ws.map((_, i) => (i === 0 ? totalMinor : 0));
  }
  const exact = ws.map((w) => (totalMinor * w) / weightSum);
  const floors = exact.map(Math.floor);
  let remainder = totalMinor - floors.reduce((a, b) => a + b, 0);
  // hand out the leftover minor units to the largest fractional parts
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) out[order[k].i] += 1;
  return out;
}
