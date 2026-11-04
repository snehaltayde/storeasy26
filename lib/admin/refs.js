// Resource-reference read model (S53 / B1). ONE narrow, paginated selection
// API for the console's pickers — products, collections, variants — so no
// picker ever reuses the 30-product admin catalog endpoint or asks a merchant
// to paste a GID. Node-safe handler (route wraps it; scripts/test-refs.js
// exercises it directly), tenant scope comes from the surrounding tenant
// context (host-resolved), never from the request body.
//
//   GET /api/admin/refs?type=product|collection|variant
//     &q=            search: title/handle contains; products also match SKU
//     &cursor=       opaque keyset cursor from the previous page
//     &limit=        page size, 1..50 (default 25)
//     &ids=a,b,c     hydrate SELECTED ids regardless of q/cursor — unknown
//                    ids come back as {id, missing:true} so a picker can show
//                    (not silently drop) selections the catalog lost
//     &product=      (type=variant) the product whose variants to list
//     &collection=   (type=product) restrict to that collection's members
//
// → { ok, items, nextCursor, syncedAt } — syncedAt = the catalog's last
//   successful sync write, so pickers can show freshness honestly.
//
// P4-SEARCH (OVL-05, OVL-06): a product's `title` is the PUBLISHED name
// shoppers see (product_content_live over Shopify's, never a draft), and
// `shopify_title` is Shopify's own name when it differs, for the
// picker's secondary line. Products are searched (q: the published name,
// Shopify's name, the handle or a SKU) and sorted on the published name; the
// cursor encodes that COALESCE value and the id. shopify_title is left out
// when the names agree, so a store with no live rows (or from before migration
// 0024) answers exactly as before.
import { sql } from "kysely";
import { requireAdmin } from "../admin-auth.js";
import { db } from "../db.js";
import { liveTableReady } from "../catalog/effective.js";

const LIMIT_MAX = 50;

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s) => {
  try {
    return Buffer.from(String(s), "base64url").toString("utf8");
  } catch {
    return null;
  }
};
const encodeCursor = (title, id) => b64url(JSON.stringify([title ?? "", id]));
const decodeCursor = (cursor) => {
  const raw = unb64url(cursor);
  try {
    const [title, id] = JSON.parse(raw);
    return typeof id === "string" ? { title: String(title ?? ""), id } : null;
  } catch {
    return null;
  }
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s ?? "");
  } catch {
    return fallback;
  }
};

const productItem = (r) => ({
  id: r.id,
  handle: r.handle,
  title: r.title,
  thumb: r.featured_image || null,
  status: r.available ? "available" : "unavailable",
  price_min: r.price_min ?? null,
  currency: r.currency || null,
  // only when the published name differs: a store with no live rows answers
  // exactly as before
  ...(r.shopify_title != null && r.shopify_title !== r.title ? { shopify_title: r.shopify_title } : {}),
});

const collectionItem = (r) => ({
  id: r.id,
  handle: r.handle,
  title: r.title,
  thumb: r.image || null,
  status: "available",
  product_count: Number(r.product_count ?? 0),
});

const variantItem = (r) => ({
  id: r.id,
  product_id: r.product_id,
  title: r.title || "Default",
  sku: r.sku || null,
  status: r.available ? "available" : "unavailable",
  price: r.price ?? null,
  currency: r.currency || null,
  options: parseJson(r.selected_options, []),
  thumb: r.image_url || null,
});

async function syncedAt() {
  try {
    const row = await db.selectFrom("products").select(({ fn }) => fn.max("synced_at").as("t")).executeTakeFirst();
    return row?.t || null;
  } catch {
    return null;
  }
}

// Hydration: selected ids in the CALLER's order, with explicit missing markers.
// The published name over Shopify's (live: the store has the live table).
const titleSql = (live) => sql.raw(live ? "COALESCE(c.title, p.title)" : "p.title");
const imageSql = (live) => sql.raw(live ? "CASE WHEN c.featured_image IS NOT NULL OR c.gallery IS NOT NULL THEN c.featured_image ELSE p.featured_image END" : "p.featured_image");
const withLive = (live) => (q) => (live ? q.leftJoin("product_content_live as c", "c.product_id", "p.id") : q);
function productRows(live) {
  return db
    .selectFrom("products as p")
    .$call(withLive(live))
    .select(["p.id", "p.handle", "p.available", "p.price_min", "p.currency"])
    .select(titleSql(live).as("title"))
    .select(sql.raw("p.title").as("shopify_title"))
    .select(imageSql(live).as("featured_image"));
}

