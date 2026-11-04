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
//              is not a positive number, or components priced in different
//              currencies
//   sold_out   a component variant or its product is unavailable, or gone
//              from the catalog
//   no_saving  the bundle price is not lower than the components' sum
//   available  none of the above
//
// reasons: structured, for new wording (lib/commerce/bundle-words.js):
//   { kind: 'too_few' }
//   { kind: 'duplicate', index, title }
//   { kind: 'bad_price' }
//   { kind: 'mixed_currency' }
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
// liveSaving: sum > 0 && price > 0 ? Math.round(Math.max(0, sum - price)) : 0,
// which is the engine's BUNDLE discount for one complete set
// (lib/offers/engine.js applyLineOffer) when every component is in the cart.

const NOT_READY = new Set(["too_few", "duplicate", "bad_price", "mixed_currency"]);
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
  for (const [i, c] of comps.entries()) {
    const qty = Math.max(1, Number(c?.quantity) || 1);
    const variant = c?.variantId ? pick(variantsById, c.variantId) : null;
    if (!variant) {
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
  } else if (sum > 0 && price >= sum) {
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
