// Pull the catalog from the Admin API and reshape it to match exactly what the
// Storefront fetchers return — so scripts/sync.js stays identical regardless of
// source. Used when only an Admin token is available (the common post-Jan-2026
// single-credential setup).
import { adminGraphql } from "./shopify-admin.js";

// GEN-02: sorted by ID, not UPDATED_AT. A resumable sync keeps its cursor for
// minutes or hours across ticks; under UPDATED_AT a product edited mid-sync
// jumps ahead of the cursor and is never seen (then pruned as stale). ID order
// only moves for new products, which land after the cursor and are seen.
const PRODUCTS_QUERY = /* GraphQL */ `
  query AdminProducts($cursor: String) {
    products(first: 30, after: $cursor, query: "status:active", sortKey: ID) {
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
          pageInfo { hasNextPage endCursor }
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

// S53 (B1): products can carry more than 50 variants — the first page used to
// be a silent cap ("every real variant is selectable" was untrue). Mirrors
// the collection-membership drain below.
const VARIANTS_PAGE = /* GraphQL */ `
  query ProductVariants($id: ID!, $cursor: String) {
    product(id: $id) {
      variants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title sku price compareAtPrice availableForSale inventoryQuantity
          selectedOptions { name value }
          image { url altText }
        }
      }
    }
  }
`;

async function drainVariantTail(p, gql) {
  let page = p.variants?.pageInfo;
  while (page?.hasNextPage) {
    const more = await gql(VARIANTS_PAGE, { id: p.id, cursor: page.endCursor });
    const conn = more.product?.variants;
    if (!conn) break;
    p.variants.nodes.push(...conn.nodes);
    page = conn.pageInfo;
  }
  return p;
}

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

// Session 21: single-entity fetchers for webhook-driven incremental sync —
// identical node selection + reshape as the full pull, so the write path is
// one code path. Returns null for missing/non-active (caller deletes).
// `gql` is injectable for tests.
const PRODUCT_NODE_FIELDS = /* GraphQL */ `
  id handle title description descriptionHtml productType vendor tags status
  totalInventory createdAt updatedAt
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  featuredImage { url altText }
  images(first: 10) { nodes { url altText width height } }
  options { name optionValues { name } }
  variants(first: 50) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku price compareAtPrice availableForSale inventoryQuantity
      selectedOptions { name value }
      image { url altText }
    }
  }
`;

export async function fetchProductAdmin(gid, { gql = adminGraphql } = {}) {
  const data = await gql(
    `query($id: ID!) { node(id: $id) { ... on Product { ${PRODUCT_NODE_FIELDS} } } }`,
    { id: gid },
  );
  const p = data?.node;
  if (!p?.id || (p.status && p.status !== "ACTIVE")) return null;
  return reshapeProduct(await drainVariantTail(p, gql));
}

export async function fetchCollectionAdmin(gid, { gql = adminGraphql } = {}) {
  const data = await gql(
    `query($id: ID!) { node(id: $id) { ... on Collection {
      id handle title description updatedAt
      image { url altText }
      products(first: 250) { pageInfo { hasNextPage endCursor } nodes { id } }
    } } }`,
    { id: gid },
  );
  const c = data?.node;
  if (!c?.id) return null;
  // drain >250-product tails exactly like the full sync
  let page = c.products?.pageInfo;
  while (page?.hasNextPage) {
    const more = await gql(COLLECTION_PRODUCTS_PAGE, { id: c.id, cursor: page.endCursor });
    const conn = more.collection?.products;
    if (!conn) break;
    c.products.nodes.push(...conn.nodes);
    page = conn.pageInfo;
  }
  return c;
}

// GEN-02: ONE page of active products, reshaped, variant tails drained.
// → { nodes, endCursor, hasNextPage }. The sync stores endCursor as its resume
// point and passes it back as `cursor` for the next page.
export async function fetchProductsPageAdmin({ cursor = null, gql = adminGraphql } = {}) {
  const data = await gql(PRODUCTS_QUERY, { cursor });
  const conn = data.products;
  const nodes = [];
  for (const node of conn.nodes) {
    // a node Shopify sent that we can't read is passed on marked, for the sync
    // to skip (Phase 1 line 5); a failed variant read still throws
    if (!node || typeof node !== "object") {
      nodes.push({ __unreadable: true, id: null, handle: null, title: null });
      continue;
    }
    const full = await drainVariantTail(node, gql); // S53: no 50-variant cap
    try {
      nodes.push(reshapeProduct(full));
    } catch {
      nodes.push({ __unreadable: true, id: typeof node.id === "string" ? node.id : null, handle: typeof node.handle === "string" ? node.handle : null, title: typeof node.title === "string" ? node.title : null });
    }
  }
  return { nodes, endCursor: conn.pageInfo.endCursor ?? null, hasNextPage: Boolean(conn.pageInfo.hasNextPage) };
}

// GEN-02: Shopify's count of active products, for "N of M" progress. Best
// effort: null when Shopify doesn't answer it. AT_LEAST means "M or more".
export async function countProductsAdmin({ gql = adminGraphql } = {}) {
  try {
    const data = await gql(`query AdminProductsCount { productsCount(query: "status:active") { count precision } }`, {});
    const c = data?.productsCount;
    if (!c || !Number.isFinite(Number(c.count))) return null;
    return { count: Number(c.count), atLeast: c.precision === "AT_LEAST" };
  } catch {
    return null;
  }
}

// Phase 1 line 5: Shopify's count of collections, for "N of M" progress.
// Best effort, like countProductsAdmin: null when Shopify doesn't answer it.
export async function countCollectionsAdmin({ gql = adminGraphql } = {}) {
  try {
    const data = await gql(`query AdminCollectionsCount { collectionsCount { count precision } }`, {});
    const c = data?.collectionsCount;
    if (!c || !Number.isFinite(Number(c.count))) return null;
    return { count: Number(c.count), atLeast: c.precision === "AT_LEAST" };
  } catch {
    return null;
  }
}

export async function fetchAllProductsAdmin({ onPage, gql = adminGraphql } = {}) {
  const all = [];
  let cursor = null;
  do {
    const page = await fetchProductsPageAdmin({ cursor, gql });
    all.push(...page.nodes);
    cursor = page.hasNextPage ? page.endCursor : null;
    if (onPage) onPage(all.length, cursor);
  } while (cursor);
  return all;
}

const COLLECTIONS_QUERY = /* GraphQL */ `
  query AdminCollections($cursor: String) {
    collections(first: 50, after: $cursor, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title description updatedAt
        image { url altText }
        products(first: 250) {
          pageInfo { hasNextPage endCursor }
          nodes { id }
        }
      }
    }
  }
