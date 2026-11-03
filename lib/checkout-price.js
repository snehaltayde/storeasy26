// P1-RATES: a shopper is charged the amount on the button they pressed, or
// nothing. Pure and client-safe: the checkout API decides with it, and the
// checkout UI and lib/shopper-errors.js read the same code and wording.
//
// The checkout UI sends the total it showed (expectedTotal) and the shipping
// inside it (expectedShipping). The server prices the cart with the store's
// current rates; when the two totals differ it refuses before any order row or
// Razorpay order exists, and says the new amount. A request that names no total
// (an old browser tab from before this change) is refused the same way: nothing
// proves the shopper saw the amount.
import { formatMoney } from "./format.js";
import { sameAmount } from "./money.js";

export const PRICE_CHANGED = "PRICE_CHANGED";

const isAmount = (v) => v != null && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v));

// → null when the shown total is the charged total, else { total, shippingTotal, message }.
export function priceMismatch({ expectedTotal, expectedShipping, goodsTotal = 0, shippingTotal = 0, currency = "INR" }) {
  const total = (Number(goodsTotal) || 0) + (Number(shippingTotal) || 0);
  if (isAmount(expectedTotal) && sameAmount(Number(expectedTotal), total, currency)) return null;
  const amount = formatMoney(total, currency);
  const shippingMoved = isAmount(expectedShipping) && !sameAmount(Number(expectedShipping), shippingTotal, currency);
  return {
    total,
    shippingTotal,
    message: shippingMoved
      ? `Shipping changed — your new total is ${amount}. Review and place order.`
      : `Your total changed — your new total is ${amount}. Review and place order.`,
  };
}

// The exact sentences priceMismatch writes, so the UI passes them through and
// nothing else under that code.
export const PRICE_CHANGED_MESSAGE = /^(Shipping changed|Your total changed) — your new total is [^\s]{1,4}[\d,]+(\.\d{1,2})?\. Review and place order\.$/;
