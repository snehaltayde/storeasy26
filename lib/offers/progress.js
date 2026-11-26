// Phase 7 line 3 (docs/plans/phase-7.md decisions 4, 9, 10): the cart drawer's
// offer nudges. Pure and Edge-safe. getCart (lib/cart.js) calls it on every
// cart read with the same lines, offers and coupon the engine just priced, so
// no request ever carries progress and checkout keeps recomputing on its own.
//
// Every nudge is proved before it is shown: the nudged cart (the cart plus the
// amount or quantity the nudge asks for) goes through evaluateOffers (and
// computeShipping for free shipping); a nudge the engine would not really
// apply is dropped. The copy names offer and gift titles and money amounts,
// never an offer's target (a tag, handle or type can be internal).
import { evaluateOffers, findCoupon, matchesTarget } from "./engine.js";
import { computeShipping } from "../shipping.js";
import { formatMoney } from "../format.js";

const MAX_NUDGES = 2;
const NUDGE_LINE = "__nudge__";
const MAX_STEPS = 8;

// smallest whole amount that makes `subtotal + r > threshold` (a gift needs strictly over)
const overBy = (threshold, subtotal) => Math.floor(threshold - subtotal) + 1;

// How a shopper really reaches "₹r more": whole units. A gift, a coupon's
// minimum and gross-basis shipping read only the subtotal, so any add worth r
// or more reaches them, unless it also makes the shopper's own exclusive code
// valid (that switches gifts off). So those are proved at r and at the amount
// where the entered code turns valid, with a plain line.
//
// Net-basis free shipping depends on what is added: units of a tiered, BXGY or
// bundle product can be discounted by more than any fixed step covers (more
// units cross a higher tier or free more units). No step is honest for every
// way to reach the amount, so on the net basis the drawer promises free
// shipping only when the store has no line offer at all. Then the net amount
// only grows with what is added (the coupon is the only discount), except where
// the entered code turns valid, and those two points are what is checked.

/**
 * @param {Array} items engine lines (with tags and productType; never returned)
 * @param {{ offers: Array, coupon?: string|null, result?: object, shippingConfig?: object|null }} opts
 *   result: evaluateOffers(items, { offers, coupon }) when the caller already has it;
 *   shippingConfig: the store's rates, or null when the store hasn't chosen rates (no shipping promise);
 *   giftTitles: Map variantId → the title an applied gift line shows (else the offer's stored gift title)
 * @returns {{ nudges: Array, unlocked: Array }}
 *   round: the engine's rounding for a market run (lib/offers/engine.js); absent for the base market
 */
