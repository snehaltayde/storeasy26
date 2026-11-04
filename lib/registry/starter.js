// P3-VALIDATE (AU-04): the section the editor adds. Pure and edge-safe.
//
//   starterSection(kind, { collections, id }) -> a section
//
// Every kind starts from its declared defaults (newSection). A kind that
// declares no defaults a shopper could see either publishes clean as it is
// (the registry contract, checkRegistry) or starts as a known incomplete
// state (startsIncomplete): it previews as its unfinished note with its
// placeholder, and has no made-up starter copy that could be published by
// mistake.
//
// The one kind that can start from real catalog data is the product rail:
// with `collections` given, it is bound to a real collection, so it shows
// products straight away and publishes clean.
//   collections   [{ handle, id?, available_count?, product_count? }], in the
//                 order the editor lists them. available_count (or
//                 availableProducts) is how many of its products are
//                 available (in stock); product_count how many it holds in
//                 all. product_count never stands in for available: a
//                 collection that gives no available count has an unknown
//                 number available (P3-FIX1). The rail takes, in this order:
//                   1. the first with a known count of at least minItems
//                      available products;
//                   2. the first with a known count above 0;
//                   3. the first whose available count is unknown but that
//                      holds products;
//                   4. the first that holds products (all sold out).
//                 With none (or no usable one) it is newSection(kind):
//                 incomplete, asking the founder to pick a collection.
//   id            the section id (minted when left out)
import { sectionType, newSection } from "./index.js";
import { HANDLE_RE } from "./settings.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

function usable(c) {
  return isObj(c) && typeof c.handle === "string" && HANDLE_RE.test(c.handle);
}

// The collection a new rail binds to, or null.
export function pickRailCollection(collections, minItems) {
  const list = Array.isArray(collections) ? collections.filter(usable) : [];
  // null: unknown (the caller gave no available count)
  const available = (c) => count(c.available_count) ?? count(c.availableProducts);
  const total = (c) => count(c.product_count) ?? available(c) ?? 0;
  return (
    list.find((c) => available(c) != null && available(c) >= minItems) ||
    list.find((c) => available(c) != null && available(c) > 0) ||
    list.find((c) => available(c) == null && total(c) > 0) ||
    list.find((c) => total(c) > 0) ||
    null
  );
}

export function starterSection(kind, { collections = null, id } = {}) {
  const d = sectionType(kind);
  if (!d) throw new Error(`starterSection: "${kind}" is not a registered section kind`);
  const section = newSection(kind, { id });
  const collectionSetting = d.settings.find((s) => s.kind === "collection" && s.key === "collection");
  const bindsCollection = Object.values(d.bindings).some((b) => Array.isArray(b.sources) && b.sources.includes("collection_products"));
  if (collectionSetting && bindsCollection) {
    const picked = pickRailCollection(collections, d.minItems ?? 1);
    if (picked) section.settings[collectionSetting.key] = typeof picked.id === "string" && picked.id && picked.id.length <= 120 ? { handle: picked.handle, id: picked.id } : { handle: picked.handle };
  }
  return section;
}