async function hydrate(type, ids) {
  const table = type === "collection" ? "collections" : type === "variant" ? "variants" : "products";
  let rows = [];
  if (ids.length && type === "product") rows = await productRows(await liveTableReady()).where("p.id", "in", ids).execute();
  else if (ids.length) rows = await db.selectFrom(table).selectAll().where("id", "in", ids).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const shape = type === "collection" ? collectionItem : type === "variant" ? variantItem : productItem;
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { id, missing: true };
    if (type === "collection") return shape({ ...r, product_count: null });
    return shape(r);
  });
}

export async function handleRefsGet(request) {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  let params;
  try {
    params = new URL(request.url, "http://local.invalid").searchParams;
  } catch {
    return { status: 400, body: { error: "Bad request URL" } };
  }
  const type = params.get("type") || "product";
  if (!["product", "collection", "variant"].includes(type)) {
    return { status: 400, body: { error: "type must be product, collection or variant" } };
  }
  const limit = Math.min(Math.max(1, Number(params.get("limit")) || 25), LIMIT_MAX);
  const q = String(params.get("q") || "").trim();
  const ids = String(params.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);

  try {
    if (ids.length) {
      return { status: 200, body: { ok: true, items: await hydrate(type, ids), nextCursor: null, syncedAt: await syncedAt() } };
    }

    if (type === "variant") {
      const productId = params.get("product");
      if (!productId) return { status: 400, body: { error: "type=variant needs ?product=<product id>" } };
      const rows = await db
        .selectFrom("variants")
        .selectAll()
        .where("product_id", "=", productId)
        .orderBy("position", "asc")
        .orderBy("id", "asc")
        .limit(500) // variants of ONE product — complete by design (post-B1 sync has no 50 cap)
        .execute();
      return { status: 200, body: { ok: true, items: rows.map(variantItem), nextCursor: null, syncedAt: await syncedAt() } };
    }

    const after = params.get("cursor") ? decodeCursor(params.get("cursor")) : null;
    if (params.get("cursor") && !after) return { status: 400, body: { error: "Bad cursor" } };

    if (type === "collection") {
      let query = db
        .selectFrom("collections as c")
        .leftJoin("collection_products as cp", "cp.collection_id", "c.id")
        .select(["c.id", "c.handle", "c.title", "c.image"])
        .select(({ fn }) => fn.count("cp.product_id").as("product_count"))
        .groupBy(["c.id", "c.handle", "c.title", "c.image"])
        .orderBy("c.title", "asc")
        .orderBy("c.id", "asc")
        .limit(limit + 1);
      if (q) {
        const needle = `%${q}%`;
        query = query.where((eb) => eb.or([eb("c.title", "like", needle), eb("c.handle", "like", needle)]));
      }
      if (after) {
        query = query.where((eb) =>
          eb.or([eb("c.title", ">", after.title), eb.and([eb("c.title", "=", after.title), eb("c.id", ">", after.id)])]),
        );
      }
      const rows = await query.execute();
      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].title, page[page.length - 1].id) : null;
      return { status: 200, body: { ok: true, items: page.map(collectionItem), nextCursor, syncedAt: await syncedAt() } };
    }

    // products (optionally restricted to one collection's members), on the
    // published name (P4-SEARCH)
    const live = await liveTableReady();
    const title = titleSql(live);
    let query = productRows(live)
      .orderBy(title, "asc")
      .orderBy("p.id", "asc")
      .limit(limit + 1);
    const collectionId = params.get("collection");
    if (collectionId) {
      query = query
        .innerJoin("collection_products as cp", "cp.product_id", "p.id")
        .where("cp.collection_id", "=", collectionId);
    }
    if (q) {
      const needle = `%${q}%`;
      query = query.where((eb) =>
        eb.or([
          eb(title, "like", needle),
          eb("p.title", "like", needle),
          eb("p.handle", "like", needle),
          eb.exists(
            eb
              .selectFrom("variants as v")
              .select("v.id")
              .whereRef("v.product_id", "=", "p.id")
              .where("v.sku", "like", needle),
          ),
        ]),
      );
    }
    if (after) {
      query = query.where((eb) => eb.or([eb(title, ">", after.title), eb.and([eb(title, "=", after.title), eb("p.id", ">", after.id)])]));
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].title, page[page.length - 1].id) : null;
    return { status: 200, body: { ok: true, items: page.map(productItem), nextCursor, syncedAt: await syncedAt() } };
  } catch (e) {
    return { status: 500, body: { error: String(e?.message || e).slice(0, 200) } };
  }
}