export function offerProgress(items, { offers = [], coupon = null, result = null, shippingConfig = null, giftTitles = null, round = null } = {}) {
  const out = { nudges: [], unlocked: [] };
  if (!Array.isArray(items) || items.length === 0) return out;
  const currency = items[0]?.currency || "INR";
  const money = (n) => formatMoney(n, currency);
  const run = (lines) => evaluateOffers(lines, { offers, coupon, ...(round ? { round } : {}) });
  const now = result || run(items);
  const subtotal = now.subtotal;
  const plain = (base, amount) => [...base, { variantId: NUDGE_LINE, productId: null, handle: null, tags: [], productType: null, price: amount, quantity: 1, currency }];

  // the line offers, and which of them match a line (its match profile: lines
  // with the same profile behave alike, so a tier is proved once per profile)
  const lineOffers = offers.filter((o) => o.scope === "line");
  const profileOf = (i) =>
    lineOffers
      .filter((o) => (o.type === "BUNDLE" ? (o.items || []).some((c) => c.variantId === i.variantId) : o.type === "SUBSCRIPTION" ? Object.hasOwn(o.lines || {}, i.variantId) : matchesTarget(i, o.target)))
      .map((o) => o.id)
      .join("|");

  // the subtotal points a subtotal-only goal is proved at: r, and where the entered code turns valid
  const couponOffer = findCoupon(coupon, offers);
  const couponPoint = couponOffer?.minSubtotal ? Math.ceil(couponOffer.minSubtotal - subtotal) : 0;
  const points = (r) => [r, ...(couponPoint > r ? [couponPoint] : [])];

  // ---- the nearest quantity tier, proved on one line per match profile ----
  // Phase 9 line 2: a subscribed line takes no other line offer (the engine
  // claims it first), so it never counts toward, or is nudged for, a tier
  const subscribed = new Set(lineOffers.filter((o) => o.type === "SUBSCRIPTION").flatMap((o) => Object.keys(o.lines || {})));
  let tier = null;
  for (const o of lineOffers.filter((x) => x.type === "TIERED_QTY" && Array.isArray(x.tiers))) {
    const matching = items.filter((i) => matchesTarget(i, o.target) && !subscribed.has(i.variantId));
    if (!matching.length) continue;
    const qty = matching.reduce((s, i) => s + i.quantity, 0);
    const next = [...o.tiers].sort((a, b) => a.minQty - b.minQty).find((t) => t.minQty > qty);
    if (!next) continue;
    const add = next.minQty - qty;
    if (tier && (tier.add < add || (tier.add === add && tier.priority <= (o.priority ?? 0)))) continue;
    const label = `${o.title} · ${next.percent}% off`;
    const tried = new Set();
    for (const line of matching) {
      const key = profileOf(line);
      if (tried.has(key)) continue;
      tried.add(key);
      const proof = run(items.map((i) => (i.variantId === line.variantId ? { ...i, quantity: i.quantity + add } : i)));
      if (proof.appliedOffers.some((a) => a.id === o.id && a.label === label) && (proof.lineDiscounts[line.variantId] || 0) > 0) {
        tier = { id: o.id, add, priority: o.priority ?? 0, variantId: line.variantId, text: `Add ${add} more for ${next.percent}% off · ${o.title}` };
        break;
      }
    }
  }

  // ---- spend goals: free gifts and free shipping ----
  const goals = [];
  const giftOffers = offers.filter((o) => o.type === "FREE_GIFT" && o.scope === "gift" && o.gift && Number.isFinite(Number(o.threshold)));
  for (const o of [...giftOffers].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
    const giftTitle = giftTitles?.get(o.gift.variantId) || o.gift.title || o.title;
    if (now.gifts.some((g) => g.offerId === o.id)) {
      out.unlocked.push({ id: o.id, label: `Free ${giftTitle}` });
      continue;
    }
    const remaining = overBy(Number(o.threshold), subtotal);
    if (remaining <= 0) continue; // over the line but not given (an exclusive coupon): nothing to promise
    if (!points(remaining).every((v) => run(plain(items, v)).gifts.some((g) => g.offerId === o.id))) continue;
    goals.push({ id: o.id, remaining, text: `Add ${money(remaining)} more for a free ${giftTitle}`, label: `Free ${giftTitle}` });
  }
  // A store whose pincode zones set their own free-shipping amount gets no
  // shipping promise: the drawer doesn't know the shopper's pincode.
  const zoned = (shippingConfig?.zones || []).some((z) => z?.freeThreshold != null);
  const honestBasis = shippingConfig?.basis === "gross" || lineOffers.length === 0;
  if (shippingConfig && shippingConfig.freeThreshold != null && !zoned) {
    const shipOf = (res) => computeShipping({ subtotal: res.subtotal, discountTotal: res.discountTotal, paymentMethod: "prepaid", config: shippingConfig });
    const s0 = shipOf(now);
    if (s0.free) out.unlocked.push({ id: "shipping", label: "Free shipping" });
    else if (honestBasis) {
      // a percent coupon takes part of what is added: step until every checked point really crosses
      let r = Math.ceil(s0.remainingForFree);
      let crossed = false;
      for (let k = 0; k < MAX_STEPS && r > 0; k++) {
        const short = Math.max(...points(r).map((v) => shipOf(run(plain(items, v))).remainingForFree));
        if (short === 0) {
          crossed = true;
          break;
        }
        r += Math.max(1, Math.ceil(short));
      }
      if (crossed) goals.push({ id: "shipping", remaining: r, text: `Add ${money(r)} more for free shipping`, label: "Free shipping" });
    }
  }
  if (goals.length) {
    goals.sort((a, b) => a.remaining - b.remaining);
    const span = subtotal + goals[goals.length - 1].remaining;
    const pos = (r) => Math.min(100, Math.round(((subtotal + r) / span) * 100));
    out.nudges.push({
      kind: "spend",
      id: goals[0].id,
      text: goals[0].text,
      remaining: goals[0].remaining,
      percent: Math.min(99, Math.round((subtotal / span) * 100)),
      milestones: goals.map((g) => ({ id: g.id, label: g.label, position: pos(g.remaining) })),
    });
  }
  if (tier) out.nudges.push({ kind: "tier", id: tier.id, text: tier.text, variantId: tier.variantId, add: tier.add });

  // ---- the shopper's own coupon, short of its minimum ----
  // Only when using it is really worth it. A combinable code applies on top of
  // everything else, so reaching its minimum (a subtotal) is enough. An
  // exclusive code switches off line offers and gifts: units the shopper adds
  // could be discounted by a line offer by more than the code saves, and the
  // smallest whole-unit add can overshoot into a gift threshold the code
  // switches off. So it is nudged only when the store has no line offer and no
  // gift offer, and only when the total with the code is below the same cart's
  // without it (the gift checks below stay as a guard).
  if (couponOffer && now.couponStatus && !now.couponStatus.valid && couponOffer.minSubtotal && subtotal < couponOffer.minSubtotal) {
    const remaining = couponPoint;
    const giftsWorth = (r) => r.appliedOffers.reduce((s, a) => s + (a.gift ? Number(a.giftValue) || 0 : 0), 0);
    const lines = plain(items, remaining);
    const r = run(lines);
    let ok = r.couponStatus?.valid && r.couponStatus.applied > 0;
    if (ok && couponOffer.combinable === false) {
      const without = evaluateOffers(lines, { offers, coupon: null, ...(round ? { round } : {}) });
      const kept = (g) => r.gifts.some((x) => x.offerId === g.offerId);
      ok = lineOffers.length === 0 && giftOffers.length === 0 && now.gifts.every(kept) && without.gifts.every(kept) && r.total - giftsWorth(r) < without.total - giftsWorth(without);
    }
    if (ok) out.nudges.push({ kind: "coupon", id: couponOffer.id, text: `Add ${money(remaining)} more to use ${couponOffer.code}`, remaining });
  }

  out.nudges = out.nudges.slice(0, MAX_NUDGES);
  return out;
}
