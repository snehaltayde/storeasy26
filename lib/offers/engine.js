import { OFFERS } from "./config.js";
import { formatMoney } from "../format.js";
import { matchesTarget } from "./match.js";

// Does a cart line match an offer's target? Pure. Lives in match.js (COM-03:
// the console uses it in the browser); re-exported here unchanged.
export { matchesTarget };

export function findCoupon(code, offers = OFFERS) {
  if (!code) return null;
  const norm = String(code).trim().toUpperCase();
  return offers.find((o) => o.type === "COUPON" && o.code === norm) || null;
}

// --- per-offer math (pure helpers) ---

function applyLineOffer(offer, matching) {
  // S46 (BE31): BUNDLE — "these exact variants, together, for this price".
  // Applies once per complete set present (multiples supported); the saving
  // (components' cart price − bundle price) is allocated to the component
  // lines proportionally. Lines a bundle claims can't be re-claimed by
  // another line offer (the engine's standing one-offer-per-line rule).
  if (offer.type === "BUNDLE") {
    const comps = Array.isArray(offer.items) ? offer.items : [];
    if (!comps.length) return { amount: 0, perLine: {}, label: offer.title };
    const byVariant = Object.fromEntries(matching.map((i) => [i.variantId, i]));
    let sets = Infinity;
    for (const c of comps) {
      const line = byVariant[c.variantId];
      const need = Math.max(1, Number(c.quantity) || 1);
      sets = Math.min(sets, line ? Math.floor(line.quantity / need) : 0);
    }
    if (!Number.isFinite(sets) || sets <= 0) return { amount: 0, perLine: {}, label: offer.title };
    let setValue = 0;
    for (const c of comps) setValue += byVariant[c.variantId].price * Math.max(1, Number(c.quantity) || 1);
    const saving = Math.max(0, setValue - Number(offer.price || 0)) * sets;
    if (saving <= 0) return { amount: 0, perLine: {}, label: offer.title };
    const perLine = {};
    let allocated = 0;
    comps.forEach((c, idx) => {
      const line = byVariant[c.variantId];
      const share =
        idx === comps.length - 1
          ? saving - allocated // last line absorbs rounding
          : Math.round((saving * (line.price * Math.max(1, Number(c.quantity) || 1))) / setValue);
      perLine[c.variantId] = (perLine[c.variantId] || 0) + share;
      allocated += share;
    });
    return { amount: Math.round(saving), perLine, label: offer.title };
  }

  if (offer.type === "BXGY") {
    const totalQty = matching.reduce((s, i) => s + i.quantity, 0);
    const group = offer.buy + offer.free;
    const freeUnits = Math.floor(totalQty / group) * offer.free;
    if (freeUnits <= 0) return { amount: 0, perLine: {}, label: offer.title };
    // freed units are the cheapest qualifying units
    const units = [];
    for (const i of matching) {
      for (let k = 0; k < i.quantity; k++) units.push({ variantId: i.variantId, price: i.price });
    }
    units.sort((a, b) => a.price - b.price);
    const perLine = {};
    let amount = 0;
    for (let k = 0; k < freeUnits && k < units.length; k++) {
      amount += units[k].price;
      perLine[units[k].variantId] = (perLine[units[k].variantId] || 0) + units[k].price;
    }
    return { amount: Math.round(amount), perLine, label: offer.title };
  }

  if (offer.type === "TIERED_QTY") {
    const totalQty = matching.reduce((s, i) => s + i.quantity, 0);
    const tier = [...offer.tiers].sort((a, b) => b.minQty - a.minQty).find((t) => totalQty >= t.minQty);
    if (!tier) return { amount: 0, perLine: {}, label: offer.title };
    const perLine = {};
    let amount = 0;
    for (const i of matching) {
      const d = Math.round((i.price * i.quantity * tier.percent) / 100);
      if (d > 0) {
        perLine[i.variantId] = d;
        amount += d;
      }
    }
    return { amount, perLine, label: `${offer.title} · ${tier.percent}% off` };
  }

  return { amount: 0, perLine: {}, label: offer.title };
}

function couponAmount(coupon, base) {
  if (base <= 0) return 0;
  const d = coupon.discount;
  if (d.kind === "percent") return Math.round((base * d.value) / 100);
  if (d.kind === "fixed") return Math.min(d.value, base);
  return 0;
}

