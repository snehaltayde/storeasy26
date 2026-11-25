// Phase 4 line 4: what API v1 answers, over the existing readers (no new SQL).
// SERVER-ONLY, tenant-scoped. Every shape is an allowlist: a column added to a
// table later never reaches an app by accident.
//
// Orders are always redacted as for support (owner decision, Phase 4): no
// customer field ever appears (not even as a null key), and cart_id and
// idempotency_key never do.
//
// Paging: ?limit= (1–100, default 50) and ?cursor= (the nextCursor of the
// previous page). Orders page by (created_at, id); the other lists by position.
import { cardRows, productPage } from "../catalog/effective.js";
import { listCollections } from "../admin/catalog-browse.js";
import { getActiveOffers, listOffers } from "../offers/store.js";
import { listOrders } from "../admin/orders.js";
import { redactOrderForRole } from "../admin/order-view.js";
import { getOrder } from "../orders.js";
import { ApiError } from "./api-auth.js";

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

export function pageArgs(request) {
  const q = new URL(request.url).searchParams;
  const rawLimit = q.get("limit");
  let limit = PAGE_DEFAULT;
  if (rawLimit !== null && rawLimit !== "") {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new ApiError(400, `limit must be a whole number from 1 to ${PAGE_MAX}.`, "BAD_LIMIT");
  }
  return { limit, cursor: q.get("cursor") || null, query: q };
}

// position cursors: "p<offset>" as base64url, opaque to callers
const encodeOffset = (n) => Buffer.from(`p${n}`, "utf8").toString("base64url");
function decodeOffset(cursor) {
  if (!cursor) return 0;
  const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
  const m = /^p(\d{1,7})$/.exec(raw);
  if (!m) throw new ApiError(400, "That cursor isn't one this API gave out. Start again without it.", "BAD_CURSOR");
  return Number(m[1]);
}
function slicePage(all, { limit, cursor }) {
  const from = decodeOffset(cursor);
  const items = all.slice(from, from + limit);
  return { items, nextCursor: from + limit < all.length ? encodeOffset(from + limit) : null };
}

export function me(app) {
  return { app: { id: app.id, name: app.name }, scopes: app.scopes, store: app.store };
}

const PRODUCT_CARD = ["id", "handle", "title", "display_type", "price_min", "price_max", "compare_at_min", "currency", "available", "featured_image", "featured_image_alt"];

export async function products(request) {
  const { limit, cursor } = pageArgs(request);
  const from = decodeOffset(cursor);
  const rows = await cardRows({ order: "title", limit: limit + 1, offset: from });
  const more = rows.length > limit;
  return { items: rows.slice(0, limit).map((r) => pick(r, PRODUCT_CARD)), nextCursor: more ? encodeOffset(from + limit) : null };
}

export async function product(handle) {
  const p = typeof handle === "string" && handle && handle.length <= 255 ? await productPage(handle) : null;
  if (!p) return null;
  return {
    product: {
      ...pick(p, [...PRODUCT_CARD, "display_vendor", "description", "description_html", "options", "created_at", "updated_at"]),
      images: (p.images || []).map((i) => pick(i, ["url", "alt", "width", "height", "position"])),
      variants: (p.variants || []).map((v) => ({ ...pick(v, ["id", "title", "sku", "price", "compare_at_price", "currency", "available", "image_url", "position"]), selected_options: v.selectedOptions ?? [] })),
    },
  };
}

export async function collections(request) {
  const args = pageArgs(request);
  const { items } = await listCollections();
  const page = slicePage(items, args);
  return { items: page.items.map((c) => pick(c, ["id", "handle", "title", "products"])), nextCursor: page.nextCursor };
}

// Live offers only (owner decision, Phase 4 line 4): enabled and inside their
// start/end window, by getActiveOffers' own rule. Terms are what a shopper
// can learn from the store (what qualifies and what it gives); a coupon's
// code and the engine's priority, scope and stacking switches are left out.
const OFFER_TERMS = ["title", "target", "buy", "free", "tiers", "discount", "threshold", "minSubtotal", "gift", "items", "price"];
export async function offers(request) {
  const args = pageArgs(request);
  const live = new Set((await getActiveOffers()).map((o) => o.id));
  const page = slicePage((await listOffers()).filter((o) => live.has(o.id)), args);
  return { items: page.items.map((o) => ({ ...pick(o, ["id", "type", "label", "starts_at", "ends_at", "updated_at"]), terms: pick(o.config, OFFER_TERMS) })), nextCursor: page.nextCursor };
}

// What an order may show an app: state and money, never who bought it.
const ORDER_FIELDS = ["id", "status", "payment_method", "payment_status", "subtotal", "discount_total", "shipping_total", "total", "currency", "coupon_code", "shopify_order_id", "created_at", "updated_at", "paid_at", "synced_at"];
const ITEM_FIELDS = ["product_id", "variant_id", "title", "variant_title", "image", "unit_price", "quantity", "line_total", "line_discount", "is_gift", "position"];

export function orderForApp(order, { withItems = false } = {}) {
  const red = redactOrderForRole(order, "support");
  const out = pick(red, ORDER_FIELDS);
  if (Array.isArray(red.appliedOffers)) out.applied_offers = red.appliedOffers;
  if (withItems) out.items = (red.items || []).map((i) => ({ ...pick(i, ITEM_FIELDS), is_gift: Boolean(i.is_gift) }));
  return out;
}

export async function orders(request) {
  const { limit, cursor, query } = pageArgs(request);
  const r = await listOrders({ status: query.get("status") || null, before: cursor, limit, piiSearch: false });
  return { items: r.orders.map((o) => orderForApp(o)), nextCursor: r.nextBefore };
}

export async function order(id) {
  const o = typeof id === "string" && id && id.length <= 64 ? await getOrder(id) : null;
  return o ? { order: orderForApp(o, { withItems: true }) } : null;
}
