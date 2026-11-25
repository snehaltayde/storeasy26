// The merchant console's Catalog page (Phase 2 line 3, docs/plans/phase-2.md
// "Line 3"): browse products and collections, read-only. Shopify owns the
// catalog values; the names shoppers see and the content state come from the
// editor's own list (lib/admin/product-content-list.js). Nothing here writes.
// Node console routes only; every call runs inside the caller's store.
//
//   browseProducts({ q, filter, available, cursor })
//     -> { items, nextCursor, counts, total }   50 a page
//     items[] the editor list's item plus { productType, priceMin, priceMax,
//             currency, available, totalInventory, content }
//   productDetail(gid) -> null | { product, variants, collections, published }
//   listCollections()  -> { items: [{ id, handle, title, products, pinned }], published }
//   collectionProducts(gid, cursor) -> null | { collection, items, nextCursor, total }
//   catalogHeader({ products }) -> { lastSyncedAt, lastSynced, products, sync }
//
// `published` is "ok", or "unavailable" when the published release can't be
// read (UNAVAILABLE_NOTE): modules, badge and pinned counts are then absent,
// and the products themselves are still listed.
import { sql } from "kysely";
import { db } from "../db.js";
import { numericId } from "../ids.js";
import { slog } from "../log.js";
import { liveTableReady } from "../catalog/effective.js";
import { publishedGetters } from "../cms/view.js";
import { shopifyAdminBase } from "./shopify-admin-url.js";
import { entityEditorHref, isCollectionGid, isProductGid } from "./editor-entry.js";
import { listProductContent, pageFacts, BROWSE_FILTERS, encodeListCursor, decodeListCursor } from "./product-content-list.js";
import { ago } from "./sync-view.js";

export const BROWSE_PAGE = 50;
export { BROWSE_FILTERS };
// the stock filter's words in a URL -> listProductContent's `available`
export const STOCK_FILTERS = Object.freeze({ any: null, in_stock: true, sold_out: false });
export const UNAVAILABLE_NOTE = "We couldn't read what's published right now, so modules, badges, templates and pinned products aren't shown here. The products themselves are listed.";

function unavailable(e, part) {
  slog("catalog_published_unreadable", { part, error: String(e?.message || e).slice(0, 300) });
  return null;
}

const storePath = (kind, handle) => (handle ? `/${kind}/${encodeURIComponent(handle)}` : null);
const shopifyUrl = (kind, gid) => {
  const base = shopifyAdminBase();
  return base && gid ? `${base}/${kind}/${numericId(gid)}` : null;
};

export async function browseProducts({ q = "", filter = "all", available = null, cursor = null } = {}) {
  const list = await listProductContent({ q, filter, available, cursor, limit: BROWSE_PAGE, withTotal: true });
  const facts = await pageFacts(list.items.filter((i) => i.inShopify).map((i) => i.productId));
  const items = list.items.map((i) => {
    const f = facts.get(i.productId);
    return {
      ...i,
      productType: f?.productType ?? null,
      priceMin: f?.priceMin ?? null,
      priceMax: f?.priceMax ?? null,
      currency: f?.currency ?? null,
      available: f ? f.available : null,
      totalInventory: f?.totalInventory ?? null,
      content: i.inShopify ? (f?.content ?? "shopify_only") : "gone",
    };
  });
  return { items, nextCursor: list.nextCursor, counts: list.counts, total: list.total };
}

async function liveTitle(gid) {
  if (!(await liveTableReady())) return null;
  const r = await db.selectFrom("product_content_live").select("title").where("product_id", "=", gid).executeTakeFirst();
  return r?.title || null;
}

export async function productDetail(gid) {
  if (!isProductGid(gid)) return null;
  const p = await db.selectFrom("products").select(["id", "handle", "title", "featured_image"]).where("id", "=", gid).executeTakeFirst();
  if (!p) return null;
  const [variants, collections, title, facts, getters] = await Promise.all([
    db.selectFrom("variants").select(["id", "title", "sku", "price", "currency", "available"]).where("product_id", "=", gid).orderBy("position").orderBy("id").execute(),
    db
      .selectFrom("collection_products as cp")
      .innerJoin("collections as c", "c.id", "cp.collection_id")
      .select(["c.id", "c.handle", "c.title"])
      .where("cp.product_id", "=", gid)
      .orderBy("c.title")
      .execute(),
    liveTitle(gid),
    pageFacts([gid]),
    publishedGetters().catch((e) => unavailable(e, "release")),
  ]);
  const f = facts.get(gid);
  const override = getters ? await getters.resolvedProductOverride(gid).catch((e) => unavailable(e, "product")) : null;
  return {
    product: {
      id: p.id,
      handle: p.handle,
      title: title || p.title,
      shopifyTitle: title && title !== p.title ? p.title : null,
      image: p.featured_image || null,
      productType: f?.productType ?? null,
      vendor: f?.vendor ?? null,
      priceMin: f?.priceMin ?? null,
      priceMax: f?.priceMax ?? null,
      currency: f?.currency ?? null,
      available: !!f?.available,
      totalInventory: f?.totalInventory ?? null,
      content: f?.content ?? "shopify_only",
      editorHref: entityEditorHref({ product: p.id }),
      storeUrl: storePath("products", p.handle),
      shopifyUrl: shopifyUrl("products", p.id),
    },
    variants: variants.map((v) => ({ id: v.id, title: v.title || "", sku: v.sku || null, price: v.price == null ? null : Number(v.price), currency: v.currency || f?.currency || null, available: !!Number(v.available) })),
    collections: collections.map((c) => ({ id: c.id, handle: c.handle, title: c.title })),
    published: override ? { state: "ok", badge: override.badge || "", modules: override.modules.map((m) => m.title) } : { state: "unavailable", note: UNAVAILABLE_NOTE },
  };
}