// Pure, deterministic stacking evaluation. Phases:
//   1. line/product offers (per-line mutual exclusion, priority order)
//   2. coupon (order scope) on the NET subtotal  → no double-dipping
//   3. free gift, gated on the PRE-discount paid subtotal (derived line, not stored)
// An exclusive coupon (combinable: false) suppresses phases 1 & 3 and applies to
// the full subtotal — the conflict-resolution path.
export function evaluateOffers(items, { offers = OFFERS, coupon = null } = {}) {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const lineDiscounts = {};
  const addLine = (variantId, amount) => {
    lineDiscounts[variantId] = (lineDiscounts[variantId] || 0) + amount;
  };
  const appliedOffers = [];
  const gifts = [];

  // ---- resolve coupon validity ----
  const code = coupon ? String(coupon).trim().toUpperCase() : null;
  const couponOffer = code ? findCoupon(code, offers) : null;
  let couponStatus = null;
  if (code) {
    if (!couponOffer) {
      couponStatus = { code, valid: false, reason: "Not a valid code" };
    } else if (couponOffer.minSubtotal && subtotal < couponOffer.minSubtotal) {
      couponStatus = {
        code,
        valid: false,
        // COM-03: in the cart's own currency (lines carry it), never a fixed sign
        reason: `Minimum spend ${formatMoney(couponOffer.minSubtotal, items[0]?.currency || "INR")} for this code`,
      };
    } else {
      couponStatus = { code, valid: true };
    }
  }
  const activeCoupon = couponStatus?.valid ? couponOffer : null;
  const exclusive = Boolean(activeCoupon && activeCoupon.combinable === false);

  // ---- phase 1: line offers ----
  let productDiscount = 0;
  const claimed = new Set();
  if (!exclusive) {
    const lineOffers = offers.filter((o) => o.scope === "line").sort((a, b) => a.priority - b.priority);
    for (const offer of lineOffers) {
      // BUNDLE matches by its own component list; everything else by target
      const matching = items.filter((i) =>
        offer.type === "BUNDLE"
          ? (offer.items || []).some((c) => c.variantId === i.variantId) && !claimed.has(i.variantId)
          : matchesTarget(i, offer.target) && !claimed.has(i.variantId),
      );
      if (!matching.length) continue;
      const res = applyLineOffer(offer, matching);
      if (res.amount > 0) {
        for (const [vid, amt] of Object.entries(res.perLine)) {
          addLine(vid, amt);
          claimed.add(vid); // a line can only be claimed by one line offer
        }
        productDiscount += res.amount;
        appliedOffers.push({ id: offer.id, type: offer.type, label: res.label, amount: res.amount });
      }
    }
  }

  // ---- phase 2: coupon on the net subtotal ----
  let couponDiscount = 0;
  if (activeCoupon) {
    const base = exclusive ? subtotal : subtotal - productDiscount;
    couponDiscount = couponAmount(activeCoupon, base);
    if (couponDiscount > 0) {
      couponStatus.applied = couponDiscount;
      appliedOffers.push({
        id: activeCoupon.id,
        type: "COUPON",
        label: `Coupon ${activeCoupon.code}${exclusive ? " · exclusive" : ""}`,
        amount: couponDiscount,
      });
    }
  }

  // ---- phase 3: free gift (derived; gated on pre-discount subtotal) ----
  if (!exclusive) {
    const giftOffers = offers.filter((o) => o.scope === "gift").sort((a, b) => a.priority - b.priority);
    for (const offer of giftOffers) {
      if (offer.type === "FREE_GIFT" && subtotal > offer.threshold) {
        gifts.push({ ...offer.gift, offerId: offer.id });
        appliedOffers.push({
          id: offer.id,
          type: "FREE_GIFT",
          label: offer.title,
          amount: 0,
          gift: true,
          giftValue: offer.gift.value,
        });
      }
    }
  }

  const discountTotal = productDiscount + couponDiscount;
  return {
    subtotal,
    appliedOffers,
    gifts,
    lineDiscounts,
    discountTotal,
    total: Math.max(0, subtotal - discountTotal),
    couponStatus,
  };
}
