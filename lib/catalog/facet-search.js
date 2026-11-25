// P7-FACETS: the search page's one read. Typesense when this tenant has its
// own namespace, else the SQL engine; a Typesense failure (an index from
// before the options fields, until a full sync) serves SQL for that request
// and logs search_facets_fallback. Every answer logs search_facets
// {source, groups, ms}. Edge-safe.
import { slog } from "../log.js";
import { typesenseFacetSearch } from "../typesense-search.js";
import { facetSearchDb, shapeFacets } from "./facets.js";

export async function runFacetSearch(state) {
  const started = Date.now();
  let result = null;
  try {
    result = await typesenseFacetSearch(state);
  } catch (e) {
    slog("search_facets_fallback", { reason: String(e?.message || e).slice(0, 200) });
  }
  if (!result) result = await facetSearchDb(state);
  const shaped = shapeFacets(state, result.counts);
  slog("search_facets", { source: result.source, groups: shaped.groups.length, ms: Date.now() - started });
  return { source: result.source, found: result.found, hits: result.hits, ...shaped };
}
