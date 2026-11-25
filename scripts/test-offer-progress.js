// Phase 7 line 3: the cart drawer's offer nudges (lib/offers/progress.js).
// Pure, no DB. What it proves:
//   1. a property over 500 random carts: doing what any shown nudge asks makes
//      the engine really apply it (the gift is given, the tier's percent lands
//      on that line, the coupon becomes valid, shipping becomes free);
//   2. the engine's edges: a gift needs strictly over its threshold; a line a
//      higher-priority offer claims gets no tier nudge; an exclusive coupon
//      suppresses gift and tier nudges; inactive offers (not passed) never show;
//   3. the words: offer and gift titles and the cart's currency, never an
//      offer's target value; at most two nudges.
//   node scripts/test-offer-progress.js
import { evaluateOffers } from "../lib/offers/engine.js";
import { computeShipping, SHIPPING_CONFIG } from "../lib/shipping.js";
import { offerProgress } from "../lib/offers/progress.js";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log("✓ " + name);
  } else {
    fail++;
    console.log("✗ " + name + (detail ? "  — " + JSON.stringify(detail).slice(0, 600) : ""));
  }
};

const line = (id, price, quantity = 1, extra = {}) => ({ variantId: `v-${id}`, productId: `p-${id}`, handle: `h-${id}`, tags: [], productType: null, price, quantity, currency: "INR", ...extra });
const TIER = { id: "tier-whey", type: "TIERED_QTY", scope: "line", priority: 30, title: "Whey Tiers", target: { kind: "tag", value: "secret-whey-tag" }, tiers: [{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }] };
const GIFT = { id: "gift-shaker", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Shaker gift", threshold: 999, gift: { variantId: "v-gift", title: "Shaker", value: 315 } };
const SAVE10 = { id: "c-save10", type: "COUPON", scope: "order", priority: 50, code: "SAVE10", title: "SAVE10", discount: { kind: "percent", value: 10 }, minSubtotal: 1200, combinable: true };
const SOLO = { id: "c-solo", type: "COUPON", scope: "order", priority: 50, code: "SOLO", title: "SOLO", discount: { kind: "percent", value: 25 }, combinable: false };
const BXGY = { id: "bxgy-a", type: "BXGY", scope: "line", priority: 10, title: "B2G1", target: { kind: "tag", value: "secret-whey-tag" }, buy: 2, free: 1 };
const RATES = { ...SHIPPING_CONFIG, freeThreshold: 999, flatRate: 79 };
const WHEY = { tags: ["secret-whey-tag"] };

// ---- 2. the edges ---------------------------------------------------------------------
{
  const p = offerProgress([line("a", 698)], { offers: [GIFT] });
  check("gift: ₹698 → 'Add ₹302 more for a free Shaker' (strictly over ₹999 needs ₹1,000)", p.nudges[0]?.text === "Add ₹302 more for a free Shaker", p);
  const at = offerProgress([line("a", 999)], { offers: [GIFT] });
  check("gift: exactly at the threshold is not over it: add ₹1", at.nudges[0]?.remaining === 1 && evaluateOffers([line("a", 999)], { offers: [GIFT] }).gifts.length === 0, at);
  const over = offerProgress([line("a", 1000)], { offers: [GIFT] });
  check("gift: over the threshold → no nudge, 'Free Shaker' unlocked", over.nudges.length === 0 && over.unlocked.some((u) => u.label === "Free Shaker"), over);
  const fracs = offerProgress([line("a", 998.5)], { offers: [GIFT] });
  check("gift: ₹998.50 → add ₹1 (the smallest whole amount that crosses)", fracs.nudges[0]?.remaining === 1, fracs);
}
{
  const p = offerProgress([line("a", 400, 1, WHEY)], { offers: [TIER] });
  const n = p.nudges.find((x) => x.kind === "tier");
  check("tier: 1 in the cart → 'Add 1 more for 10% off · Whey Tiers' on that line", n?.text === "Add 1 more for 10% off · Whey Tiers" && n.variantId === "v-a" && n.add === 1, p);
  const two = offerProgress([line("a", 400, 2, WHEY)], { offers: [TIER] }).nudges.find((x) => x.kind === "tier");
  check("tier: 2 in the cart → the next tier, 15%", two?.text === "Add 1 more for 15% off · Whey Tiers", two);
  const top = offerProgress([line("a", 400, 3, WHEY)], { offers: [TIER] }).nudges.find((x) => x.kind === "tier");
  check("tier: on the top tier → no tier nudge", !top);
  const claimed = offerProgress([line("a", 400, 2, WHEY)], { offers: [BXGY, TIER] }).nudges.find((x) => x.kind === "tier");
  check("tier: a line a higher-priority offer claims (B2G1 at 3) → no tier nudge", !claimed, claimed);
  const none = offerProgress([line("a", 400, 1)], { offers: [TIER] }).nudges.find((x) => x.kind === "tier");
  check("tier: no matching line → no nudge", !none);
}
{
  const items = [line("a", 600, 1, WHEY)];
  const p = offerProgress(items, { offers: [TIER, GIFT, SOLO], coupon: "SOLO" });
  check("exclusive coupon: suppresses the gift and tier nudges and unlocks", p.nudges.length === 0 && p.unlocked.length === 0, p);
  const ship = offerProgress(items, { offers: [GIFT, SOLO], coupon: "SOLO", shippingConfig: RATES });
  const s = ship.nudges[0];
  check("exclusive coupon: free shipping is still nudged, on the net amount (25% off what is added)", s?.id === "shipping" && computeShipping({ ...evalSpend(items, s.remaining, [GIFT, SOLO], "SOLO"), config: RATES }).free && !computeShipping({ ...evalSpend(items, s.remaining - 1, [GIFT, SOLO], "SOLO"), config: RATES }).free, ship);
}
{
  const p = offerProgress([line("a", 1000)], { offers: [SAVE10], coupon: "SAVE10" });
  check("coupon minimum: 'Add ₹200 more to use SAVE10'", p.nudges[0]?.text === "Add ₹200 more to use SAVE10", p);
  const notEntered = offerProgress([line("a", 1000)], { offers: [SAVE10] });
  check("coupon: a code the shopper didn't enter is never named", notEntered.nudges.length === 0, notEntered);
  const inactive = offerProgress([line("a", 400, 1, WHEY)], { offers: [] });
  check("inactive offers (not in the active list) never show", inactive.nudges.length === 0 && inactive.unlocked.length === 0, inactive);
  check("an empty cart has no nudges", offerProgress([], { offers: [GIFT, TIER], shippingConfig: RATES }).nudges.length === 0);
  const noRates = offerProgress([line("a", 100)], { offers: [], shippingConfig: null });
  check("no chosen rates → no free-shipping promise", noRates.nudges.length === 0, noRates);
}
{
  const p = offerProgress([line("a", 400, 1, WHEY)], { offers: [TIER, GIFT, SAVE10], coupon: "SAVE10", shippingConfig: RATES });
  check("at most two nudges: spend first, then the tier", p.nudges.length === 2 && p.nudges[0].kind === "spend" && p.nudges[1].kind === "tier", p.nudges.map((n) => n.kind));
  const spend = p.nudges[0];
  check("spend: the nearest goal's words, a bar and a milestone for each goal", spend.milestones.length === 2 && spend.percent > 0 && spend.percent < 100 && spend.milestones.every((m) => m.position > spend.percent && m.position <= 100), spend);
  const usd = offerProgress([{ ...line("a", 40), currency: "USD" }], { offers: [{ ...GIFT, threshold: 50 }] });
  check("currency: the cart's own ('Add $11 more…')", usd.nudges[0]?.text === "Add $11 more for a free Shaker", usd);
}
{
  // the drill's own shape on the net basis: the shipping nudge must survive adding the discounted product itself
  const items = [line("a", 500, 1, WHEY)];
  const p = offerProgress(items, { offers: [TIER], shippingConfig: RATES });
  const s = p.nudges.find((n) => n.kind === "spend");
  const asTee = evaluateOffers([...items, { ...items[0], variantId: "v-a2", price: s?.remaining ?? 0 }], { offers: [TIER] });
  check("net shipping: adding the tier's own product for the nudged amount really makes shipping free", s?.id === "shipping" && computeShipping({ subtotal: asTee.subtotal, discountTotal: asTee.discountTotal, config: RATES }).free, p);
  const tiered = evaluateOffers([line("a", 500, 2, WHEY), line("x", s?.remaining ?? 0)], { offers: [TIER] });
  check("net shipping: and after doing the tier nudge too", computeShipping({ subtotal: tiered.subtotal, discountTotal: tiered.discountTotal, config: RATES }).free, tiered);
  const zoned = offerProgress([line("a", 500)], { offers: [], shippingConfig: { ...RATES, zones: [{ prefixes: ["19"], label: "Remote", freeThreshold: 1999 }] } });
  check("pincode zones with their own free-shipping amount: no shipping promise", zoned.nudges.length === 0 && zoned.unlocked.length === 0, zoned);
  const flatZone = offerProgress([line("a", 500)], { offers: [], shippingConfig: { ...RATES, zones: [{ prefixes: ["19"], label: "Remote", flatRate: 149 }] } });
  check("a zone that only changes the rate keeps the promise", flatZone.nudges[0]?.id === "shipping", flatZone);
}
{
  // SOLO: exclusive, and here using it would cost more than the gift and the 30% tier it switches off
  const G = { ...GIFT, threshold: 500 };
  const SOLO10 = { ...SOLO, discount: { kind: "fixed", value: 10 }, minSubtotal: 1500 };
  const T30 = { ...TIER, tiers: [{ minQty: 2, percent: 30 }] };
  const p = offerProgress([line("a", 600, 2, WHEY)], { offers: [G, SOLO10, T30], coupon: "SOLO" });
  check("coupon: no 'Add ₹300 more to use SOLO' when the code would raise the total", !p.nudges.some((n) => n.kind === "coupon"), p);
  const worth = offerProgress([line("a", 1000)], { offers: [{ ...SOLO, minSubtotal: 1500 }], coupon: "SOLO" });
  check("coupon: an exclusive code that does lower the total is still nudged", worth.nudges[0]?.text === "Add ₹500 more to use SOLO", worth);
  const cents = offerProgress([{ ...line("a", 49.99), currency: "USD" }], { offers: [{ ...GIFT, threshold: 50 }], shippingConfig: { ...RATES, freeThreshold: 75.5 } });
  check("USD with cents: $49.99 → 'Add $1 more' for a gift over $50; shipping at $75.50 → $26", cents.nudges[0]?.text === "Add $1 more for a free Shaker" && cents.nudges[0].milestones.at(-1)?.id === "shipping" && evalSpendFree([{ ...line("a", 49.99), currency: "USD" }], 26, 75.5) && !evalSpendFree([{ ...line("a", 49.99), currency: "USD" }], 25, 75.5), cents);
}
function evalSpendFree(items, amount, threshold) {
  const r = evaluateOffers([...items, line("x", amount)], { offers: [] });
  return computeShipping({ subtotal: r.subtotal, discountTotal: r.discountTotal, config: { ...RATES, freeThreshold: threshold } }).free;
}
function evalSpend(items, amount, offers, coupon) {
  const r = evaluateOffers([...items, line("x", amount)], { offers, coupon });
  return { subtotal: r.subtotal, discountTotal: r.discountTotal };
}

// ---- 1. property: 500 random carts --------------------------------------------------------
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const TAGS = ["t-a", "t-b", "t-c"];
const broken = [];
let shown = 0;
const targetValues = new Set();
for (let n = 0; n < 500; n++) {
  // a third of the carts are in dollars with cents
  const usd = rnd() < 0.33;
  const price = () => (usd ? int(100, 12000) / 100 : int(1, 120) * 10 + (rnd() < 0.1 ? 0.5 : 0));
  const items = Array.from({ length: int(1, 4) }, (_, i) => line(`${n}-${i}`, price(), int(1, 3), { tags: rnd() < 0.7 ? [pick(TAGS)] : [], ...(usd ? { currency: "USD" } : {}) }));
  const offers = [];
  for (let k = int(0, 2); k > 0; k--) {
    const tag = pick(TAGS);
    targetValues.add(tag);
    offers.push({ id: `tier-${n}-${k}`, type: "TIERED_QTY", scope: "line", priority: int(1, 60), title: `Tier offer ${k}`, target: { kind: "tag", value: tag }, tiers: [{ minQty: int(2, 3), percent: int(5, 15) }, { minQty: int(4, 6), percent: int(16, 30) }] });
  }
  if (items.length > 1 && rnd() < 0.4) {
    const sum = items[0].price + items[1].price;
    offers.push({ id: `bundle-${n}`, type: "BUNDLE", scope: "line", priority: int(1, 60), title: "Bundle", items: [{ variantId: items[0].variantId, quantity: 1 }, { variantId: items[1].variantId, quantity: 1 }], price: Math.round(sum * 0.8) });
  }
  if (rnd() < 0.4) offers.push({ id: `bxgy-${n}`, type: "BXGY", scope: "line", priority: int(1, 60), title: "B2G1", target: { kind: "tag", value: pick(TAGS) }, buy: 2, free: 1 });
  for (let k = int(0, 2); k > 0; k--) offers.push({ id: `gift-${n}-${k}`, type: "FREE_GIFT", scope: "gift", priority: int(1, 60), title: `Gift ${k}`, threshold: int(300, 3000) + (rnd() < 0.2 ? 0.5 : 0), gift: { variantId: `g-${k}`, title: `Gift item ${k}` } });
  const code = rnd() < 0.5 ? pick(["SAVE", "SOLO", "FLAT"]) : null;
  offers.push({ id: "c-save", type: "COUPON", scope: "order", priority: 50, code: "SAVE", title: "SAVE", discount: { kind: "percent", value: int(5, 30) }, minSubtotal: int(0, 2500), combinable: true });
  offers.push({ id: "c-solo", type: "COUPON", scope: "order", priority: 50, code: "SOLO", title: "SOLO", discount: { kind: "percent", value: 25 }, minSubtotal: int(0, 2500), combinable: false });
  offers.push({ id: "c-flat", type: "COUPON", scope: "order", priority: 50, code: "FLAT", title: "FLAT", discount: { kind: "fixed", value: 200 }, minSubtotal: int(500, 2500), combinable: true });
  const rates = rnd() < 0.6 ? { ...SHIPPING_CONFIG, basis: rnd() < 0.5 ? "net" : "gross", freeThreshold: int(400, 3000), flatRate: 79 } : null;
  const p = offerProgress(items, { offers, coupon: code, shippingConfig: rates });
  if (p.nudges.length > 2) broken.push({ n, why: "more than two", p });
  const text = JSON.stringify(p);
  for (const v of targetValues) if (text.includes(v)) broken.push({ n, why: `target value ${v} in the output` });
  // what "add ₹r more" may really be: a plain line, a line an offer discounts
  // (another unit like one already in the cart, under a new id), or a line of
  // a tag some offer targets; and, when a tier nudge shows, on top of doing it
  const tierNd = p.nudges.find((x) => x.kind === "tier");
  const bases = [items, ...(tierNd ? [items.map((i) => (i.variantId === tierNd.variantId ? { ...i, quantity: i.quantity + tierNd.add } : i))] : [])];
  const addsFor = (amount) =>
    bases.flatMap((base) => [
      [...base, line("added", amount, 1, { currency: base[0].currency })],
      [...base, { ...pick(base), variantId: "v-added-copy", price: amount, quantity: 1 }],
      [...base, line("added-tag", amount, 1, { currency: base[0].currency, tags: [pick(TAGS)] })],
    ]);
  for (const nd of p.nudges) {
    shown++;
    if (nd.kind === "tier") {
      const after = items.map((i) => (i.variantId === nd.variantId ? { ...i, quantity: i.quantity + nd.add } : i));
      const r = evaluateOffers(after, { offers, coupon: code });
      if (!r.appliedOffers.some((a) => a.id === nd.id) || !(r.lineDiscounts[nd.variantId] > 0)) broken.push({ n, nd, why: "tier not applied" });
      continue;
    }
    for (const after of addsFor(nd.remaining)) {
      const r = evaluateOffers(after, { offers, coupon: code });
      if (nd.kind === "coupon" && !(r.couponStatus?.valid && r.couponStatus.applied > 0)) broken.push({ n, nd, why: "coupon not valid" });
      if (nd.kind === "coupon" && !(r.total < evaluateOffers(after, { offers }).total)) broken.push({ n, nd, why: "the coupon doesn't lower the total" });
      if (nd.kind === "spend" && nd.id === "shipping" && !computeShipping({ subtotal: r.subtotal, discountTotal: r.discountTotal, config: rates }).free) broken.push({ n, nd, after: after.at(-1), why: "shipping not free" });
      if (nd.kind === "spend" && nd.id !== "shipping" && !r.gifts.some((g) => g.offerId === nd.id)) broken.push({ n, nd, why: "gift not given" });
    }
    if (nd.remaining <= 0 || !Number.isInteger(nd.remaining)) broken.push({ n, nd, why: "not a positive whole amount" });
  }
}
check(`property: over 500 random carts (bundles, BXGY, tiers, gifts, coupons; a third in USD with cents) every shown nudge (${shown}) really applies when done, whatever is added, no target value in the output`, broken.length === 0 && shown > 300, broken.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
