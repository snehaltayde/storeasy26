// Phase 8 line 2 (decisions 10–12): what each payment method costs this cart.
// PURE and client-safe: the checkout API's `quote` and every placing action
// price with it, the checkout page draws its first render with it (on the
// store's own configs, before the quote lands), and the console's worked
// example uses it, so the number a founder reads, the number a shopper sees and
// the number charged come from one function.
//
// Total = goods (post-offer cart total) − prepaid discount + shipping.
// The prepaid discount never changes free-shipping eligibility: shipping is
// priced on the goods total before it.
import { computeShipping } from "../shipping.js";
import { roundMoney } from "../money.js";
import { formatMoney, MONEY_PATTERN } from "../format.js";

export const PREPAID_PERCENT_CAP = 20;


// Percent: capped at 20, of the goods total, rounded down to whole currency
// units, then the founder's cap. Fixed: the amount. Never more than the goods.
export function prepaidDiscountFor(goods, prepaid, currency = "INR") {
  const g = Number(goods) || 0;
  const value = Number(prepaid?.value) || 0;
  if (!prepaid || g <= 0 || value <= 0) return 0;
  let d = prepaid.kind === "percent" ? Math.floor((g * Math.min(value, PREPAID_PERCENT_CAP)) / 100 + 1e-9) : prepaid.kind === "fixed" ? value : 0;
  if (prepaid.max != null && Number.isFinite(Number(prepaid.max))) d = Math.min(d, Number(prepaid.max));
  return roundMoney(Math.max(0, Math.min(d, g)), currency);
}

const otpNeeded = (cod, total) => (cod?.otp === "always" ? true : cod?.otp === "above" ? total > Number(cod.otpAbove ?? Infinity) : false);

// Phase 8 line 1 review: the one COD rule. The zone comes from computeShipping
// (lib/shipping.js zoneFor, `zoneCod: false`), never a copy. `codTotal` null =
// not known yet (the product page): then the total-bound rules (maxTotal, an
// OTP "above" an amount) can't refuse, and the caller says "for this PIN code".
// Phase 8 line 4 (decision 12): cash on delivery only in the base market.
export const COD_OUTSIDE_BASE = "Cash on delivery isn't available outside the store's own country";
export function codReason({ ship, codCfg, codTotal = null, smsAvailable = true, currency = "INR", outsideBase = false }) {
  if (outsideBase) return COD_OUTSIDE_BASE;
  if (ship?.zoneCod === false) return "Cash on delivery isn't available for this PIN code";
  if (codTotal != null && codCfg?.maxTotal != null && codTotal > Number(codCfg.maxTotal)) return `Cash on delivery isn't available for orders over ${formatMoney(Number(codCfg.maxTotal), currency)}`;
  const otp = codTotal == null ? codCfg?.otp === "always" : otpNeeded(codCfg, codTotal);
  if (otp && codCfg?.otpChannel === "sms" && !smsAvailable) return "Cash on delivery isn't available right now";
  return null;
}

// The product page's "Check delivery" (Phase 8 line 1): true only when this
// PIN's zone and the whole store allow COD (open store, a link secret, an SMS
// code it can send); false only when the zone turns it off (the PIN is why);
// null when the store can't take a COD order at all, so no COD line shows.
export function codForPin({ shippingConfig, paymentConfig, pincode, smsAvailable = true, storeOpen = true, linkSecret = true }) {
  const ship = computeShipping({ subtotal: 0, pincode: pincode || null, config: shippingConfig ?? undefined });
  if (ship.zoneCod === false) return false;
  if (!storeOpen || !linkSecret) return null;
  return codReason({ ship, codCfg: paymentConfig?.cod || null, smsAvailable }) ? null : true;
}

