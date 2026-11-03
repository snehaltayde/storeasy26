// Per-instance section data resolution (S54 / audit slice 2). The homepage
// used to fetch data once per KIND into a shared slot (data.collections /
// data.products) — duplicate sections overwrote each other and the last
// instance's `limit` won for all of them. Data now resolves PER INSTANCE ID,
// driven by the registry's declared bindings, with identical queries batched
// (two "newest products" sections with the same limit share one query; one
// curated-collections read serves every collections section, sliced per
// instance).
//
// Node-safe and injectable (`repo` override) so the suite proves instance
// independence and batching without a browser.
//
// P2-SECTIONS: sections come in two shapes. The old flat home section
// ({ id, kind, title, limit, collection }) still works as before. A registry
// section ({ id, kind, settings }), what the home page renders from now, is
// read through the new registry's declaration (lib/registry): its bindings,
// and its settings' defaults. Keys: legacyKey (an old id-less section's
// "i-<n>"), else the id, else "i-<index>".
//
// Product rails and the founder's pinned order (collection_overrides):
//   · a legacy store reads the pins as it always has (one read per rail
//     collection), and the rail says whether its order is hand-picked;
//   · a documents store (documents: true, a v4 release or its preview) never
//     reads collection_overrides: pins are a neutral empty until OVL lands
//     (plan decision 9), so the rail uses the collection's own order.
import { componentFor } from "./registry.js";
import { sectionType } from "../registry/index.js";
import { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getProductsInCollection, collectionPinsByHandle } from "../repo.js";

const DEFAULT_REPO = { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getProductsInCollection, collectionPinsByHandle };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isRegistry = (s) => isObj(s) && isObj(s.settings);

// What a section binds to: { field: { source, args } } and the defaults to
// fill a missing argument with.
function declarationOf(s) {
  if (isRegistry(s)) {
    const d = sectionType(s.kind);
    if (!d) return null;
    const bindings = {};
    for (const [field, b] of Object.entries(d.bindings || {})) bindings[field] = { source: Array.isArray(b.sources) ? b.sources[0] : b.source, args: b.args || [] };
    const defaults = Object.fromEntries(d.settings.filter((x) => x.default !== undefined).map((x) => [x.key, x.default]));
    return { bindings, defaults };
  }
  return componentFor(s?.kind);
}

// A section's own value for a binding argument. A registry collection setting
// is { handle, id }: the binding takes its handle.
function argOf(s, key) {
  if (!isRegistry(s)) return s[key];
  const v = s.settings[key];
  if (key === "collection" && isObj(v)) return typeof v.handle === "string" ? v.handle : undefined;
  return v;
}

// sections: the RENDER list (enabled, known kinds, ids present or absent —
// legacy live snapshots may be id-less; we key those by index).
// index: resolvedCollectionsIndex() (curated featured handles) or null.
// documents: true on a documents store (v4): no collection_overrides read.
// → Map<instanceKey, data object per the component's bindings>
//   (a product rail's data also says handPicked: its order was pinned)
export async function resolveHomeSectionData(sections, { index = null, repo = DEFAULT_REPO, documents = false } = {}) {
  const keyOf = (s, i) => s.legacyKey || s.id || `i-${i}`;
  const out = new Map();

  // One curated read serves every collections instance (sliced per limit).
  let curated = null;
  const needsCurated = sections.some((s) => declarationOf(s)?.bindings?.collections) && index?.featured?.length;
  if (needsCurated) curated = await repo.getCollectionsByHandles(index.featured);

  // A rail collection's products, in its featured order, and whether that
  // order was hand-picked.
  const railProducts = async (handle, limit) => {
    let pins;
    if (documents) pins = [];
    else if (typeof repo.collectionPinsByHandle === "function") pins = await repo.collectionPinsByHandle(handle);
    const r = await repo.getProductsInCollection(handle, { limit, sort: "featured", ...(Array.isArray(pins) ? { pins } : {}) });
    return { list: r?.products || [], handPicked: Array.isArray(pins) && pins.length > 0 };
  };

  // Batch identical (source, args) queries.
  const queryCache = new Map();
  const run = (source, args) => {
    const cacheKey = `${source}:${JSON.stringify(args)}`;
    if (!queryCache.has(cacheKey)) {
      let p;
      if (source === "newest_products") p = repo.getNewestProducts(args.limit);
      else if (source === "collection_products") {
        // S55: a product rail bound to ONE collection (featured/pinned order)
        p = args.collection ? railProducts(args.collection, args.limit) : Promise.resolve({ list: [], handPicked: false });
      } else if (source === "featured_collections") p = curated?.length ? Promise.resolve(curated.slice(0, args.limit)) : repo.getFeaturedCollections(args.limit);
      else p = Promise.resolve(undefined); // a source the home page doesn't serve (route_product)
      queryCache.set(cacheKey, p);
    }
    return queryCache.get(cacheKey);
  };

  for (const [i, s] of sections.entries()) {
    const def = declarationOf(s);
    if (!def) continue;
    const data = {};
    for (const [field, binding] of Object.entries(def.bindings || {})) {
      const args = {};
      for (const argKey of binding.args || []) args[argKey] = argOf(s, argKey) ?? def.defaults?.[argKey];
      args.limit = Number(args.limit) || def.defaults?.limit || 8;
      const value = await run(binding.source, args);
      if (binding.source === "collection_products") {
        data[field] = value.list;
        data.handPicked = value.handPicked;
      } else if (value !== undefined) data[field] = value;
    }
    out.set(keyOf(s, i), data);
  }
  return out;
}
