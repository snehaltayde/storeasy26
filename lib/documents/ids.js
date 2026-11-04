// P2-ATOM (DOC-01): document, version, release and log ids.
//
// Edge-safe: Web Crypto only, no node: imports.
//
//   verId(), relId(), logId(), setId()  random ids, minted ONCE per publish
//                                       build, so a transport retry of the
//                                       same batch reuses them
//   singletonId(type)                   doc_<type>, deterministic
//   newRouteId()                        doc_ + 16 random base32 characters, for
//                                       page, campaign and journal documents
//                                       made in the editor
//   backfillRouteId(type, slug)         deterministic, for the backfill (MIG-01)
//                                       only, so running it twice gives the
//                                       same ids
//   productDocumentId(productId)        P4-SCAFFOLD: doc_prod_ + 16 hex,
//   collectionDocumentId(collectionId)  doc_coll_ + 16 hex; deterministic,
//                                       ASYNC (they return a Promise). Not
//                                       wired in yet.
//
// Editor-made route ids are random, not derived from the slug: a renamed or
// archived slug must be reusable by a new page without an id clash.

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex16 = () => hex(crypto.getRandomValues(new Uint8Array(8)));

export const verId = () => `ver_${randomHex16()}`;
export const relId = () => `rel_${randomHex16()}`;
export const logId = () => `log_${randomHex16()}`;
export const setId = () => `set_${randomHex16()}`;

const TYPE_RE = /^[a-z][a-z0-9_]*$/;

export function singletonId(type) {
  if (!TYPE_RE.test(String(type || ""))) throw new Error(`singletonId: "${type}" is not a document type name`);
  return `doc_${type}`;
}

// RFC 4648 base32, lower case. 256 is a multiple of 32, so `byte & 31` is
// unbiased.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newRouteId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "doc_";
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

export const ROUTE_TYPES = Object.freeze(["page", "campaign", "journal"]);

// cms_pages keys pages by slug across all families, so the slug alone is the
// stable source. The type is checked, not hashed: a page whose family changes
// between two backfill runs keeps its id.
export async function backfillRouteId(type, slug) {
  if (!ROUTE_TYPES.includes(type)) throw new Error(`backfillRouteId: "${type}" is not a route document type`);
  const s = String(slug ?? "");
  if (!s) throw new Error("backfillRouteId: the slug is empty");
  return `doc_p_${await sha256Hex16(`route:${s}`)}`;
}

// The first 16 hex characters of SHA-256(text), through Web Crypto (edge-safe).
async function sha256Hex16(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest)).slice(0, 16);
}

const entityId = (fn, id) => {
  const s = typeof id === "string" ? id : "";
  if (!s) throw new Error(`${fn}: the Shopify id is empty`);
  return s;
};

/**
 * P4-SCAFFOLD (OVL-02, spec 8.3): the product content document's id,
 * "doc_prod_" + the first 16 hex characters of SHA-256(productId). The same
 * product id always gives the same id, so the backfill and the editor agree
 * without a lookup.
 *
 * ASYNC: it uses Web Crypto, like backfillRouteId, so it returns a Promise.
 * Always `await productDocumentId(id)`.
 *
 * Not wired in yet: LIVEROW and CUTOVER use it, and they reuse an existing
 * phase-3 product_content row (random id) when one is there.
 * @param {string} productId the Shopify product gid
 * @returns {Promise<string>}
 */
export async function productDocumentId(productId) {
  return `doc_prod_${await sha256Hex16(entityId("productDocumentId", productId))}`;
}

/**
 * P4-SCAFFOLD (OVL-02, ED-12): the collection content document's id,
 * "doc_coll_" + the first 16 hex characters of SHA-256(collectionId).
 *
 * ASYNC: it returns a Promise. Always `await collectionDocumentId(id)`.
 * Not wired in yet.
 * @param {string} collectionId the Shopify collection gid
 * @returns {Promise<string>}
 */
export async function collectionDocumentId(collectionId) {
  return `doc_coll_${await sha256Hex16(entityId("collectionDocumentId", collectionId))}`;
}
