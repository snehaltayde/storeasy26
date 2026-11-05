// P5-BUNDLEREAD (COM-01): whether a bundle can be sold, worked out from rows
// the caller already read. Pure: no database, no imports, edge- and
// browser-safe.
//
//   compatFrom({ items, bundle_price, variantsById, productsById })
//     -> { ok, state, reasons, problems, components, componentsSum, saving,
//          liveSaving, currency }
//
// variantsById: Map (or plain object) variant id -> variants row
//   { id, product_id, title, price, currency, available }
// productsById: Map (or plain object) product id -> effective card row
//   (lib/catalog/effective.js byIds): { id, handle, title, featured_image,
//   currency, available }
//
// state, first match wins:
//   not_ready  fewer than 2 components, the same variant twice, a price that
//              is not a positive number, components priced in different
//              currencies, or a quantity that is not a whole number
//   sold_out   a component variant or its product is unavailable, or gone
//              from the catalog
//   no_saving  the bundle price is not lower than the components' sum, and
//              every component was found in the catalog (P5-FIX1)
//   available  none of the above
//
// reasons: structured, for new wording (lib/commerce/bundle-words.js):
//   { kind: 'too_few' }
//   { kind: 'duplicate', index, title }
//   { kind: 'bad_price' }
//   { kind: 'mixed_currency' }
//   { kind: 'bad_quantity', index, title, words }
//   { kind: 'sold_out', index, title }
//   { kind: 'missing', index, title }
//   { kind: 'no_saving', sum, price }
// index is 0-based. title is the product's effective title, or null; never
// a variant id.
//
// problems: the legacy strings, byte for byte as lib/bundles.js always wrote
// them (they carry the rupee sign and "component N:"). Only the getBundle
// snapshot and legacy callers read them; new UI never does. A duplicate
// variant or mixed currencies add a legacy-style problem too, so `ok` stays
// "no problems"; rows written through lib/bundles.js never have either.
//
// saving: the legacy value, Math.max(0, sum - price) (getBundle shows it).
// P5-FIX1 (orchestrator rulings 1 and 2, after the batch 1 review):
//   · A component gone from the catalog is left out of the sum, so the sum
//     is not the real one. no_saving is added only when every component was
//     found; otherwise the founder would be told to lower the price on a
//     false sum, when the fix is to replace the product. Such a bundle is
//     sold_out (missing), as before.
//   · bad_quantity lives here, so lib/bundles.js (getBundle, the console)
//     and lib/commerce/bundle-read.js (the home blocks, publish checks) give
//     the same answer: a quantity that is a finite number but not whole
//     (1.5) makes the bundle not_ready. A missing or non-numeric quantity is
//     still read as 1, as mergeItems always has. The reason carries the
//     engine's own words too (lib/commerce/bundle-words.js reasonSentence
//     says the same).
//
// liveSaving: sum > 0 && price > 0 ? Math.round(Math.max(0, sum - price)) : 0,
// which is the engine's BUNDLE discount for one complete set
// (lib/offers/engine.js applyLineOffer) when every component is in the cart.

const NOT_READY = new Set(["too_few", "duplicate", "bad_price", "mixed_currency", "bad_quantity"]);

export const BAD_QUANTITY_WORDS = "The quantity must be a whole number, 1 or more";
// A quantity that is a finite number but not a whole one (1.5, "2.5").
export const isBadQuantity = (q) => q != null && q !== "" && Number.isFinite(Number(q)) && !Number.isInteger(Number(q));
const UNSELLABLE = new Set(["sold_out", "missing"]);

const pick = (m, k) => (k == null || !m ? undefined : m instanceof Map ? m.get(k) : m[k]);

export function stateOf(reasons) {
  const kinds = new Set((reasons || []).map((r) => r.kind));
  if ([...kinds].some((k) => NOT_READY.has(k))) return "not_ready";
  if ([...kinds].some((k) => UNSELLABLE.has(k))) return "sold_out";
  if (kinds.has("no_saving")) return "no_saving";
  return "available";
}

