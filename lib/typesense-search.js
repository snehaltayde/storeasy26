// Edge-safe Typesense search — raw fetch against the REST API, no SDK (the
// `typesense` package depends on axios, which isn't edge-compatible). Imported
// by the edge search route + page. The SDK is used only by the Node sync.
// Env-driven so staging can point at a separate index (e.g. products_staging)
// without touching the production collection. Defaults to "products".
import { tenantCfg, tenantOwnCfg, currentTenant } from "./tenant-context.js";

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