`;

// Follow-up pagination for collections with >250 products (Session 16: the
// full catalog, no truncation — ~10 mega-collections previously capped).
const COLLECTION_PRODUCTS_PAGE = /* GraphQL */ `
  query CollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

// GEN-02: ONE page of collections → { nodes, endCursor, hasNextPage }, each
// with its first 250 members. `drainMembers` (default) also follows every
// long tail here (Session 16: full membership); the resumable sync passes
// false and drains tails one page per step instead (fetchCollectionMembersPageAdmin),
// so a 20,000-product collection can't make one step outrun its route.
export async function fetchCollectionsPageAdmin({ cursor = null, gql = adminGraphql, drainMembers = true } = {}) {
  const data = await gql(COLLECTIONS_QUERY, { cursor });
  const conn = data.collections;
  const nodes = conn.nodes; // already matches the sync's expected shape
  for (const c of drainMembers ? nodes : []) {
    let page = c.products?.pageInfo;
    while (page?.hasNextPage) {
      const more = await gql(COLLECTION_PRODUCTS_PAGE, { id: c.id, cursor: page.endCursor });
      const tail = more.collection?.products;
      if (!tail) break;
      c.products.nodes.push(...tail.nodes);
      page = tail.pageInfo;
    }
    if (c.products?.pageInfo) c.products.pageInfo.hasNextPage = false;
  }
  return { nodes, endCursor: conn.pageInfo.endCursor ?? null, hasNextPage: Boolean(conn.pageInfo.hasNextPage) };
}

// GEN-02: one more page (250) of a collection's members.
// → { nodes: [{id}], endCursor, hasNextPage }; a collection gone upstream
// reads as an empty last page.
export async function fetchCollectionMembersPageAdmin({ id, cursor, gql = adminGraphql }) {
  const data = await gql(COLLECTION_PRODUCTS_PAGE, { id, cursor });
  const conn = data.collection?.products;
  if (!conn) return { nodes: [], endCursor: null, hasNextPage: false };
  return { nodes: conn.nodes, endCursor: conn.pageInfo.endCursor ?? null, hasNextPage: Boolean(conn.pageInfo.hasNextPage) };
}

export async function fetchAllCollectionsAdmin({ onPage, gql = adminGraphql } = {}) {
  const all = [];
  let cursor = null;
  do {
    const page = await fetchCollectionsPageAdmin({ cursor, gql });
    all.push(...page.nodes);
    cursor = page.hasNextPage ? page.endCursor : null;
    if (onPage) onPage(all.length, cursor);
  } while (cursor);
  return all;
}
