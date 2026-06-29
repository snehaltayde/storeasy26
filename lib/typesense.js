import Typesense from "typesense";

export const PRODUCTS_COLLECTION = "products";

// query_by ordering also sets field weighting (earlier = more important).
export const SEARCH_QUERY_BY = "title,product_type,tags,vendor,description";

export function typesenseConfigured() {
  return Boolean(process.env.TYPESENSE_HOST && process.env.TYPESENSE_ADMIN_API_KEY);
}

export function getAdminClient() {
  if (!typesenseConfigured()) return null;
  return new Typesense.Client({
    nodes: [
      {
        host: process.env.TYPESENSE_HOST,
        port: Number(process.env.TYPESENSE_PORT || 443),
        protocol: process.env.TYPESENSE_PROTOCOL || "https",
      },
    ],
    apiKey: process.env.TYPESENSE_ADMIN_API_KEY,
    connectionTimeoutSeconds: 5,
  });
}

export const productsCollectionSchema = {
  name: PRODUCTS_COLLECTION,
  fields: [
    { name: "title", type: "string" },
    { name: "description", type: "string", optional: true },
    { name: "product_type", type: "string", facet: true, optional: true },
    { name: "vendor", type: "string", facet: true, optional: true },
    { name: "tags", type: "string[]", facet: true, optional: true },
    { name: "handle", type: "string", index: false, optional: true },
    { name: "image", type: "string", index: false, optional: true },
    { name: "price", type: "float", optional: true },
    { name: "currency", type: "string", index: false, optional: true },
    { name: "available", type: "bool", optional: true },
  ],
};

// Server-side search used by /api/search. Returns null when Typesense isn't
// configured so the caller can fall back to the DB.
export async function typesenseSearch(q, { limit = 8 } = {}) {
  const client = getAdminClient();
  if (!client) return null;

  const r = await client
    .collections(PRODUCTS_COLLECTION)
    .documents()
    .search({
      q,
      query_by: SEARCH_QUERY_BY,
      per_page: limit,
      num_typos: 2,
      prioritize_exact_match: true,
    });

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