// → { prepaid: { available, shipping, discount, total },
//     cod: { available, reason, fee, shipping, total, otpRequired, otpChannel },
//     nudge: { save, parts: [{ kind: "codFee"|"discount", amount, words }] }, currency }
// `smsAvailable`: the server says whether SMS codes can be sent; COD that needs
// an SMS code is hidden where they can't (the page's first render assumes yes).
// `outsideBase`: the cart is priced in a market other than the store's own (line 4).
export function paymentTerms({ cart, shippingConfig, paymentConfig, pincode = null, prepaidAvailable = true, smsAvailable = true, outsideBase = false }) {
  const currency = cart?.currency || "INR";
  const goods = Number(cart?.total) || 0;
  const ship = (paymentMethod) =>
    computeShipping({ subtotal: cart?.subtotal || 0, discountTotal: cart?.discountTotal || 0, paymentMethod, pincode: pincode || null, config: shippingConfig ?? undefined });
  const pShip = ship("prepaid");
  const cShip = ship("cod");
  const money = (n) => roundMoney(n, currency);

  const prepaidCfg = paymentConfig?.prepaid || null;
  const discount = prepaidAvailable ? prepaidDiscountFor(goods, prepaidCfg, currency) : 0;
  const prepaid = { available: Boolean(prepaidAvailable), shipping: pShip.total, discount, total: money(goods - discount + pShip.total) };

  const codCfg = paymentConfig?.cod || null;
  const codTotal = money(goods + cShip.total);
  const reason = codReason({ ship: cShip, codCfg, codTotal, smsAvailable, currency, outsideBase });
  const cod = {
    available: !reason,
    reason,
    fee: cShip.codFee,
    shipping: cShip.total,
    total: codTotal,
    otpRequired: !reason && otpNeeded(codCfg, codTotal),
    otpChannel: codCfg?.otpChannel || "email",
  };

  const save = prepaid.available && cod.available ? money(cod.total - prepaid.total) : 0;
  const parts = [];
  if (save > 0) {
    const feeGap = money(cShip.total - pShip.total);
    if (feeGap > 0) parts.push({ kind: "codFee", amount: feeGap, words: `no ${formatMoney(feeGap, currency)} COD fee` });
    if (discount > 0) {
      const asPercent = prepaidCfg.kind === "percent" && discount === Math.floor((goods * Math.min(prepaidCfg.value, PREPAID_PERCENT_CAP)) / 100 + 1e-9);
      parts.push({ kind: "discount", amount: discount, words: asPercent ? `${Math.min(prepaidCfg.value, PREPAID_PERCENT_CAP)}% off` : `${formatMoney(discount, currency)} off` });
    }
  }
  return { prepaid, cod, nudge: { save: save > 0 ? save : 0, parts: save > 0 ? parts : [] }, currency };
}

// "Pay online and save ₹128: no ₹49 COD fee and 5% off". Amounts only.
export function nudgeSentence(nudge, currency = "INR") {
  if (!nudge?.save) return null;
  const words = nudge.parts.map((p) => p.words);
  const tail = words.length ? `: ${words.join(" and ")}` : "";
  return `Pay online and save ${formatMoney(nudge.save, currency)}${tail}`;
}

// Settings → Checkout: the worked example, in words, from paymentTerms itself.
export function paymentExample(paymentConfig = {}, shippingConfig) {
  const currency = shippingConfig?.currency || "INR";
  const fmt = (n) => formatMoney(n, currency);
  const cart = { subtotal: 1000, discountTotal: 0, total: 1000, currency };
  const t = paymentTerms({ cart, shippingConfig, paymentConfig });
  const out = [];
  if (t.cod.available) {
    out.push(
      t.nudge.save > 0
        ? `A ${fmt(1000)} order costs ${fmt(t.cod.total)} by cash on delivery and ${fmt(t.prepaid.total)} paid online, so paying online saves ${fmt(t.nudge.save)}.`
        : `A ${fmt(1000)} order costs ${fmt(t.cod.total)} by cash on delivery and ${fmt(t.prepaid.total)} paid online.`,
    );
  } else {
    out.push(`A ${fmt(1000)} order costs ${fmt(t.prepaid.total)} paid online. ${t.cod.reason}.`);
  }
  const cod = paymentConfig?.cod;
  if (cod?.maxTotal != null) out.push(`Cash on delivery is offered up to ${fmt(cod.maxTotal)}.`);
  const by = cod?.otpChannel === "sms" ? "SMS, which confirms the phone number" : "email, which confirms the email address, not the phone";
  if (cod?.otp === "always") out.push(`Every cash-on-delivery order asks for a code sent by ${by}.`);
  if (cod?.otp === "above") out.push(`Cash-on-delivery orders over ${fmt(cod.otpAbove)} ask for a code sent by ${by}.`);
  return out;
}

// The COD code's answers, one sentence each (decision 13). They name no other
// order, phone or account. Client-safe, so friendlyCheckoutError passes exactly
// these through.
export const COD_OTP_MESSAGES = {
  wrong: "That code isn't right. Check it and try again.",
  expired: "That code has expired. Ask for a new code.",
  locked: "Too many wrong tries. Ask for a new code.",
  stale: "Your order changed after we sent the code. Ask for a new code.",
  required: "Confirm your phone number with a code to place this order.",
  cooldown: "Please wait 30 seconds before asking for another code.",
  cartCap: "You've asked for 3 codes for this order. Try again in 30 minutes, or pay online.",
  ipCap: "Too many codes were asked for from this network. Try again in 15 minutes.",
  cantSend: "We couldn't send a code right now. Try again in a minute, or pay online.",
  badPhone: "Please enter a valid phone number.",
};
const COD_SENTENCES = new Set(Object.values(COD_OTP_MESSAGES));
const COD_REASON = new RegExp(`^Cash on delivery isn't available (for this PIN code|for orders over ${MONEY_PATTERN}|right now|${COD_OUTSIDE_BASE.replace("Cash on delivery isn't available ", "")})$`);
export const isCodSentence = (text) => COD_SENTENCES.has(text) || COD_REASON.test(String(text || ""));
