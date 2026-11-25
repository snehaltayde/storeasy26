// Money + image helpers shared across server and client components.
import { currencyExponent } from "./money.js";

// Phase 8 line 4: the locale follows the currency (en-IN for INR, exactly as
// before, so every INR string is byte-identical); a fraction shows the
// currency's own decimals (lib/money.js).
const LOCALE = { INR: "en-IN", USD: "en-US", EUR: "en-IE", GBP: "en-GB", AED: "en-AE", SGD: "en-SG", AUD: "en-AU", CAD: "en-CA", JPY: "ja-JP" };
export const moneyLocale = (currency) => LOCALE[String(currency || "INR").toUpperCase()] || "en-IN";

// The shape of any formatMoney amount ("₹1,499", "$17.99", "AED 12.50",
// "￥1,780"), for the regexes that pass server sentences through to shoppers.
export const MONEY_PATTERN = String.raw`(?:[A-Z]{3}\s|[^\s\d]{1,4})[\d,]+(?:\.\d{1,3})?`;

export function formatMoney(amount, currency = "INR") {
  if (amount == null || amount === "" || Number.isNaN(Number(amount))) return "";
  const n = Number(amount);
  try {
    return new Intl.NumberFormat(moneyLocale(currency), {
      style: "currency",
      currency,
      // Whole rupees read cleaner than ₹1,499.00
      maximumFractionDigits: Number.isInteger(n) ? 0 : Math.max(currencyExponent(currency), 0),
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// Ask the Shopify CDN for a right-sized image (keeps payloads small + fast).
export function shopifyImage(url, width) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return url;
  }
}

export function discountPercent(price, compareAt) {
  const p = Number(price);
  const c = Number(compareAt);
  if (!p || !c || c <= p) return 0;
  return Math.round(((c - p) / c) * 100);
}
