import { OFFERS } from "./config.js";

// Does a cart line match an offer's target? Pure.
export function matchesTarget(item, target) {
  if (!target) return false;
  switch (target.kind) {
    case "handle":
      return item.handle === target.value;
    case "productId":
      return item.productId === target.value;
    case "variantId":
      return item.variantId === target.value;
    case "tag":
      return Array.isArray(item.tags) && item.tags.includes(target.value);
    case "productType":
      return item.productType === target.value;
    default:
      return false;
  }
}

export function findCoupon(code, offers = OFFERS) {
  if (!code) return null;
  const norm = String(code).trim().toUpperCase();
  return offers.find((o) => o.type === "COUPON" && o.code === norm) || null;
}

// --- per-offer math (pure helpers) ---

function applyLineOffer(offer, matching) {
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
        reason: `Minimum spend ₹${couponOffer.minSubtotal} for this code`,
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
      const matching = items.filter(
        (i) => matchesTarget(i, offer.target) && !claimed.has(i.variantId),
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
