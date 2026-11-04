// P4-EDITOR (OVL-04, ED-12, ED-02): how the editor opens a product's or a
// collection's content (/admin/editor?product=<gid>, ?collection=<gid>), and
// what it shows beside it. The editor page (a server component) calls this,
// so the browser never has to ask for it: the document editor gets the
// answer as a prop and never calls openEntityContent itself (P4-PICKER
// review: a read-only person used to see "Loading Shopify's images…" forever).
//
//   entityEntry({ type, entityId, actor })
//     -> { document, entity, readOnly, error }
//     A person who can edit (storefront.write) goes through openEntityContent
//     (it finds the document, makes it with its deterministic id, or brings an
//     archived one back). Anyone else gets readEntityContent: reads only,
//     never a write; a product with no content yet opens as an empty,
//     read-only form with Shopify's values.
//       document  { id, type, label, slug } for the editor (editor-entry's
//                 shape), or null when the target can't be opened
//       entity    readEntityContent's answer (below), or null
//       readOnly  plain words when this person can look but not change
//       error     plain words when the product or collection can't be opened
//
//   readEntityContent({ type, entityId })
//     -> { document | null, inShopify, shopify, titleEditable,
//          titleBlockedReason, shopifyAdminUrl, commerce }
//     The same shape openEntityContent answers, plus `commerce` (what Shopify
//     owns and the editor shows read-only: price, variants and stock).
//     READS ONLY: two or three SELECTs, nothing written.
//
//   shopifyCommerce(productId) -> { priceMin, priceMax, compareAtMin, currency,
//     available, totalInventory, variants: [{ title, sku, price, compareAt,
//     available }] } | null
//
// Node console routes only (the editor page runs on nodejs). No node: imports
// here anyway.
import { libsql } from "../db.js";
import * as Docs from "../documents/service.js";
import { productDocumentId, collectionDocumentId } from "../documents/ids.js";
import { titleGate, TITLE_GATE_MESSAGE } from "../catalog/title-gate.js";
import { shopifyAdminUrl } from "./shopify-admin-url.js";
import { roleAllows } from "../platform/authz.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[A-Za-z0-9._~-]{1,64}$/;
const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/[A-Za-z0-9._~-]{1,64}$/;
export const ENTITY_TYPES = Object.freeze(["product_content", "collection_content"]);

export const ENTRY_WORDS = Object.freeze({
  readOnly: "You can look at this, but your role can't change it. Ask the store owner or an admin.",
  productGone: "That product isn't in your Shopify catalog, so there is nothing to open. Pick it again from the product list.",
  collectionGone: "That collection isn't in your Shopify catalog, so there is nothing to open. Pick it again from the collection list.",
  failed: "We couldn't open that. Check your internet connection, then reload.",
});

