// Phase 8 line 4 (decision 15): a market order's base run, the money Shopify
// and the reports get. Pure. The presentment cart (lib/cart.js getCart with a
// market) carries `base` (catalog prices through the offers the shopper got);
// shipping is the market's shipping in base money at the market's rate; the
// prepaid discount is the store's own rule on the base goods, given only when
// the shopper got one.
import { roundMoney } from "../money.js";
import { toBaseAmount } from "../markets.js";
import { prepaidDiscountFor } from "./payment-terms.js";

export function baseFigures({ cart, market, shippingTotal = 0, paymentDiscount = 0, paymentConfig = null }) {
  if (!market || !cart?.base) return null;
  const b = cart.base;
  const currency = b.currency || "INR";
  const baseDiscount = Number(paymentDiscount) > 0 ? prepaidDiscountFor(b.total, paymentConfig?.prepaid || null, currency) : 0;
  const baseShipping = toBaseAmount(shippingTotal, market, currency);
  return {
    market: market.id,
    currency,
    rate: Number(market.rate),
    items: b.items,
    appliedOffers: b.appliedOffers,
    subtotal: roundMoney(b.subtotal, currency),
    discountTotal: roundMoney(b.discountTotal, currency),
    paymentDiscount: baseDiscount,
    shippingTotal: baseShipping,
    total: roundMoney(b.total - baseDiscount + baseShipping, currency),
  };
}
