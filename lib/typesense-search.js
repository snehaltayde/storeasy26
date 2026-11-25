// Edge-safe Typesense search — raw fetch against the REST API, no SDK (the
// `typesense` package depends on axios, which isn't edge-compatible). Imported
// by the edge search route + page. The SDK is used only by the Node sync.
// Env-driven so staging can point at a separate index (e.g. products_staging)
// without touching the production collection. Defaults to "products".
import { tenantCfg, tenantOwnCfg, currentTenant } from "./tenant-context.js";
import { PER_PAGE, optionField, selectedGroups, typesenseFilter } from "./catalog/facets.js";

// Per-tenant index (Session 20): tenant config first, env fallback — the same
// value the sync writes to and the storefront searches.
// S53 (audit A3 boundary): a PLATFORM tenant uses ITS OWN namespace or NONE —
// the env/default fallback would quietly point several tenants at one shared
// index. null = Typesense unavailable for this tenant (SQL search serves).
export const productsCollection = () => {
  const t = currentTenant();
  if (t && t.id !== "_default") return tenantOwnCfg("typesense_collection", null, null) || null;
  return tenantCfg("typesense_collection", "TYPESENSE_COLLECTION", "products");
};
export const SEARCH_QUERY_BY = "title,product_type,tags,vendor,description";

export function typesenseConfigured() {
  return Boolean(process.env.TYPESENSE_HOST && process.env.TYPESENSE_ADMIN_API_KEY);
}

// P4-SEARCH (OVL-17): a test seam for the Typesense ADMIN client. The full
// sync's index (lib/sync.js indexTypesense) and the one-product reindex
// (lib/catalog/search-reindex.js) take this client instead of the SDK's when
// a test has set one, so a suite can watch every call with a spy and never
// reach a real Typesense. Never set outside tests. null goes back to the SDK.
let adminClientForTest = null;
export function setSearchAdminClientForTest(client = null) {
  adminClientForTest = client || null;
}
export const searchAdminClientForTest = () => adminClientForTest;

// Returns null when Typesense isn't configured so callers can fall back to the DB.
export async function typesenseSearch(q, { limit = 8 } = {}) {
  const host = process.env.TYPESENSE_HOST;
  const apiKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!host || !apiKey) return null;
  if (!productsCollection()) return null; // tenant without a namespace → SQL fallback

  const protocol = process.env.TYPESENSE_PROTOCOL || "https";
  const port = process.env.TYPESENSE_PORT || "443";
  const params = new URLSearchParams({
    q,
    query_by: SEARCH_QUERY_BY,
    per_page: String(limit),
    num_typos: "2",
    prioritize_exact_match: "true",
  });
  const url = `${protocol}://${host}:${port}/collections/${productsCollection()}/documents/search?${params}`;

  const res = await fetch(url, { headers: { "X-TYPESENSE-API-KEY": apiKey } });
  if (!res.ok) {
    throw new Error(`Typesense ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const r = await res.json();
  return {
    source: "typesense",
    found: r.found,
    hits: (r.hits || []).map((h) => ({
      handle: h.document.handle,
      title: h.document.title,
      image: h.document.image || null,
      price: h.document.price ?? null,
      currency: h.document.currency || "INR",
      product_type: h.document.product_type || null,
      available: h.document.available ?? true,
    })),
  };
}

// ---- P7-FACETS: filtered search with facet counts ---------------------------------------
//
// One multi_search (decision 7): the results with every filter, plus one count
// query per selected group (type, brand, each option name) with every filter
// except its own, so counts are disjunctive; at most 7 queries
// (lib/catalog/facets.js MAX_SELECTED_GROUPS). `state` is
// parseFacetParams()'s, and filter_by is built only from it, every value in
// backticks (typesenseFilter). Returns null when Typesense isn't configured
// for this tenant. Throws when any query fails, e.g. an index from before the
// options fields (until a full sync): the page then serves the SQL engine.
const SORT_BY = { "price-asc": "price:asc", "price-desc": "price:desc", new: "created_at:desc" };
const GROUP_FIELD = (s, g) => (g === "type" ? "product_type" : g === "vendor" ? "vendor" : optionField(s));

export async function typesenseFacetSearch(s) {
  const host = process.env.TYPESENSE_HOST;
  const apiKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!host || !apiKey) return null;
  const collection = productsCollection();
  if (!collection) return null;
  const protocol = process.env.TYPESENSE_PROTOCOL || "https";
  const port = process.env.TYPESENSE_PORT || "443";
  const base = { collection, q: s.q || "*", query_by: SEARCH_QUERY_BY, num_typos: 2, prioritize_exact_match: true };
  const optField = optionField(s);
  const main = {
    ...base,
    filter_by: typesenseFilter(s),
    facet_by: `product_type,vendor,${optField},price`,
    max_facet_values: 250,
    per_page: PER_PAGE,
    page: s.page,
    ...(SORT_BY[s.sort] ? { sort_by: SORT_BY[s.sort] } : {}),
  };
  const groups = selectedGroups(s);
  const searches = [main, ...groups.map((g) => ({ ...base, filter_by: typesenseFilter(s, { exclude: g }), facet_by: GROUP_FIELD(s, g), max_facet_values: 250, per_page: 0 }))];
  for (const q of searches) if (!q.filter_by) delete q.filter_by;
  const res = await fetch(`${protocol}://${host}:${port}/multi_search`, {
    method: "POST",
    headers: { "X-TYPESENSE-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ searches }),
  });
  if (!res.ok) throw new Error(`Typesense ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  if (results.length !== searches.length) throw new Error("Typesense multi_search: unexpected answer");
  const bad = results.find((r) => r?.error);
  if (bad) throw new Error(`Typesense ${bad.code || ""}: ${String(bad.error).slice(0, 200)}`);

  const facet = (r, field) => (r.facet_counts || []).find((f) => f.field_name === field);
  const countsOf = (r, field) => (facet(r, field)?.counts || []).map((c) => ({ value: String(c.value), count: Number(c.count) || 0 }));
  const [first, ...rest] = results;
  const counts = { type: countsOf(first, "product_type"), vendor: countsOf(first, "vendor"), options: [], price: { min: null, max: null } };
  const stats = facet(first, "price")?.stats;
  if (first.found > 0 && stats) counts.price = { min: Number(stats.min), max: Number(stats.max) };
  const selectedNames = new Set(s.options.map((g) => g.name));
  for (const c of countsOf(first, optField)) if (!selectedNames.has(c.value.split(":")[0])) counts.options.push({ key: c.value, count: c.count });
  groups.forEach((g, i) => {
    const got = countsOf(rest[i], GROUP_FIELD(s, g));
    if (g === "type" || g === "vendor") counts[g] = got;
    else counts.options.push(...got.filter((c) => c.value.startsWith(`${g.slice(2)}:`)).map((c) => ({ key: c.value, count: c.count })));
  });
  return {
    source: "typesense",
    found: Number(first.found) || 0,
    hits: (first.hits || []).map((h) => ({
      handle: h.document.handle,
      title: h.document.title,
      image: h.document.image || null,
      price: h.document.price ?? null,
      currency: h.document.currency || "INR",
      display_type: h.document.product_type || null,
      available: h.document.available ?? true,
    })),
    counts,
    queries: searches.length,
  };
}
