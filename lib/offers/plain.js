// Offers in plain words (COM-03). ONE source for everything a founder reads
// about an offer: the sentence ("Buy 2 of Serum, get 1 free"), the default
// title shoppers see, the simulator's example carts built from the store's
// own products, the form-level warnings and the plain form of validation
// errors. The sentence and the examples are both built from `offerTerms`, so
// they cannot drift apart; scripts/test-offer-form.js runs the real engine on
// the examples of many generated offers and checks every one against the
// sentence.
//
// Pure: no database, no node: APIs. The console form imports it in the
// browser; lib/offers/simulate.js runs it on the server. Money always goes
// through formatMoney with the store's currency, never a hard-coded sign.
// Validation (validate.js) and pricing (engine.js) are NOT changed by this
// file: it only describes what they already do.
import { formatMoney } from "../format.js";
// the engine's own matching rule, without the engine's built-in offer list
import { matchesTarget } from "./match.js";

// ---- names ------------------------------------------------------------------

// What the founder picks from, in their words. BUNDLE is written by the bundle
// editor, never by this form.
export const OFFER_KINDS = [
  { type: "BXGY", name: "Buy some, get some free", hint: "For example: buy 2, get 1 free." },
  { type: "TIERED_QTY", name: "Buy more, save more", hint: "A bigger discount for buying more of the same thing." },
  { type: "FREE_GIFT", name: "Free gift over a spend", hint: "A free item once the cart is over an amount." },
  { type: "COUPON", name: "Discount code", hint: "Shoppers type a code at checkout to save." },
];
export const OFFER_TYPE_NAMES = { ...Object.fromEntries(OFFER_KINDS.map((k) => [k.type, k.name])), BUNDLE: "Bundle" };

// The store's money, in the store's currency.
export const money = (amount, currency = "INR") => formatMoney(Number(amount) || 0, currency || "INR");

// The currency's own sign ("$", "AED" and so on), for labels such as "$ off".
export function currencySign(currency = "INR") {
  try {
    const part = new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR" }).formatToParts(1).find((p) => p.type === "currency");
    return part?.value || currency;
  } catch {
    return currency || "INR";
  }
}

const isWhole = (n) => Number.isInteger(n) && n >= 1;
const isAmount = (n) => Number.isFinite(n) && n > 0;
const pct = (n) => `${Number(n)}%`;

// The name of what an offer is for. `names` maps a product, variant or handle
// value to the catalog's current title (the server resolves it); the label
// saved with the pick is the fallback, then a neutral phrase.
export function targetName(target, names = {}) {
  if (!target || target.value == null || target.value === "") return null;
  const v = String(target.value);
  switch (target.kind) {
    case "productId":
    case "handle":
    case "variantId":
      return names?.[v] || target.label || "the chosen product";
    case "tag":
      return `“${v}”`;
    case "productType":
      return `“${v}”`;
    case "collection":
      return names?.[`collection:${v}`] || target.label || "the chosen collection";
    default:
      return null;
  }
}

// "of Serum" / "products tagged “glow”" — the words after a quantity.
function goods(target, names, count = 2) {
  const name = targetName(target, names);
  if (!name) return null;
  const noun = count === 1 ? "product" : "products";
  if (target.kind === "tag") return `${noun} tagged ${name}`;
  if (target.kind === "productType") return `${noun} of type ${name}`;
  if (target.kind === "collection") return `from ${name}`;
  return `of ${name}`;
}

// ---- terms: the one source ------------------------------------------------------