// members that are in the catalog (a membership row can outlive its product)
const productCount = sql`(SELECT count(*) FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id = c.id)`;

async function pinCounts(handles) {
  const getters = await publishedGetters().catch((e) => unavailable(e, "release"));
  if (!getters) return null;
  try {
    const out = new Map();
    for (let i = 0; i < handles.length; i += 8) {
      const part = handles.slice(i, i + 8);
      const lists = await Promise.all(part.map((h) => getters.resolvedCollectionPins(h)));
      part.forEach((h, j) => out.set(h, lists[j].length));
    }
    return out;
  } catch (e) {
    return unavailable(e, "list");
  }
}

export async function listCollections() {
  const rows = await db.selectFrom("collections as c").select(["c.id", "c.handle", "c.title"]).select(productCount.as("products")).orderBy("c.title").orderBy("c.id").execute();
  const pins = await pinCounts(rows.map((r) => r.handle));
  return {
    items: rows.map((r) => ({ id: r.id, handle: r.handle, title: r.title, products: Number(r.products || 0), pinned: pins ? pins.get(r.handle) || 0 : null })),
    published: pins ? "ok" : "unavailable",
    ...(pins ? {} : { note: UNAVAILABLE_NOTE }),
  };
}

// A collection's products in Shopify's order (position, then id), 50 a page.
// The cursor carries the last row's position and id.
export async function collectionProducts(gid, cursor = null) {
  if (!isCollectionGid(gid)) return null;
  const c = await db.selectFrom("collections as c").select(["c.id", "c.handle", "c.title"]).select(productCount.as("products")).where("c.id", "=", gid).executeTakeFirst();
  if (!c) return null;
  const after = cursor ? decodeListCursor(cursor) : null;
  if (cursor && (!after || !/^-?\d+$/.test(after.title))) throw new TypeError("collectionProducts: bad cursor");
  const live = await liveTableReady();
  let q = db
    .selectFrom("collection_products as cp")
    .innerJoin("products as p", "p.id", "cp.product_id")
    .$call((x) => (live ? x.leftJoin("product_content_live as l", "l.product_id", "p.id") : x))
    .select(["p.id", "p.handle", "p.featured_image", "cp.position"])
    .select(sql.raw(live ? "COALESCE(l.title, p.title)" : "p.title").as("title"))
    .where("cp.collection_id", "=", gid)
    .orderBy("cp.position")
    .orderBy("p.id")
    .limit(BROWSE_PAGE + 1);
  if (after) {
    const pos = Number(after.title);
    q = q.where((eb) => eb.or([eb("cp.position", ">", pos), eb.and([eb("cp.position", "=", pos), eb("p.id", ">", after.id)])]));
  }
  const rows = await q.execute();
  const page = rows.slice(0, BROWSE_PAGE);
  const facts = await pageFacts(page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    collection: {
      id: c.id,
      handle: c.handle,
      title: c.title,
      products: Number(c.products || 0),
      editorHref: entityEditorHref({ collection: c.id }),
      storeUrl: storePath("collections", c.handle),
      shopifyUrl: shopifyUrl("collections", c.id),
    },
    items: page.map((r) => {
      const f = facts.get(String(r.id));
      return {
        productId: r.id,
        handle: r.handle,
        title: r.title,
        thumb: r.featured_image || null,
        position: Number(r.position),
        priceMin: f?.priceMin ?? null,
        priceMax: f?.priceMax ?? null,
        currency: f?.currency ?? null,
        available: !!f?.available,
        content: f?.content ?? "shopify_only",
      };
    }),
    nextCursor: rows.length > BROWSE_PAGE ? encodeListCursor(String(last.position), String(last.id)) : null,
    total: Number(c.products || 0),
  };
}

// The header: when the catalog last came in from Shopify, and how many
// products the store has. `sync` is lib/admin/sync-view.js's view.
export async function catalogHeader({ products }) {
  const S = await import("../sync.js");
  const [confirmed, status] = await Promise.all([S.confirmedCatalogSync().catch(() => null), S.catalogSyncStatus().catch(() => null)]);
  const at = confirmed?.confirmed ? confirmed.finishedAt || null : null;
  return { lastSyncedAt: at, lastSynced: at ? ago(at) : null, products: Number(products || 0), sync: status?.view ?? null };
}
