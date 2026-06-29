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

// Pure, deterministic, re-runnable evaluation. Given cart line items
// ({ variantId, productId, handle, productType, tags[], price, quantity }) and
// the offers, return the discounts to apply. No I/O, no dependency on order.
export function evaluateOffers(items, offers = OFFERS) {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const lineDiscounts = {};
  const addLine = (variantId, amount) => {
    lineDiscounts[variantId] = (lineDiscounts[variantId] || 0) + amount;
  };
  const appliedOffers = [];

  for (const offer of offers) {
    const matching = items.filter((i) => matchesTarget(i, offer.target));
    if (!matching.length) continue;

    if (offer.type === "BXGY") {
      // For every (buy + free) qualifying units, `free` of them are free —
      // and the freed units are the cheapest (standard "get the cheapest free").
      const totalQty = matching.reduce((s, i) => s + i.quantity, 0);
      const group = offer.buy + offer.free;
      const freeUnits = Math.floor(totalQty / group) * offer.free;
      if (freeUnits <= 0) continue;

      const units = [];
      for (const i of matching) {
        for (let k = 0; k < i.quantity; k++) units.push({ variantId: i.variantId, price: i.price });
      }
      units.sort((a, b) => a.price - b.price);

      let amount = 0;
      for (let k = 0; k < freeUnits && k < units.length; k++) {
        amount += units[k].price;
        addLine(units[k].variantId, units[k].price);
      }
      amount = Math.round(amount);
      if (amount > 0) {
        appliedOffers.push({ id: offer.id, type: "BXGY", label: offer.title, amount, freeUnits });
      }
    } else if (offer.type === "TIERED_QTY") {
      // Highest tier whose threshold the qualifying quantity reaches.
      const totalQty = matching.reduce((s, i) => s + i.quantity, 0);
      const tier = [...offer.tiers]
        .sort((a, b) => b.minQty - a.minQty)
        .find((t) => totalQty >= t.minQty);
      if (!tier) continue;

      let amount = 0;
      for (const i of matching) {
        const d = Math.round((i.price * i.quantity * tier.percent) / 100);
        if (d > 0) {
          amount += d;
          addLine(i.variantId, d);
        }
      }
      if (amount > 0) {
        appliedOffers.push({
          id: offer.id,
          type: "TIERED_QTY",
          label: `${offer.title} · ${tier.percent}% off`,
          amount,
          percent: tier.percent,
          qty: totalQty,
        });
      }
    }
  }

  const discountTotal = appliedOffers.reduce((s, o) => s + o.amount, 0);
  return {
    subtotal,
    appliedOffers,
    lineDiscounts,
    discountTotal,
    total: Math.max(0, subtotal - discountTotal),
  };
}
