// Phase 8 line 4 (docs/plans/phase-8.md decisions 14–17): selling in more than
// one currency and country. PURE and Edge-safe (no node:*, no db): the
// storefront layout, the cart, the checkout API, the client's price display and
// the console's live example all convert with these functions, so the price a
// shopper reads on a card is the price on the cart line and the price charged.
//
// A market lives in tenants.config.markets:
//   { id, countries: ["US", …], currency: "USD", rate, rateSetAt, rounding,
//     flatRate, freeThreshold, enabled, international }
//   rate      base units per ONE market unit ("1 USD = ₹84.20" → 84.2)
//   rounding  "exact" | "whole" | "x.99" for prices (variant, compare-at,
//             bundle and gift prices). Amounts that are not prices (offer
//             thresholds, fixed coupon values) convert exactly.
//   id        the market's first country code, fixed at save
// The base market is the store itself (config.country, config.currency): no
// conversion, its own shipping config, the only market with cash on delivery.
import { currencyExponent, toMinor, fromMinor, roundMoney, RAZORPAY_CURRENCIES } from "./money.js";

export const MARKET_COOKIE = "_market";
export const ROUNDING_RULES = ["exact", "whole", "x.99"];
export const MAX_MARKETS = 10;
export const STALE_RATE_DAYS = 30;

const COUNTRY = /^[A-Z]{2}$/;
const up = (v) => String(v ?? "").trim().toUpperCase();

export function baseCountry(config) {
  const c = up(config?.country);
  return COUNTRY.test(c) ? c : "IN";
}
export const baseCurrency = (config) => up(config?.currency) || "INR";

// Region names without a table (Intl is Edge-safe); unknown codes → the code.
let regionNames = null;
export function countryName(code) {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}
const isRealCountry = (code) => COUNTRY.test(code) && countryName(code) !== code && !/unknown/i.test(countryName(code));

// ---- conversion ------------------------------------------------------------

// Rounds a market amount (already in market units) by the price rule, in
// integer minor units so no float noise survives. "whole" and "x.99" round UP
// (a converted price never drops below the founder's rate); in a zero-decimal
// currency there is nothing below one unit, so "x.99" is "whole".
function roundPrice(amount, currency, rule) {
  const exp = currencyExponent(currency);
  const unit = 10 ** exp;
  const m = toMinor(amount, currency);
  if (m <= 0) return 0;
  if (rule === "whole" || (rule === "x.99" && exp === 0)) return fromMinor(Math.ceil(m / unit) * unit, currency);
  if (rule === "x.99") return fromMinor(Math.ceil((m + 1) / unit) * unit - 1, currency);
  return fromMinor(m, currency);
}
// A positive base price never converts to nothing (₹0.40 at 84.2 is $0.01, not $0).
function atLeastOneMinor(amount, currency) {
  return amount > 0 && toMinor(amount, currency) === 0 ? fromMinor(1, currency) : amount;
}

const rateOf = (market) => Number(market?.rate) || 0;

// A base price → the market's price (rounding rule). No market → unchanged.
export function convertPrice(amount, market) {
  if (amount == null || amount === "") return amount;
  if (!market) return Number(amount);
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return roundPrice(n > 0 ? atLeastOneMinor(n / rateOf(market), market.currency) : n / rateOf(market), market.currency, market.rounding);
}

// A base amount that is not a price (a threshold, a fixed discount) → exact.
export function convertAmount(amount, market) {
  if (amount == null || amount === "") return amount;
  if (!market) return Number(amount);
  return roundMoney(Number(amount) / rateOf(market), market.currency);
}

// A market amount → base units, at the base currency's precision (decision 15:
// the base run's shipping is the market's shipping in base money).
export const toBaseAmount = (amount, market, currency = "INR") =>
  market ? roundMoney((Number(amount) || 0) * rateOf(market), currency) : roundMoney(Number(amount) || 0, currency);

// A price-filter bound the shopper typed in market money → base units, widened
// so a base price that converts to the bound is still inside it.
export function boundToBase(amount, market, side = "min") {
  if (amount == null || amount === "" || !market) return amount;
  const n = Number(amount) * rateOf(market);
  return side === "min" ? Math.floor(n) : Math.ceil(n);
}

// An offer row (lib/offers) with its money in the market's currency. Percent
// values and quantities stay as they are.
export function convertOffer(offer, market) {
  if (!market || !offer) return offer;
  const o = { ...offer };
  if (o.price != null) o.price = convertPrice(o.price, market); // BUNDLE set price
  if (o.threshold != null) o.threshold = convertAmount(o.threshold, market); // FREE_GIFT
  if (o.minSubtotal != null) o.minSubtotal = convertAmount(o.minSubtotal, market);
  if (o.discount?.kind === "fixed") o.discount = { ...o.discount, value: convertAmount(o.discount.value, market) };
  if (o.gift && o.gift.value != null) o.gift = { ...o.gift, value: convertPrice(o.gift.value, market) };
  return o;
}

