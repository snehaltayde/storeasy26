// Edge-safe Typesense search — raw fetch against the REST API, no SDK (the
// `typesense` package depends on axios, which isn't edge-compatible). Imported
// by the edge search route + page. The SDK is used only by the Node sync.
export const PRODUCTS_COLLECTION = "products";
export const SEARCH_QUERY_BY = "title,product_type,tags,vendor,description";

export function typesenseConfigured() {
  return Boolean(process.env.TYPESENSE_HOST && process.env.TYPESENSE_ADMIN_API_KEY);
}

// Returns null when Typesense isn't configured so callers can fall back to the DB.
export async function typesenseSearch(q, { limit = 8 } = {}) {
  const host = process.env.TYPESENSE_HOST;
  const apiKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!host || !apiKey) return null;

  const protocol = process.env.TYPESENSE_PROTOCOL || "https";
  const port = process.env.TYPESENSE_PORT || "443";
  const params = new URLSearchParams({
    q,
    query_by: SEARCH_QUERY_BY,
    per_page: String(limit),
    num_typos: "2",
    prioritize_exact_match: "true",
  });
  const url = `${protocol}://${host}:${port}/collections/${PRODUCTS_COLLECTION}/documents/search?${params}`;

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
