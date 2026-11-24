// Shopify Storefront API client. Plain fetch + GraphQL — no SDK needed.
// Used only by the sync script (server side); never shipped to the browser.

import { shopifyBase } from "./shopify-origin.js";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

// S53 (audit A3): the client takes EXPLICIT credentials. `creds = null` keeps
// the env-configured legacy/_default store; a creds OBJECT is used verbatim —
// a tenant source must never silently borrow another shop's env config, so a
// provided-but-incomplete creds object throws instead of falling back to env.
function endpoint(creds) {
  const domain = creds ? creds.domain : process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) {
    throw new Error(creds ? "No Shopify store domain for this tenant" : "SHOPIFY_STORE_DOMAIN is not set (.env.local)");
  }
  return `${shopifyBase(domain)}/api/${API_VERSION}/graphql.json`;
}

// Prefer the server-side PRIVATE token (higher rate limits, used by the sync);
// fall back to a PUBLIC token. The two use different request headers.
function authHeaders(creds) {
  const privateToken = creds ? creds.privateToken : process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN;
  const publicToken = creds ? creds.publicToken : process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (privateToken) return { "Shopify-Storefront-Private-Token": privateToken };
  if (publicToken) return { "X-Shopify-Storefront-Access-Token": publicToken };
  throw new Error(
    creds
      ? "No Storefront token for this tenant"
      : "No Storefront token set — add SHOPIFY_STOREFRONT_PRIVATE_TOKEN (preferred) or SHOPIFY_STOREFRONT_TOKEN to .env.local",
  );
}

export async function shopifyFetch(query, variables = {}, creds = null) {
  const res = await fetch(endpoint(creds), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(creds),
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 600)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 600)}`);
  }
  return json.data;
}

const PRODUCT_FIELDS = /* GraphQL */ `
  id
  handle
  title
  description
  descriptionHtml
  productType
  vendor
  tags
  totalInventory
  availableForSale
  createdAt
  updatedAt
  priceRange {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  compareAtPriceRange {
    minVariantPrice { amount currencyCode }
  }
  featuredImage { url altText }
  images(first: 12) { nodes { url altText width height } }
  options { name values }
  variants(first: 100) {
    nodes {
      id
      title
      sku
      availableForSale
      price { amount currencyCode }
      compareAtPrice { amount currencyCode }
      selectedOptions { name value }
      image { url altText }
    }
  }
`;

// GEN-02: ID order, so a cursor kept across ticks stays valid. BEST_SELLING
// reshuffles as orders land, which skips or repeats products mid-sync. Nothing
// reads products in insertion order (every listing sorts explicitly).
const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $cursor: String) {
    products(first: $first, after: $cursor, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const COLLECTIONS_QUERY = /* GraphQL */ `
  query Collections($first: Int!, $cursor: String, $productsFirst: Int!) {
    collections(first: $first, after: $cursor, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        description
        updatedAt
        image { url altText }
        products(first: $productsFirst) {
          pageInfo { hasNextPage }
          nodes { id }
        }
      }
    }
  }
`;

// GEN-02: ONE page → { nodes, endCursor, hasNextPage }; the sync stores
// endCursor and passes it back as `cursor`.
export async function fetchProductsPage({ cursor = null, pageSize = 50, creds = null } = {}) {
  const data = await shopifyFetch(PRODUCTS_QUERY, { first: pageSize, cursor }, creds);
  const conn = data.products;
  return { nodes: conn.nodes, endCursor: conn.pageInfo.endCursor ?? null, hasNextPage: Boolean(conn.pageInfo.hasNextPage) };
}

export async function fetchCollectionsPage({ cursor = null, pageSize = 50, productsFirst = 250, creds = null } = {}) {
  const data = await shopifyFetch(COLLECTIONS_QUERY, { first: pageSize, cursor, productsFirst }, creds);
  const conn = data.collections;
  return { nodes: conn.nodes, endCursor: conn.pageInfo.endCursor ?? null, hasNextPage: Boolean(conn.pageInfo.hasNextPage) };
}

export async function fetchAllProducts({ pageSize = 50, onPage, creds = null } = {}) {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const res = await fetchProductsPage({ cursor, pageSize, creds });
    all.push(...res.nodes);
    page += 1;
    if (onPage) onPage(all.length, page);
    cursor = res.hasNextPage ? res.endCursor : null;
  } while (cursor);
  return all;
}

export async function fetchAllCollections({ pageSize = 50, productsFirst = 250, onPage, creds = null } = {}) {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const res = await fetchCollectionsPage({ cursor, pageSize, productsFirst, creds });
    all.push(...res.nodes);
    page += 1;
    if (onPage) onPage(all.length, page);
    cursor = res.hasNextPage ? res.endCursor : null;
  } while (cursor);
  return all;
}