// The market's shipping config for lib/shipping.js computeShipping: its own
// flat rate and free threshold in its currency, the base basis, no COD fee and
// no PIN-code zones (those are Indian PIN prefixes). No delivery estimate: the
// store's days are domestic.
export function marketShipping(market, baseConfig = {}) {
  if (!market) return baseConfig;
  return {
    currency: market.currency,
    basis: baseConfig?.basis === "gross" ? "gross" : "net",
    flatRate: Number(market.flatRate) || 0,
    freeThreshold: market.freeThreshold == null ? null : Number(market.freeThreshold),
    codFee: 0,
    codFeeWaivedAt: null,
    zones: [],
  };
}

// The prepaid discount in market money: a percent stays, a fixed value and a cap
// convert exactly. COD rules are irrelevant outside the base market.
export function marketPaymentConfig(paymentConfig, market) {
  if (!market || !paymentConfig) return paymentConfig ?? null;
  const p = paymentConfig.prepaid;
  if (!p) return { ...paymentConfig };
  const prepaid = { ...p };
  if (p.kind === "fixed") prepaid.value = convertAmount(p.value, market);
  if (p.max != null) prepaid.max = convertAmount(p.max, market);
  return { ...paymentConfig, prepaid };
}

// ---- choosing a market -------------------------------------------------------

const enabledOf = (config) => (Array.isArray(config?.markets) ? config.markets : []).filter((m) => m && m.enabled === true && Array.isArray(m.countries) && rateOf(m) > 0);

// The enabled market a country ships to, or null (the base market). A disabled
// market, an unknown country and the base country are all null.
export function marketForCountry(country, config) {
  const c = up(country);
  if (!COUNTRY.test(c) || c === baseCountry(config)) return null;
  return enabledOf(config).find((m) => m.countries.includes(c)) || null;
}

// The market of a request: the `_market` cookie (a country code) when it names
// the base country or an enabled market's country; otherwise, only when there
// is no cookie, the hosting's country suggestion when it is an enabled market.
export function resolveMarket({ cookie = null, ipCountry = null, config = null } = {}) {
  const c = up(cookie);
  if (COUNTRY.test(c) && (c === baseCountry(config) || marketForCountry(c, config))) return { country: c, market: marketForCountry(c, config) };
  if (!cookie) {
    const s = up(ipCountry);
    const m = marketForCountry(s, config);
    if (m) return { country: s, market: m };
  }
  return { country: baseCountry(config), market: null };
}

// What a browser may know about a market (no founder notes, no dates).
export const publicMarket = (m) => (m ? { id: m.id, countries: [...m.countries], currency: m.currency, rate: Number(m.rate), rounding: m.rounding } : null);

// The footer picker's and checkout's country list: the base country first, then
// every enabled market's countries.
export function countryOptions(config) {
  const base = baseCountry(config);
  const out = [{ country: base, name: countryName(base), currency: baseCurrency(config), base: true }];
  for (const m of enabledOf(config)) for (const c of m.countries) out.push({ country: c, name: countryName(c), currency: m.currency, base: false });
  return out;
}

export function currencySymbol(currency) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value || currency;
  } catch {
    return currency;
  }
}

// ---- postal codes (Phase 8 line 1 rule + decision for other countries) -----
export function postalCodeValid(code, country = "IN") {
  const s = String(code ?? "").trim();
  if (up(country) === "IN") return /^\d{6}$/.test(s);
  const compact = s.replace(/[\s-]/g, "");
  return /^[A-Za-z0-9]{3,10}$/.test(compact) && s.length <= 12;
}

// ---- founder settings ----------------------------------------------------------

const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
export const rateIsStale = (m, now = new Date()) => !isIso(m?.rateSetAt) || now.getTime() - Date.parse(m.rateSetAt) > STALE_RATE_DAYS * 86_400_000;

