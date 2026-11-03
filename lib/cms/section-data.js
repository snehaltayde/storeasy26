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
import { componentFor } from "./registry.js";
import { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getProductsInCollection, collectionPinsByHandles } from "../repo.js";

const DEFAULT_REPO = { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getProductsInCollection, collectionPinsByHandles };

// sections: the RENDER list (enabled, known kinds, ids present or absent —
// legacy live snapshots may be id-less; we key those by index).
// index: resolvedCollectionsIndex() (curated featured handles) or null.
// → Map<instanceKey, data object per the component's bindings>
export async function resolveHomeSectionData(sections, { index = null, repo = DEFAULT_REPO } = {}) {
  const keyOf = (s, i) => s.id || `i-${i}`;
  const out = new Map();

  // One curated read serves every collections instance (sliced per limit).
  let curated = null;
  const needsCurated = sections.some((s) => componentFor(s.kind)?.bindings?.collections) && index?.featured?.length;
  if (needsCurated) curated = await repo.getCollectionsByHandles(index.featured);

  // P2-PERF: every rail's pins in one read (one per rail before). A repo
  // without the batch read (tests' fakes) leaves pins to each rail's own read.
  const railArgs = (s) => {
    const def = componentFor(s.kind);
    const b = Object.values(def?.bindings || {}).find((x) => x.source === "collection_products");
    return b ? s.collection ?? def.defaults?.collection : null;
  };
  const railHandles = sections.map(railArgs).filter(Boolean);
  const pinsByHandle = railHandles.length && repo.collectionPinsByHandles ? await repo.collectionPinsByHandles(railHandles) : null;

  // Batch identical (source, args) queries.
  const queryCache = new Map();
  const run = (source, args) => {
    const cacheKey = `${source}:${JSON.stringify(args)}`;
    if (!queryCache.has(cacheKey)) {
      let p;
      if (source === "newest_products") p = repo.getNewestProducts(args.limit);
      else if (source === "collection_products") {
        // S55: a product rail bound to ONE collection (featured/pinned order)
        p = args.collection
          ? repo
              .getProductsInCollection(args.collection, { limit: args.limit, sort: "featured", withTotal: false, ...(pinsByHandle ? { pins: pinsByHandle.get(args.collection) || [] } : {}) })
              .then((r) => r?.products || [])
          : Promise.resolve([]);
      } else p = curated?.length ? Promise.resolve(curated.slice(0, args.limit)) : repo.getFeaturedCollections(args.limit);
      queryCache.set(cacheKey, p);
    }
    return queryCache.get(cacheKey);
  };

  for (const [i, s] of sections.entries()) {
    const def = componentFor(s.kind);
    if (!def) continue;
    const data = {};
    for (const [field, binding] of Object.entries(def.bindings || {})) {
      const args = {};
      for (const argKey of binding.args || []) args[argKey] = s[argKey] ?? def.defaults?.[argKey];
      args.limit = Number(args.limit) || def.defaults?.limit || 8;
      data[field] = await run(binding.source, args);
    }
    out.set(keyOf(s, i), data);
  }
  return out;
}
