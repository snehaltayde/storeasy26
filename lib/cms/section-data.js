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
import { getFeaturedCollections, getCollectionsByHandles, getNewestProducts } from "../repo.js";

const DEFAULT_REPO = { getFeaturedCollections, getCollectionsByHandles, getNewestProducts };

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

  // Batch identical (source, limit) queries.
  const queryCache = new Map();
  const run = (source, limit) => {
    const cacheKey = `${source}:${limit}`;
    if (!queryCache.has(cacheKey)) {
      queryCache.set(
        cacheKey,
        source === "newest_products"
          ? repo.getNewestProducts(limit)
          : curated?.length
            ? Promise.resolve(curated.slice(0, limit))
            : repo.getFeaturedCollections(limit),
      );
    }
    return queryCache.get(cacheKey);
  };

  for (const [i, s] of sections.entries()) {
    const def = componentFor(s.kind);
    if (!def) continue;
    const data = {};
    for (const [field, binding] of Object.entries(def.bindings || {})) {
      const limit = Number(s[binding.args?.[0]] ?? def.defaults?.limit) || def.defaults?.limit || 8;
      data[field] = await run(binding.source, limit);
    }
    out.set(keyOf(s, i), data);
  }
  return out;
}
