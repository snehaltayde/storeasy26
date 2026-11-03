// Offer simulator (Session 32 / BE07+MC14, rebuilt for COM-03). Runs the
// EXACT pure engine (evaluateOffers + computeShipping) on example carts made
// from THIS store's own products: a cart that gets the offer and the closest
// one that doesn't, both built by lib/offers/plain.js from the same terms as
// the offer's sentence, and each checked against what that sentence promises.
// Combination with the store's other live offers is shown, not guessed. No DB
// writes; the reads are the catalog and the active-offer list.
import { evaluateOffers } from "./engine.js";
import { getActiveOffers } from "./store.js";
import { computeShipping } from "../shipping.js";
import { tenantShippingConfig } from "../tenant-context.js";
import { validateOffer } from "./validate.js";
import { exampleCatalog, maxPrice, offerTargetNames, storeCurrency } from "./catalog.js";
import { checkExample, offerExamples, offerSentence, offerWarnings } from "./plain.js";

const lineView = (i) => ({ title: i.variantTitle && !/^default( title)?$/i.test(i.variantTitle) ? `${i.title} — ${i.variantTitle}` : i.title, price: i.price, quantity: i.quantity });

// Simulate ONE candidate offer (validated first). `enabled` only changes the
// notes: the example always shows what the offer does once it is on.
// Returns { ok, currency, sentence, example, nearMiss, steps, missing,
//   warnings, facts, cart, alone, combined, applied, activeOfferCount, notes }
// where cart/alone/combined/applied describe the main example.
export async function simulateOffer({ offer, enabled = true }) {
  const errors = validateOffer(offer);
  if (errors.length) return { ok: false, errors };

  const candidate = { ...offer };
  const [currency, catalog, names, active] = await Promise.all([storeCurrency(), exampleCatalog(candidate), offerTargetNames([candidate]), getActiveOffers()]);
  const others = active.filter((o) => o.id !== candidate.id);
  const plan = offerExamples(candidate, catalog, { currency });
  const targeted = candidate.type === "BXGY" || candidate.type === "TIERED_QTY";
  const facts = { maxTargetPrice: targeted ? maxPrice(catalog) : null };

  const run = (ex, offers) => {
    const result = evaluateOffers(ex.lines, { offers, coupon: ex.coupon });
    const shipping = computeShipping({
      subtotal: result.subtotal,
      discountTotal: result.discountTotal,
      paymentMethod: "prepaid",
      config: tenantShippingConfig(),
    });
    return {
      subtotal: result.subtotal,
      discountTotal: result.discountTotal,
      total: result.total,
      appliedOffers: result.appliedOffers,
      gifts: (result.gifts || []).map((g) => ({ title: g.title, variantId: g.variantId })),
      couponStatus: result.couponStatus || null,
      shippingEstimate: shipping.total,
    };
  };
  const view = (ex) => {
    if (!ex) return null;
    const alone = run(ex, [candidate]);
    const combined = run(ex, [...others, candidate]);
    return {
      text: ex.text,
      lines: ex.lines.map(lineView),
      coupon: ex.coupon,
      expect: ex.expect,
      alone,
      combined,
      ...checkExample(ex, alone),
      appliedAlone: alone.appliedOffers.some((a) => a.id === candidate.id),
      appliedCombined: combined.appliedOffers.some((a) => a.id === candidate.id),
    };
  };

  const example = view(plan.example);
  const nearMiss = view(plan.nearMiss);
  const steps = (plan.steps || []).map(view);

  const notes = [];
  if (!enabled) notes.push("This offer is off. Shoppers won't get it until you turn it on.");
  if (example && example.appliedAlone && !example.appliedCombined) {
    notes.push(
      candidate.type === "COUPON"
        ? "With your other live offers, this code doesn't apply to this cart: another offer turns codes off, or takes the discount first."
        : "With your other live offers, this one doesn't apply to this cart: another offer already covers these items.",
    );
  }
  const otherCoupons = others.filter((o) => o.type === "COUPON");
  if (candidate.type === "COUPON" && otherCoupons.length) {
    notes.push(`Shoppers can use one code per order, and you have ${otherCoupons.length} other ${otherCoupons.length === 1 ? "code" : "codes"} live.`);
  }

  return {
    ok: true,
    currency,
    sentence: offerSentence(candidate, { names, currency }),
    example,
    nearMiss,
    steps,
    missing: plan.missing,
    warnings: offerWarnings(candidate, { currency, freeItemValue: facts.maxTargetPrice }),
    facts,
    // the main example, in the shape the console has always read
    cart: example ? { items: example.lines } : { items: [] },
    alone: example?.alone || null,
    combined: example?.combined || null,
    applied: { alone: Boolean(example?.appliedAlone), combined: Boolean(example?.appliedCombined) },
    activeOfferCount: others.length,
    notes,
  };
}
