// P4-SEARCH (OVL-05, OVL-17): the ONE builder of a product's Typesense
// document. Pure and edge-safe: no imports, no database.
//
//   buildSearchDoc(row) -> the document lib/typesense.js's collection schema
//                          holds (productsCollectionSchema)
//
// `row` is one row of lib/catalog/effective.js indexRows(): the EFFECTIVE
// values a shopper sees (the founder's published name, type shown and brand
// shown over Shopify's), never a draft. Shopify's raw tags stay the tags
// (logic_tags), as they are for filters and offers. Both the full sync
// (lib/sync.js indexTypesense) and the one-product reindex
// (lib/catalog/search-reindex.js drainSearchOutbox) build through here, so a
// full sync can never put Shopify's old name back over a published one.
//
// The document id is the product's handle, as it always was: the storefront
// search links hits by handle, and deleting a product that left Shopify needs
// only the handle the outbox row stored.

const str = (v) => (v == null ? "" : String(v));

export function buildSearchDoc(row) {
  if (!row || typeof row !== "object" || !row.handle) throw new TypeError("buildSearchDoc: a product row with a handle is needed");
  const tags = Array.isArray(row.logic_tags) ? row.logic_tags.map(String) : [];
  const price = Number(row.price_min);
  return {
    id: String(row.handle),
    handle: String(row.handle),
    title: str(row.title),
    description: str(row.description),
    product_type: str(row.display_type),
    vendor: str(row.display_vendor),
    tags,
    image: str(row.featured_image),
    price: Number.isFinite(price) ? price : 0,
    currency: row.currency ? String(row.currency) : "INR",
    available: !!row.available,
  };
}
