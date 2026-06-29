// Pull the catalog from the Admin API and reshape it to match exactly what the
// Storefront fetchers return — so scripts/sync.js stays identical regardless of
// source. Used when only an Admin token is available (the common post-Jan-2026
// single-credential setup).
import { adminGraphql } from "./shopify-admin.js";

const PRODUCTS_QUERY = /* GraphQL */ `
  query AdminProducts($cursor: String) {
    products(first: 30, after: $cursor, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title description descriptionHtml productType vendor tags
        totalInventory createdAt updatedAt
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        featuredImage { url altText }
        images(first: 10) { nodes { url altText width height } }
        options { name optionValues { name } }
        variants(first: 50) {
          nodes {
            id title sku price compareAtPrice availableForSale inventoryQuantity
            selectedOptions { name value }
            image { url altText }
          }
        }
      }
    }
  }
`;

function reshapeProduct(p) {
  const currency = p.priceRangeV2?.minVariantPrice?.currencyCode || "INR";
  const variantNodes = p.variants?.nodes || [];

  const compareAts = variantNodes
    .map((v) => (v.compareAtPrice != null ? Number(v.compareAtPrice) : null))
    .filter((x) => x != null && !Number.isNaN(x) && x > 0);
  const minCompareAt = compareAts.length ? Math.min(...compareAts) : null;

  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description || "",
    descriptionHtml: p.descriptionHtml || "",
    productType: p.productType || "",
    vendor: p.vendor || "",
    tags: p.tags || [],
    totalInventory: p.totalInventory ?? null,
    availableForSale: variantNodes.some((v) => v.availableForSale),
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
    priceRange: {
      minVariantPrice: p.priceRangeV2?.minVariantPrice || { amount: null, currencyCode: currency },
      maxVariantPrice: p.priceRangeV2?.maxVariantPrice || { amount: null, currencyCode: currency },
    },
    compareAtPriceRange: {
      minVariantPrice: { amount: minCompareAt, currencyCode: currency },
    },
    featuredImage: p.featuredImage || null,
    images: { nodes: p.images?.nodes || [] },
    options: (p.options || []).map((o) => ({
      name: o.name,
      values: (o.optionValues || []).map((ov) => ov.name),
    })),
    variants: {
      nodes: variantNodes.map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        availableForSale: v.availableForSale,
        price: { amount: v.price, currencyCode: currency },
        compareAtPrice: v.compareAtPrice ? { amount: v.compareAtPrice, currencyCode: currency } : null,
        selectedOptions: v.selectedOptions || [],
        image: v.image || null,
      })),
    },
  };
}

export async function fetchAllProductsAdmin({ onPage } = {}) {
  const all = [];
  let cursor = null;
  do {
    const data = await adminGraphql(PRODUCTS_QUERY, { cursor });
    const conn = data.products;
    all.push(...conn.nodes.map(reshapeProduct));
    if (onPage) onPage(all.length);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

const COLLECTIONS_QUERY = /* GraphQL */ `
  query AdminCollections($cursor: String) {
    collections(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title description updatedAt
        image { url altText }
        products(first: 250) {
          pageInfo { hasNextPage }
          nodes { id }
        }
      }
    }
  }
`;

export async function fetchAllCollectionsAdmin({ onPage } = {}) {
  const all = [];
  let cursor = null;
  do {
    const data = await adminGraphql(COLLECTIONS_QUERY, { cursor });
    const conn = data.collections;
    all.push(...conn.nodes); // already matches the sync's expected shape
    if (onPage) onPage(all.length);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}
