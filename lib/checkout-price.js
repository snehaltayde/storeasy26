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
import { formatMoney, MONEY_PATTERN } from "./format.js";
import { sameAmount, roundMoney } from "./money.js";

export const PRICE_CHANGED = "PRICE_CHANGED";

const isAmount = (v) => v != null && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v));

// → null when the shown total is the charged total, else { total, shippingTotal, message }.
// Phase 8 line 2: `paymentDiscount` is the prepaid discount the server priced
// (lib/checkout/payment-terms.js), never a number from the request.
// Phase 8 line 4: `expectedCurrency`, the currency the shopper was shown; the
// same number in another currency is not the same total.
export function priceMismatch({ expectedTotal, expectedShipping, goodsTotal = 0, shippingTotal = 0, paymentDiscount = 0, currency = "INR", expectedCurrency = null }) {
  const total = roundMoney((Number(goodsTotal) || 0) - (Number(paymentDiscount) || 0) + (Number(shippingTotal) || 0), currency);
  const sameCurrency = !expectedCurrency || String(expectedCurrency).toUpperCase() === String(currency).toUpperCase();
  if (sameCurrency && isAmount(expectedTotal) && sameAmount(Number(expectedTotal), total, currency)) return null;
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
// Phase 8 line 4: any allowlisted currency's format (lib/format.js MONEY_PATTERN).
export const PRICE_CHANGED_MESSAGE = new RegExp(`^(Shipping changed|Your total changed|Your country changed) — your new total is ${MONEY_PATTERN}\\. Review and place order\\.$`);