// The offer's rules, normalized. Everything below (sentence, title, examples,
// warnings) reads these. Null when the offer isn't complete enough to say.
export function offerTerms(offer) {
  if (!offer || typeof offer !== "object") return null;
  switch (offer.type) {
    case "BXGY": {
      const buy = Number(offer.buy);
      const free = Number(offer.free);
      if (!offer.target?.value || !isWhole(buy) || !isWhole(free)) return null;
      return { type: "BXGY", target: offer.target, buy, free };
    }
    case "TIERED_QTY": {
      if (!offer.target?.value || !Array.isArray(offer.tiers) || !offer.tiers.length) return null;
      // The engine takes, for a quantity, the tier with the highest minimum at
      // or below it. Between tiers with the same minimum, the first listed wins
      // (a stable sort), so later duplicates never apply and aren't described.
      const seen = new Set();
      const tiers = [];
      for (const tier of offer.tiers) {
        const minQty = Number(tier?.minQty);
        const percent = Number(tier?.percent);
        if (!isWhole(minQty) || !isAmount(percent)) return null;
        if (seen.has(minQty)) continue;
        seen.add(minQty);
        tiers.push({ minQty, percent });
      }
      tiers.sort((a, b) => a.minQty - b.minQty);
      return { type: "TIERED_QTY", target: offer.target, tiers };
    }
    case "FREE_GIFT": {
      const threshold = Number(offer.threshold);
      if (!isAmount(threshold) || !offer.gift?.variantId) return null;
      return {
        type: "FREE_GIFT",
        threshold,
        gift: { variantId: offer.gift.variantId, title: offer.gift.title || "a free gift", value: Number(offer.gift.value) || 0 },
      };
    }
    case "COUPON": {
      const value = Number(offer.discount?.value);
      const kind = offer.discount?.kind;
      if (!offer.code || !["percent", "fixed"].includes(kind) || !isAmount(value)) return null;
      const min = Number(offer.minSubtotal);
      return {
        type: "COUPON",
        code: String(offer.code).toUpperCase(),
        kind,
        value,
        minSubtotal: Number.isFinite(min) && min > 0 ? min : 0,
        exclusive: offer.combinable === false,
      };
    }
    default:
      return null;
  }
}

// ---- the sentence ---------------------------------------------------------------

// "Buy 2 of Serum, get 1 free". Null when the offer isn't complete.
export function offerSentence(offer, { names = {}, currency = "INR" } = {}) {
  const t = offerTerms(offer);
  if (!t) return null;
  switch (t.type) {
    case "BXGY":
      return `Buy ${t.buy} ${goods(t.target, names, t.buy)}, get ${t.free} free`;
    case "TIERED_QTY":
      return t.tiers
        .map((tier, i) =>
          i === 0
            ? t.target.kind === "collection"
              ? `Buy ${tier.minQty}+ ${goods(t.target, names)}, get ${pct(tier.percent)} off`
              : `Buy ${tier.minQty} or more ${goods(t.target, names)}, get ${pct(tier.percent)} off`
            : t.target.kind === "collection"
              ? `${tier.minQty}+, ${pct(tier.percent)} off`
              : `${tier.minQty} or more, ${pct(tier.percent)} off`,
        )
        .join("; ");
    case "FREE_GIFT":
      return `Spend more than ${money(t.threshold, currency)}, get ${t.gift.title} free`;
    case "COUPON": {
      const amount = t.kind === "percent" ? pct(t.value) : money(t.value, currency);
      const where = t.minSubtotal ? `orders of ${money(t.minSubtotal, currency)} or more` : "the order";
      return `Code ${t.code} takes ${amount} off ${where}${t.exclusive ? ". Using it turns off other offers on that order" : ""}`;
    }
    default:
      return null;
  }
}

// The fine print, in the same plain words: how the engine settles the cases
// the sentence leaves open.
export function offerDetails(offer) {
  const t = offerTerms(offer);
  if (!t) return [];
  switch (t.type) {
    case "BXGY":
      return [
        `Shoppers add all ${t.buy + t.free} to the cart. When they cost different amounts, the cheapest are the free ones.`,
        "An item already in another offer isn't counted again.",
      ];
    case "TIERED_QTY":
      return ["The discount covers every matching item in the cart.", "An item already in another offer isn't counted again."];
    case "FREE_GIFT":
      return ["The cart total is counted before any discounts.", "The gift is added to the order at no charge."];
    case "COUPON":
      return t.exclusive
        ? ["The code takes its discount off the whole cart, and the shopper's other offers don't apply."]
        : ["If other offers apply first, the code takes its discount off what is left."];
    default:
      return [];
  }
}

