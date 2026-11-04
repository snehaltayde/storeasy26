// P4-MAPPER: the entity part of the MIG-01 mapper, as a STUB. P4-OVL07 owns
// this file in batch 3 and fills it: product_content and collection_content
// documents from product_overrides, the pdp_pairs placements, collection_overrides
// and the surface_templates products / collections maps (spec 8.3), with
// P4-LIVEROW's liveRowFor for the live rows.
//
// The contract map.js calls it with, so OVL07 changes only this file:
//
//   mapEntities(source, ctx) -> Promise<{
//     built,       false in this stub: map.js then refuses a store that holds
//                  entity content ("can't be moved yet"), so nothing is lost
//     documents,   [{ id, type, entityId, label, draft, draftHash,
//                     published: { versionId, bodyHash, body } | null,
//                     publishedHash }]   the same shape map.js gives its own
//     bodies,      Map versionId -> { document_id, body }
//     liveRows,    { product: [row], collection: [row] }
//     refs,        [{ version_id, ref_type, ref_id }]
//     holds,       { products, collections, pairs, templates } counts of the
//                  entity content the source holds (map.js reports them)
//   }>
//
//   source   what map.js read (readLegacySource): source.raw holds the live
//            tables, source.state.live the live release (its frozen arrays)
//   ctx      { published: 'release' | 'release+tables' | 'drafts' | 'none' | null,
//              release: the live release content or null,
//              existing: Map "<type>\u0000<entity id>" -> the documents row
//              already there (a phase-3 random id is reused, never duplicated) }
//
// Pure apart from Web Crypto: no database read here (map.js reads).
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const len = (v) => (Array.isArray(v) ? v.length : 0);

// What entity content a source holds, whether or not it is mapped yet: the
// live tables (source.raw, read by map.js) and the live release's frozen
// arrays (v2 and v3).
const parse = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const templates = (st) => (isObj(st) ? Object.keys(isObj(st.products) ? st.products : {}).length + Object.keys(isObj(st.collections) ? st.collections : {}).length : 0);

export function entityHoldings(source) {
  const raw = isObj(source?.raw) ? source.raw : {};
  const live = source?.state?.live?.state === "live" ? source.state.live.release?.content : null;
  const rel = isObj(live) && live.v >= 2 ? live : null;
  const pairs = (list) => (Array.isArray(list) ? list.filter((p) => isObj(p) && p.kind === "pdp_pairs").length : 0);
  const st = (Array.isArray(raw.cms_blocks) ? raw.cms_blocks : []).find((b) => b.key === "surface_templates");
  return {
    products: len(raw.product_overrides) + (rel ? len(rel.product_overrides) : 0),
    collections: len(raw.collection_overrides) + (rel ? len(rel.collection_pins) : 0),
    pairs: pairs(raw.placements) + (rel ? pairs(rel.placements) : 0),
    templates: templates(parse(st?.value, null)) + (isObj(live?.blocks) ? templates(live.blocks.surface_templates) : 0),
  };
}

export async function mapEntities(source /* , ctx */) {
  return {
    built: false,
    documents: [],
    bodies: new Map(),
    liveRows: { product: [], collection: [] },
    refs: [],
    holds: entityHoldings(source),
  };
}
