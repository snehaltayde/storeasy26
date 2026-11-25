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

// the cart plus one plain line worth `amount`: matches no offer target, so it
// moves only the subtotal (what a gift, coupon minimum or shipping goal reads)
const withSpend = (items, amount, currency) => [
  ...items,
  { variantId: NUDGE_LINE, productId: null, handle: null, tags: [], productType: null, price: amount, quantity: 1, currency },
];

// smallest whole amount that makes `subtotal + r > threshold` (a gift needs strictly over)
const overBy = (threshold, subtotal) => Math.floor(threshold - subtotal) + 1;

/**
 * @param {Array} items engine lines (with tags and productType; never returned)
 * @param {{ offers: Array, coupon?: string|null, result?: object, shippingConfig?: object|null }} opts
 *   result: evaluateOffers(items, { offers, coupon }) when the caller already has it;
 *   shippingConfig: the store's rates, or null when the store hasn't chosen rates (no shipping promise);
 *   giftTitles: Map variantId → the title an applied gift line shows (else the offer's stored gift title)
 * @returns {{ nudges: Array, unlocked: Array }}
 */
export function offerProgress(items, { offers = [], coupon = null, result = null, shippingConfig = null, giftTitles = null } = {}) {
  const out = { nudges: [], unlocked: [] };
  if (!Array.isArray(items) || items.length === 0) return out;
  const currency = items[0]?.currency || "INR";
  const money = (n) => formatMoney(n, currency);
  const run = (lines) => evaluateOffers(lines, { offers, coupon });
  const now = result || run(items);
  const subtotal = now.subtotal;

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
    const proof = run(withSpend(items, remaining, currency));
    if (!proof.gifts.some((g) => g.offerId === o.id)) continue;
    goals.push({ id: o.id, remaining, text: `Add ${money(remaining)} more for a free ${giftTitle}`, label: `Free ${giftTitle}` });
  }
  if (shippingConfig && shippingConfig.freeThreshold != null) {
    const ship = (r) => (r ? run(withSpend(items, r, currency)) : now);
    const shipOf = (res) => computeShipping({ subtotal: res.subtotal, discountTotal: res.discountTotal, paymentMethod: "prepaid", config: shippingConfig });
    const s0 = shipOf(now);
    if (s0.free) out.unlocked.push({ id: "shipping", label: "Free shipping" });
    else {
      // net basis: a percent coupon takes part of what is added, so step until it really crosses
      let r = Math.ceil(s0.remainingForFree);
      let crossed = false;
      for (let k = 0; k < 6 && r > 0; k++) {
        const s = shipOf(ship(r));
        if (s.free) {
          crossed = true;
          break;
        }
        r += Math.max(1, Math.ceil(s.remainingForFree));
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

  // ---- the nearest quantity tier, on a line the engine checked ----
  let tier = null;
  for (const o of offers.filter((x) => x.type === "TIERED_QTY" && x.scope === "line" && Array.isArray(x.tiers))) {
    const matching = items.filter((i) => matchesTarget(i, o.target));
    if (!matching.length) continue;
    const qty = matching.reduce((s, i) => s + i.quantity, 0);
    const next = [...o.tiers].sort((a, b) => a.minQty - b.minQty).find((t) => t.minQty > qty);
    if (!next) continue;
    const add = next.minQty - qty;
    if (tier && (tier.add < add || (tier.add === add && tier.priority <= (o.priority ?? 0)))) continue;
    const label = `${o.title} · ${next.percent}% off`;
    for (const line of matching) {
      const proof = run(items.map((i) => (i.variantId === line.variantId ? { ...i, quantity: i.quantity + add } : i)));
      if (proof.appliedOffers.some((a) => a.id === o.id && a.label === label) && (proof.lineDiscounts[line.variantId] || 0) > 0) {
        tier = { id: o.id, add, priority: o.priority ?? 0, variantId: line.variantId, text: `Add ${add} more for ${next.percent}% off · ${o.title}` };
        break;
      }
    }
  }
  if (tier) out.nudges.push({ kind: "tier", id: tier.id, text: tier.text, variantId: tier.variantId, add: tier.add });

  // ---- the shopper's own coupon, short of its minimum ----
  const couponOffer = findCoupon(coupon, offers);
  if (couponOffer && now.couponStatus && !now.couponStatus.valid && couponOffer.minSubtotal && subtotal < couponOffer.minSubtotal) {
    const remaining = Math.ceil(couponOffer.minSubtotal - subtotal);
    const proof = run(withSpend(items, remaining, currency));
    if (proof.couponStatus?.valid && proof.couponStatus.applied > 0) {
      out.nudges.push({ kind: "coupon", id: couponOffer.id, text: `Add ${money(remaining)} more to use ${couponOffer.code}`, remaining });
    }
  }

  out.nudges = out.nudges.slice(0, MAX_NUDGES);
  return out;
}
