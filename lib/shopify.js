// Shopify Storefront API client. Plain fetch + GraphQL — no SDK needed.
// Used only by the sync script (server side); never shipped to the browser.

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

function endpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is not set (.env.local)");
  return `https://${domain}/api/${API_VERSION}/graphql.json`;
}

// Prefer the server-side PRIVATE token (higher rate limits, used by the sync);
// fall back to a PUBLIC token. The two use different request headers.
function authHeaders() {
  const privateToken = process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN;
  const publicToken = process.env.SHOPIFY_STOREFRONT_TOKEN;
  if (privateToken) return { "Shopify-Storefront-Private-Token": privateToken };
  if (publicToken) return { "X-Shopify-Storefront-Access-Token": publicToken };
  throw new Error(
    "No Storefront token set — add SHOPIFY_STOREFRONT_PRIVATE_TOKEN (preferred) or SHOPIFY_STOREFRONT_TOKEN to .env.local",
  );
}

export async function shopifyFetch(query, variables = {}) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(),
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

const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $cursor: String) {
    products(first: $first, after: $cursor, sortKey: BEST_SELLING) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const COLLECTIONS_QUERY = /* GraphQL */ `
  query Collections($first: Int!, $cursor: String, $productsFirst: Int!) {
    collections(first: $first, after: $cursor, sortKey: UPDATED_AT) {
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

export async function fetchAllProducts({ pageSize = 50, onPage } = {}) {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const data = await shopifyFetch(PRODUCTS_QUERY, { first: pageSize, cursor });
    const conn = data.products;
    all.push(...conn.nodes);
    page += 1;
    if (onPage) onPage(all.length, page);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

export async function fetchAllCollections({ pageSize = 50, productsFirst = 250, onPage } = {}) {
  const all = [];
  let cursor = null;
  let page = 0;
  do {
    const data = await shopifyFetch(COLLECTIONS_QUERY, {
      first: pageSize,
      cursor,
      productsFirst,
    });
    const conn = data.collections;
    all.push(...conn.nodes);
    page += 1;
    if (onPage) onPage(all.length, page);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}