// input: the form's markets list; previous: the saved list (a rate keeps its
// date unless it changed). → { ok, errors, value }
export function validateMarkets(input, { config = {}, previous = [], now = new Date() } = {}) {
  const errors = [];
  if (!Array.isArray(input)) return { ok: false, errors: ["Markets must be a list"], value: [] };
  if (input.length > MAX_MARKETS) errors.push(`At most ${MAX_MARKETS} markets`);
  const base = baseCountry(config);
  const baseCur = baseCurrency(config);
  const seen = new Set();
  const prevById = new Map((Array.isArray(previous) ? previous : []).map((m) => [m?.id, m]));
  const value = [];
  input.slice(0, MAX_MARKETS).forEach((raw, i) => {
    const n = `Market ${i + 1}`;
    const countries = [...new Set((Array.isArray(raw?.countries) ? raw.countries : String(raw?.countries ?? "").split(/[\s,]+/)).map(up).filter(Boolean))];
    if (!countries.length) errors.push(`${n}: choose at least one country`);
    for (const c of countries) {
      if (!isRealCountry(c)) errors.push(`${n}: "${c}" isn't a country code`);
      else if (c === base) errors.push(`${n}: ${countryName(c)} is your store's own country`);
      else if (seen.has(c)) errors.push(`${n}: ${countryName(c)} is in two markets`);
      seen.add(c);
    }
    const currency = up(raw?.currency);
    if (!RAZORPAY_CURRENCIES.includes(currency) || currency === baseCur) errors.push(`${n}: choose a currency Razorpay can charge (${RAZORPAY_CURRENCIES.filter((c) => c !== baseCur).join(", ")})`);
    const rate = Number(raw?.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) errors.push(`${n}: the rate must be a number above 0`);
    const rounding = ROUNDING_RULES.includes(raw?.rounding) ? raw.rounding : null;
    if (!rounding) errors.push(`${n}: choose how prices round`);
    const money = (v, label, nullable) => {
      if (v == null || v === "") {
        if (!nullable) errors.push(`${n}: ${label} is required`);
        return null;
      }
      const x = Number(v);
      if (!Number.isFinite(x) || x < 0) {
        errors.push(`${n}: ${label} must be 0 or more`);
        return null;
      }
      return currency && RAZORPAY_CURRENCIES.includes(currency) ? roundMoney(x, currency) : x;
    };
    const flatRate = money(raw?.flatRate, "the shipping rate", false);
    const freeThreshold = money(raw?.freeThreshold, "the free-shipping amount", true);
    if (raw?.international !== true) errors.push(`${n}: tick "International payments are on in my Razorpay account"`);
    const id = countries[0] || `M${i + 1}`;
    const prev = prevById.get(raw?.id) || prevById.get(id);
    const rateSetAt = prev && Number(prev.rate) === rate && isIso(prev.rateSetAt) ? prev.rateSetAt : now.toISOString();
    value.push({ id, countries, currency, rate, rateSetAt, rounding, flatRate: flatRate ?? 0, freeThreshold, enabled: raw?.enabled === true, international: raw?.international === true });
  });
  const ids = value.map((m) => m.id);
  if (new Set(ids).size !== ids.length) errors.push("Two markets start with the same country");
  return { ok: errors.length === 0, errors, value };
}

// The audit's "rate changes listed": "US: 84.2 → 85" per changed market.
export function rateChanges(previous = [], next = []) {
  const before = new Map((previous || []).map((m) => [m.id, m]));
  const out = [];
  for (const m of next || []) {
    const p = before.get(m.id);
    if (!p) out.push(`${m.id}: added at ${m.rate}`);
    else if (Number(p.rate) !== Number(m.rate)) out.push(`${m.id}: ${p.rate} → ${m.rate}`);
  }
  for (const p of previous || []) if (!(next || []).some((m) => m.id === p.id)) out.push(`${p.id}: removed`);
  return out;
}

// A price × quantity in the market, in integer minor units (the cart line's own
// arithmetic, lib/cart.js), so a bundle page's line equals the cart's.
export function convertLine(price, quantity, market) {
  const q = Math.max(0, Number(quantity) || 0);
  if (!market) return Number(price) * q;
  return fromMinor(toMinor(convertPrice(price, market), market.currency) * q, market.currency);
}

// A bundle's three figures in the market: its set price (a price, so the
// rounding rule), its products' sum line by line, and the saving between them.
// No market → the bundle's own figures.
export function marketBundleFigures(bundle, market) {
  const comps = Array.isArray(bundle?.components) ? bundle.components : [];
  if (!market) return { price: Number(bundle?.bundle_price), sum: Number(bundle?.componentsSum), saving: Number(bundle?.saving), currency: bundle?.currency };
  const sumMinor = comps.reduce((s, c) => s + (c?.price == null ? 0 : toMinor(convertLine(c.price, Math.max(1, Number(c.quantity) || 1), market), market.currency)), 0);
  const price = convertPrice(Number(bundle?.bundle_price), market);
  const sum = fromMinor(sumMinor, market.currency);
  return { price, sum, saving: Math.max(0, fromMinor(sumMinor - toMinor(price, market.currency), market.currency)), currency: market.currency };
}

// The Ship to picker's `return` (app/api/market/route.js). Review fix: browsers strip tabs and newlines from a URL and read a backslash
// as a slash, so "/\t/evil.example" lands on evil.example. A value with any
// control character, whitespace other than a space, or a backslash is refused;
// the rest is resolved against a dummy origin and kept only when it stays on
// that origin, and only its path, query and hash are sent back.
const DUMMY = "https://return.invalid";
export function safeReturnPath(v) {
  if (typeof v !== "string" || !v.startsWith("/") || v.length > 500) return "/";
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(v)) return "/";
  let u;
  try {
    u = new URL(v, DUMMY);
  } catch {
    return "/";
  }
  if (u.origin !== DUMMY) return "/";
  const out = `${u.pathname}${u.search}${u.hash}`;
  return out.startsWith("/") && !out.startsWith("//") ? out : "/";
}