export function compatFrom({ items, bundle_price, variantsById, productsById } = {}) {
  const problems = [];
  const reasons = [];
  const comps = Array.isArray(items) ? items : [];
  if (comps.length < 2) {
    problems.push("a bundle needs at least 2 components");
    reasons.push({ kind: "too_few" });
  }
  let sum = 0;
  const detailed = [];
  const seen = new Set();
  const currencies = new Set();
  let allFound = true;
  for (const [i, c] of comps.entries()) {
    const qty = Math.max(1, Number(c?.quantity) || 1);
    const variant = c?.variantId ? pick(variantsById, c.variantId) : null;
    if (isBadQuantity(c?.quantity)) {
      const t = (variant && pick(productsById, variant.product_id)?.title) || null;
      problems.push(`component ${i + 1}${t ? ` (${t})` : ""}: quantity must be a whole number`);
      reasons.push({ kind: "bad_quantity", index: i, title: t, words: BAD_QUANTITY_WORDS });
    }
    if (!variant) {
      allFound = false;
      problems.push(`component ${i + 1}: variant not in the catalog`);
      reasons.push({ kind: "missing", index: i, title: null });
      detailed.push({ ...c, state: "missing" });
      continue;
    }
    const product = pick(productsById, variant.product_id);
    const title = product?.title || null;
    if (seen.has(variant.id)) {
      problems.push(`component ${i + 1} (${product?.title || c.variantId}): already in the bundle`);
      reasons.push({ kind: "duplicate", index: i, title });
    }
    seen.add(variant.id);
    if (!variant.available || !product?.available) {
      problems.push(`component ${i + 1} (${product?.title || c.variantId}): sold out`);
      reasons.push(product ? { kind: "sold_out", index: i, title } : { kind: "missing", index: i, title: null });
    }
    if (!product) allFound = false;
    const cur = variant.currency || product?.currency || null;
    if (cur) currencies.add(String(cur).toUpperCase());
    sum += Number(variant.price || 0) * qty;
    detailed.push({ variantId: variant.id, quantity: qty, title: product?.title, variant_title: variant.title, handle: product?.handle, image: product?.featured_image, price: Number(variant.price || 0), available: Boolean(variant.available && product?.available) });
  }
  if (currencies.size > 1) {
    problems.push("components are priced in different currencies");
    reasons.push({ kind: "mixed_currency" });
  }
  const price = Number(bundle_price);
  if (!Number.isFinite(price) || price <= 0) {
    problems.push("bundle price must be a positive number");
    reasons.push({ kind: "bad_price" });
  } else if (allFound && sum > 0 && price >= sum) {
    problems.push(`bundle price ₹${price} doesn't save anything (components sum to ₹${sum})`);
    reasons.push({ kind: "no_saving", sum, price });
  }
  const saving = sum > 0 && price > 0 ? Math.max(0, sum - price) : 0;
  const liveSaving = sum > 0 && price > 0 ? Math.round(Math.max(0, sum - price)) : 0;
  return {
    ok: problems.length === 0,
    state: stateOf(reasons),
    reasons,
    problems,
    components: detailed,
    componentsSum: sum,
    saving,
    liveSaving,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}

// Duplicate variant ids merged into one entry with the summed quantity, in
// first-seen order. Every bundle write goes through this, so a stored bundle
// never lists a variant twice (the engine counts sets per entry, so a
// duplicate entry would get the discount twice).
export function mergeItems(items) {
  const out = [];
  const at = new Map();
  for (const c of Array.isArray(items) ? items : []) {
    const variantId = c?.variantId;
    const quantity = Math.max(1, Number(c?.quantity) || 1);
    if (variantId && at.has(variantId)) {
      out[at.get(variantId)].quantity += quantity;
      continue;
    }
    if (variantId) at.set(variantId, out.length);
    out.push({ variantId, quantity });
  }
  return out;
}