const num = (v) => (v == null ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

export async function shopifyCommerce(productId) {
  if (typeof productId !== "string" || !productId) return null;
  const r = await libsql.execute({ sql: "SELECT price_min, price_max, compare_at_min, currency, available, total_inventory FROM products WHERE id = ?", args: [productId] });
  const p = r.rows[0];
  if (!p) return null;
  const v = await libsql.execute({ sql: "SELECT title, sku, price, compare_at_price, currency, available FROM variants WHERE product_id = ? ORDER BY position, id LIMIT 100", args: [productId] });
  return {
    priceMin: num(p.price_min),
    priceMax: num(p.price_max),
    compareAtMin: num(p.compare_at_min),
    currency: str(p.currency),
    available: Number(p.available) === 1,
    totalInventory: num(p.total_inventory),
    variants: v.rows.map((x) => ({ title: str(x.title), sku: str(x.sku), price: num(x.price), compareAt: num(x.compare_at_price), currency: str(x.currency), available: Number(x.available) === 1 })),
  };
}

// The document of an entity, found by its deterministic id first, then by
// (type, entity_id) for a phase-3 random-id row. Reads only.
async function findEntityDocument(type, entityId) {
  const id = type === "product_content" ? await productDocumentId(entityId) : await collectionDocumentId(entityId);
  try {
    return await Docs.getDocument(id);
  } catch (e) {
    if (e?.status !== 404 && e?.name !== "NotFoundError" && e?.code !== "NOT_FOUND") throw e;
  }
  const rows = await Docs.listDocuments({ type, includeArchived: true });
  const row = rows.find((d) => d.entityId === entityId);
  return row ? Docs.getDocument(row.id) : null;
}

function shopifySide(type, shop) {
  if (!shop) return null;
  if (type === "product_content") {
    return { title: shop.title, handle: shop.handle, description_html: shop.description_html, vendor: shop.vendor, product_type: shop.product_type, gallery: shop.images.map((i) => ({ media: i.url, alt: i.alt })) };
  }
  return { title: shop.title, handle: shop.handle };
}

const validTarget = (type, entityId) => ENTITY_TYPES.includes(type) && typeof entityId === "string" && (type === "product_content" ? PRODUCT_GID : COLLECTION_GID).test(entityId);

export async function readEntityContent({ type, entityId } = {}) {
  if (!validTarget(type, entityId)) return null;
  const shop = type === "product_content" ? await Docs.rawProduct(entityId) : await Docs.rawCollection(entityId);
  const doc = await findEntityDocument(type, entityId);
  const gate = type === "product_content" ? titleGate() : { blocked: false, reason: null };
  return {
    document: doc ? Docs.publicDocument(doc) : null,
    inShopify: shop != null,
    shopify: shopifySide(type, shop),
    titleEditable: !gate.blocked,
    titleBlockedReason: gate.blocked ? gate.reason || TITLE_GATE_MESSAGE : null,
    shopifyAdminUrl: shopifyAdminUrl(type === "product_content" ? { product: entityId } : { collection: entityId }),
    commerce: type === "product_content" && shop ? await shopifyCommerce(entityId) : null,
  };
}

const entryOf = (d) => (isObj(d) ? { id: String(d.id), type: String(d.type), label: String(d.label ?? ""), slug: d.slug == null ? null : String(d.slug) } : null);

export const canEdit = (actor) => roleAllows(actor?.role, "storefront.write");

export async function entityEntry({ type, entityId, actor = null } = {}) {
  const gone = type === "collection_content" ? ENTRY_WORDS.collectionGone : ENTRY_WORDS.productGone;
  if (!validTarget(type, entityId)) return { document: null, entity: null, readOnly: null, error: gone };
  if (canEdit(actor)) {
    try {
      const a = await Docs.openEntityContent({ type, entityId, actor });
      const commerce = type === "product_content" && a.inShopify ? await shopifyCommerce(entityId) : null;
      const { created: _c, unarchived: _u, ...rest } = a;
      return { document: entryOf(a.document), entity: { ...rest, commerce }, readOnly: null, error: null };
    } catch (e) {
      if (e?.status === 404 || e?.code === "NOT_FOUND" || e?.name === "NotFoundError") return { document: null, entity: null, readOnly: null, error: gone };
      if (typeof e?.status === "number" && e.status < 500 && typeof e.message === "string") return { document: null, entity: null, readOnly: null, error: e.message };
      throw e;
    }
  }
  const entity = await readEntityContent({ type, entityId });
  if (!entity || (!entity.document && !entity.inShopify)) return { document: null, entity: null, readOnly: ENTRY_WORDS.readOnly, error: gone };
  const id = entity.document ? entity.document.id : type === "product_content" ? await productDocumentId(entityId) : await collectionDocumentId(entityId);
  const label = entity.document?.label || entity.shopify?.title || "";
  return { document: { id, type, label, slug: null }, entity, readOnly: ENTRY_WORDS.readOnly, error: null };
}

// For ?doc=<id> of a product or collection content document (an older link,
// the publish panel): what Shopify sends now, read only.
export async function entityForDocument(row) {
  if (!isObj(row) || !ENTITY_TYPES.includes(row.type) || typeof row.entityId !== "string") return null;
  return readEntityContent({ type: row.type, entityId: row.entityId });
}