// What shoppers see in the cart when the founder leaves the title blank. A
// tag or a product type is the store's own filing (it can be internal, like
// "clearance-hidden"), so the default never shows one to shoppers; the
// founder's sentence still names it. A collection is public, but its default
// is shown on its own page (CollectionOfferNote), so it names none either
// ("Buy 2+, save more"); the stale-name check compares its title.
const byGroup = (target) => target.kind === "tag" || target.kind === "productType" || target.kind === "collection";
export function defaultOfferTitle(offer, { names = {}, currency = "INR" } = {}) {
  const t = offerTerms(offer);
  if (!t) return "";
  let title = "";
  switch (t.type) {
    case "BXGY":
      title = byGroup(t.target) ? `Buy ${t.buy}, get ${t.free} free` : offerSentence(offer, { names, currency });
      break;
    case "TIERED_QTY":
      // the engine adds " · 10% off" to this in the cart, so it names no number
      // a collection's default is shown on its own page (CollectionOfferNote), so it needs no name
      title = t.target.kind === "collection" ? `Buy ${t.tiers[0].minQty}+, save more` : byGroup(t.target) ? "Buy more, save more" : `Buy more ${targetName(t.target, names)}, save more`;
      break;
    case "FREE_GIFT":
      title = `Free ${t.gift.title} on orders over ${money(t.threshold, currency)}`;
      break;
    case "COUPON":
      title = `${t.code} · ${t.kind === "percent" ? pct(t.value) : money(t.value, currency)} off`;
      break;
  }
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

// The numbers a shopper reads in a name: "2", "$2,000" (2000), "10%" (10).
// Digits stuck to letters (SAVE10, SPF50) are part of a word, not a number.
const numbersIn = (text) => new Set([...String(text || "").matchAll(/(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*/gu)].map((m) => Number(m[0].replace(/,/g, ""))));

// Each rule's own numbers and names, by place, so a change is seen even when
// the old number is still used elsewhere (buy 2 get 2 → buy 2 get 1).
function ruleParts(t, names) {
  const what = (target) => (byGroup(target) && target.kind !== "collection" ? String(target.value) : targetName(target, names));
  switch (t.type) {
    case "BXGY":
      return { buy: t.buy, free: t.free, what: what(t.target) };
    case "TIERED_QTY":
      return { what: what(t.target), ...Object.fromEntries(t.tiers.flatMap((x, i) => [[`min${i}`, x.minQty], [`off${i}`, x.percent]])) };
    case "FREE_GIFT":
      return { threshold: t.threshold, gift: t.gift.title };
    case "COUPON":
      return { code: t.code, value: t.value, min: t.minSubtotal || null };
    default:
      return {};
  }
}

// A name the founder typed can still describe the rules they just changed
// ("Buy 2 get 1 free" after changing it to get 2). The form flags a typed
// name that mentions a number, product, gift or code the edit just changed.
// It is a check, not a block: the number may mean something else. A blank
// name needs no flag: it is rebuilt from the new rules.
export function staleNameWarning(name, before, after, { names = {}, currency = "INR" } = {}) {
  const typed = String(name || "").trim();
  const was = offerTerms(before);
  const now = offerTerms(after);
  if (!typed || !was || !now) return null;
  const oldParts = ruleParts(was, names);
  const newParts = ruleParts(now, names);
  const changed = Object.keys(oldParts).filter((k) => oldParts[k] != null && oldParts[k] !== newParts[k]).map((k) => oldParts[k]);
  const numbers = numbersIn(typed);
  const lower = typed.toLowerCase();
  const mentions = changed.some((v) => (typeof v === "number" ? numbers.has(v) : String(v).length >= 3 && lower.includes(String(v).toLowerCase())));
  if (!mentions) return null;
  return `The name shoppers see in the cart, “${typed}”, mentions something you just changed. Check it still matches, or clear it to use “${defaultOfferTitle(after, { names, currency })}”.`;
}

// A code a founder can keep without typing one: SAVE10, or FLAT200.
export function suggestCode(kind, value) {
  const n = Number(value);
  if (!isAmount(n)) return "";
  const digits = String(Math.round(n));
  return (kind === "fixed" ? `FLAT${digits}` : `SAVE${digits}`).slice(0, 20);
}

// ---- the simulator's examples ---------------------------------------------------

// A catalog entry is an engine cart line without a quantity:
//   { variantId, productId, handle, title, productType, tags, price }
const usable = (i) => i && i.variantId && Number.isFinite(Number(i.price)) && Number(i.price) > 0;
const subtotalOf = (lines) => lines.reduce((s, i) => s + i.price * i.quantity, 0);
const line = (item, quantity) => ({ ...item, price: Number(item.price), tags: Array.isArray(item.tags) ? item.tags : [], quantity });
const itemName = (i) => (i.variantTitle && !/^default( title)?$/i.test(i.variantTitle) ? `${i.title} — ${i.variantTitle}` : i.title);

export const NO_MATCH = "Nothing in your store matches this offer yet, so there is no example to show.";
export const NO_PRODUCTS = "Your store has no products with a price yet, so there is no example to show.";

// Example carts made from the store's own products, each with what the
// sentence promises for it (`expect`) and the founder-facing line (`text`).
//   example   — a cart that gets the offer
//   nearMiss  — the closest cart that doesn't (null when every cart does)
//   steps     — Buy more, save more: one cart per step
//   missing   — why there is no example, in plain words
export function offerExamples(offer, catalog, { currency = "INR" } = {}) {
  const t = offerTerms(offer);
  if (!t) return { terms: null, example: null, nearMiss: null, steps: [], missing: "Finish the offer to see an example." };
  const items = (catalog || []).filter(usable).map((i) => ({ ...i, price: Number(i.price) }));
  const m = (n) => money(n, currency);
  const none = (missing) => ({ terms: t, example: null, nearMiss: null, steps: [], missing });

  if (t.type === "BXGY" || t.type === "TIERED_QTY") {
    const pool = items.filter((i) => matchesTarget({ ...i, tags: Array.isArray(i.tags) ? i.tags : [] }, t.target));
    if (!pool.length) return none(NO_MATCH);
    // The engine rounds discounts to whole units of money, so a tiny price
    // can round a discount away; show a product where it doesn't, if any.
    const freeOf = (i, units) => Math.round(Array.from({ length: units }, () => i.price).reduce((s, x) => s + x, 0));
    const tierOff = (i, tier) => Math.round((i.price * tier.minQty * tier.percent) / 100);
    const p = (t.type === "BXGY" ? pool.find((i) => freeOf(i, t.free) > 0) : pool.find((i) => tierOff(i, t.tiers[0]) > 0)) || pool[0];
    const name = itemName(p);
    if (t.type === "BXGY") {
      const qty = t.buy + t.free;
      const lines = [line(p, qty)];
      const sub = subtotalOf(lines);
      const discount = freeOf(p, t.free); // the free ones, added up as the cart does
      const example = {
        lines,
        coupon: null,
        subtotal: sub,
        expect: { applies: discount > 0, discount, gift: null },
        text: `${qty} × ${name} (${m(p.price)} each): the shopper pays ${m(sub - discount)} instead of ${m(sub)}. ${t.free} ${t.free === 1 ? "is" : "are"} free.`,
      };
      const nq = qty - 1;
      const nearMiss = {
        lines: [line(p, nq)],
        coupon: null,
        subtotal: subtotalOf([line(p, nq)]),
        expect: { applies: false, discount: 0, gift: null },
        text: `${nq} × ${name}: nothing is free yet. The shopper needs ${qty} in the cart.`,
      };
      return { terms: t, example, nearMiss, steps: [example], missing: null };
    }
    const steps = t.tiers.map((tier) => {
      const lines = [line(p, tier.minQty)];
      const sub = subtotalOf(lines);
      const discount = tierOff(p, tier);
      return {
        lines,
        coupon: null,
        subtotal: sub,
        expect: { applies: discount > 0, discount, gift: null },
        text: discount
          ? `${tier.minQty} × ${name}: ${pct(tier.percent)} off, so ${m(discount)} saved. The shopper pays ${m(sub - discount)}.`
          : `${tier.minQty} × ${name}: ${pct(tier.percent)} off rounds to nothing on a cart this small.`,
      };
    });
    const first = t.tiers[0].minQty;
    const nearMiss =
      first > 1
        ? {
            lines: [line(p, first - 1)],
            coupon: null,
            subtotal: subtotalOf([line(p, first - 1)]),
            expect: { applies: false, discount: 0, gift: null },
            text: `${first - 1} × ${name}: no discount yet. The shopper needs ${first}.`,
          }
        : null;
    return { terms: t, example: steps[0], nearMiss, steps, missing: null };
  }

  // FREE_GIFT and COUPON need any of the store's products. The catalog comes
  // cheapest first; the gift itself is never the thing being bought.
  const pool = t.type === "FREE_GIFT" ? items.filter((i) => i.variantId !== t.gift.variantId) : items;
  if (!pool.length) return none(NO_PRODUCTS);
  const pick = (need) => {
    // the cheapest product that reaches `need` in 10 or fewer, else the dearest
    const fits = pool.find((i) => Math.max(1, Math.ceil(need / i.price)) <= 10);
    return fits || pool[pool.length - 1];
  };

  if (t.type === "FREE_GIFT") {
    const p = pick(t.threshold);
    const name = itemName(p);
    const qty = Math.floor(t.threshold / p.price) + 1;
    const lines = [line(p, qty)];
    const sub = subtotalOf(lines);
    const example = {
      lines,
      coupon: null,
      subtotal: sub,
      expect: { applies: sub > t.threshold, discount: 0, gift: sub > t.threshold ? t.gift.variantId : null },
      text: `${qty} × ${name} (cart ${m(sub)}): ${t.gift.title} is added free.`,
    };
    const nq = qty - 1;
    const nearMiss =
      nq >= 1
        ? {
            lines: [line(p, nq)],
            coupon: null,
            subtotal: subtotalOf([line(p, nq)]),
            expect: { applies: false, discount: 0, gift: null },
            text: `${nq} × ${name} (cart ${m(subtotalOf([line(p, nq)]))}): no gift. The cart must be over ${m(t.threshold)}.`,
          }
        : null;
    return { terms: t, example, nearMiss, steps: [example], missing: null };
  }

  // COUPON: a cart that meets the minimum. A fixed amount gets a cart of at
  // least twice that amount, so the example isn't the capped case; a percent
  // gets one big enough that the discount doesn't round to nothing.
  const need = Math.max(t.minSubtotal, t.kind === "fixed" ? 2 * t.value : 60 / t.value);
  const p = pick(need);
  const name = itemName(p);
  const qty = Math.max(1, Math.ceil(need / p.price));
  const lines = [line(p, qty)];
  const sub = subtotalOf(lines);
  const valid = !(t.minSubtotal && sub < t.minSubtotal);
  const discount = !valid ? 0 : t.kind === "percent" ? Math.round((sub * t.value) / 100) : Math.min(t.value, sub);
  const example = {
    lines,
    coupon: t.code,
    subtotal: sub,
    expect: { applies: valid && discount > 0, discount, gift: null, couponValid: valid },
    text: `${qty} × ${name} (cart ${m(sub)}) with code ${t.code}: ${m(discount)} off, so the shopper pays ${m(sub - discount)}.`,
  };
  let nearMiss = null;
  if (t.minSubtotal) {
    const nq = Math.ceil(t.minSubtotal / p.price) - 1;
    if (nq >= 1) {
      const nl = [line(p, nq)];
      nearMiss = {
        lines: nl,
        coupon: t.code,
        subtotal: subtotalOf(nl),
        expect: { applies: false, discount: 0, gift: null, couponValid: false },
        text: `${nq} × ${name} (cart ${m(subtotalOf(nl))}): the code doesn't work yet. Orders must be ${m(t.minSubtotal)} or more.`,
      };
    }
  }
  return { terms: t, example, nearMiss, steps: [example], missing: null };
}

// Does the engine's result on an example cart match what the sentence says?
export function checkExample(example, result) {
  const gotGift = (result.gifts || []).map((g) => g.variantId)[0] || null;
  const differences = [];
  if (result.discountTotal !== example.expect.discount) differences.push(`discount ${result.discountTotal}, expected ${example.expect.discount}`);
  if (gotGift !== (example.expect.gift || null)) differences.push(`gift ${gotGift}, expected ${example.expect.gift}`);
  if ("couponValid" in example.expect && Boolean(result.couponStatus?.valid) !== example.expect.couponValid)
    differences.push(`code accepted ${Boolean(result.couponStatus?.valid)}, expected ${example.expect.couponValid}`);
  return { agrees: differences.length === 0, differences };
}

// ---- warnings (form level; the validator is unchanged) ------------------------------

// A free item worth more than this, in the store's currency, gets a warning.
// One value per currency, set to roughly the same real amount. A currency not
// listed gets only the "more than half off" checks. Change the numbers here.
export const FREE_ITEM_WARN_AT = { INR: 2000, USD: 25, EUR: 25, GBP: 20, AED: 90, SGD: 30, AUD: 40, CAD: 35 };
export const freeItemWarnAt = (currency = "INR") => FREE_ITEM_WARN_AT[String(currency || "INR").toUpperCase()] ?? null;

// `freeItemValue`: for Buy some, get some free, the price of the dearest
// product the offer covers (what a free one can be worth at most).
export function offerWarnings(offer, { currency = "INR", freeItemValue = null } = {}) {
  const t = offerTerms(offer);
  if (!t) return [];
  const m = (n) => money(n, currency);
  const cap = freeItemWarnAt(currency);
  const out = [];
  switch (t.type) {
    case "BXGY":
      if (t.free / (t.buy + t.free) > 0.5) out.push(`For every ${t.buy} bought, ${t.free} are free. That's more than half off.`);
      if (cap != null && Number(freeItemValue) > cap) out.push(`A free item here can be worth ${m(freeItemValue)}, which is more than ${m(cap)}.`);
      break;
    case "TIERED_QTY":
      for (const tier of t.tiers) if (tier.percent > 50) out.push(`Buying ${tier.minQty} or more takes ${pct(tier.percent)} off. That's more than half off.`);
      break;
    case "FREE_GIFT":
      if (cap != null && t.gift.value > cap) out.push(`The free gift is worth ${m(t.gift.value)}, which is more than ${m(cap)}.`);
      if (t.gift.value > t.threshold) out.push(`The free gift is worth more than the ${m(t.threshold)} a shopper must spend to get it. That's more than half off.`);
      break;
    case "COUPON":
      if (t.kind === "percent" && t.value > 50) out.push(`Code ${t.code} takes ${pct(t.value)} off. That's more than half off.`);
      if (t.kind === "fixed" && !(t.minSubtotal >= 2 * t.value))
        out.push(`Code ${t.code} takes ${m(t.value)} off. On orders under ${m(2 * t.value)}, that's more than half off.`);
      break;
  }
  return out;
}

// ---- validation messages in plain words ---------------------------------------------

// validate.js stays exactly as it is (its messages are for developers and
// name a currency sign). The form shows these instead.
export function plainError(message, { currency = "INR" } = {}) {
  const msg = String(message || "");
  const tier = /^tiers\[(\d+)\]\.(minQty|percent)/.exec(msg);
  if (tier) {
    const n = Number(tier[1]) + 1;
    return tier[2] === "minQty" ? `Step ${n}: the number to buy must be a whole number, 1 or more.` : `Step ${n}: the discount must be more than 0% and at most 90%.`;
  }
  const rules = [
    [/^id:/, "Something went wrong naming this offer. Close it and start again."],
    [/^type:/, "Choose what kind of offer this is."],
    [/^title:/, "Give the offer a name shoppers will see, at least 3 characters long."],
    [/^priority:/, "Something went wrong with this offer's order. Close it and start again."],
    [/^target\.value: no such collection/, "That collection isn't in your store any more. Choose another."],
    [/^target\./, "Choose which products this offer is for."],
    [/^buy:/, "The number to buy must be a whole number, 1 or more."],
    [/^free:/, "The number free must be a whole number, 1 or more."],
    [/^tiers:/, "Add at least one step."],
    [/^threshold:/, `Enter the amount a cart must be over, more than ${money(0, currency)}.`],
    [/^gift\.variantId/, "Choose the free gift from your products. It has to be a product from your Shopify catalog."],
    [/^gift\.title/, "Choose the free gift from your products. It has to be a product from your Shopify catalog."],
    [/^code:/, "The code must be 3 to 20 letters or numbers, with no spaces."],
    [/^discount\.kind/, "Choose a percent off or an amount off."],
    [/^discount\.value: percent capped/, "A percent off can be at most 90%."],
    [/^discount\.value/, "Enter a discount bigger than 0."],
    [/^minSubtotal:/, "The minimum order can't be below 0."],
    [/^combinable:/, "Choose whether the code works with other offers."],
    [/^Schedule: start must be before end/, "The end must be after the start."],
    [/^Schedule: (start|end) is not a date/, "Enter the start and end as a date and a time."],
    [/scope must be/, "Something went wrong with this offer's type. Close it and start again."],
    [/^Offer id cannot change/, "This offer can't be changed into a different one. Make a new offer instead."],
  ];
  for (const [re, text] of rules) if (re.test(msg)) return text;
  return msg;
}

export const plainErrors = (messages, opts) => [...new Set((messages || []).map((m) => plainError(m, opts)))];
