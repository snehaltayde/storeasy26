// P4-LIVEROW (OVL-02, OVL-07, ED-12, OVL-17; spec 8.2): what a published
// product or collection content document puts live, as rows of
// product_content_live and collection_content_live (migration 0024), and the
// search_outbox row that tells search a product changed. Pure apart from the
// statements it returns; edge-safe (no node: imports).
//
//   liveRowFor(type, body, { documentId, versionId, publishedAt, entityId? })
//     -> the row's columns (product_id or collection_id too when entityId is
//        given). P4-CUTOVER's backfill uses this same function.
//       product_content:
//         title, display_vendor, display_type, description_html
//                              the overlay's value, null when it follows Shopify
//         description          plain text from description_html (null with it)
//         gallery              JSON [{url, alt}], null when it follows Shopify;
//         featured_image, featured_image_alt
//                              the gallery's first image and its alt
//         badge                null when empty
//         modules              JSON [{title, html}], the mapping the product
//                              page reads (documents-reader pdpExtrasFromBody),
//                              in the body's order; an image_with_text module
//                              (no longer offered, still kept) becomes its
//                              image and text; null when there are none
//         pairs, pairs_title   JSON list of product ids, and the title
//         layout_template      the template choice
//         keep_variant_images  1, 0 or null
//         seo_title, seo_description
//                              the text settings (Phase 9 line 5), null when
//                              empty (the page then uses the product's own)
//         og_image, layout_document_id: null (no field sets them yet)
//       collection_content: pinned (JSON ids or null), layout_template
//   liveRowStatement({ type, entityId, row, pointer })
//     the upsert (row) or the delete (row null) of one live row. With
//     `pointer` (a release id) it only acts when release_state's live pointer
//     is that release: inside commitPublishBatch, after its flip.
//   outboxStatement({ productId, reason, at, pointer })
//     one search_outbox row: product_id, handle = products.handle at write
//     time (null when the product is gone), reason 'publish' | 'undo' |
//     'discard', created_at, done_at null. Written only INSIDE the batch that
//     changes the live row (spec OVL-17: an enqueue afterwards can fail
//     silently). A collection never gets one.
import { pdpExtrasFromBody } from "../content/documents-reader.js";
import { sanitize } from "../registry/text.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const settingsOf = (body) => (isObj(body?.settings) ? body.settings : {});
const overlayValue = (v) => (isObj(v) && v.value !== undefined ? v.value : null);

export const PRODUCT_LIVE_COLUMNS = Object.freeze([
  "product_id",
  "document_id",
  "version_id",
  "title",
  "description",
  "description_html",
  "featured_image",
  "featured_image_alt",
  "gallery",
  "seo_title",
  "seo_description",
  "og_image",
  "display_vendor",
  "display_type",
  "badge",
  "modules",
  "layout_document_id",
  "pairs",
  "keep_variant_images",
  "published_at",
  "pairs_title",
  "layout_template",
]);
export const COLLECTION_LIVE_COLUMNS = Object.freeze(["collection_id", "document_id", "version_id", "pinned", "layout_document_id", "published_at", "layout_template"]);

const ENTITIES = {
  product_content: { table: "product_content_live", key: "product_id", columns: PRODUCT_LIVE_COLUMNS },
  collection_content: { table: "collection_content_live", key: "collection_id", columns: COLLECTION_LIVE_COLUMNS },
};
export const liveTableOf = (type) => ENTITIES[type] || null;

const ENTITY_NAMES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Plain text from sanitized HTML: tags out, block ends as spaces, entities
// decoded, whitespace collapsed.
export function plainText(html) {
  if (typeof html !== "string") return null;
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return Object.hasOwn(ENTITY_NAMES, e.toLowerCase()) ? ENTITY_NAMES[e.toLowerCase()] : m;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

const json = (v) => (v == null ? null : JSON.stringify(v));
const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The product page's modules: pdpExtrasFromBody for rich_text, text and faq,
// and an image_with_text module as its picture, text and caption.
function modulesOf(body) {
  const sections = Array.isArray(body?.sections) ? body.sections : [];
  const out = [];
  for (const sec of sections) {
    if (!isObj(sec) || sec.enabled === false) continue;
    if (sec.kind !== "image_with_text") {
      out.push(...pdpExtrasFromBody({ ...body, sections: [sec] }));
      continue;
    }
    const st = isObj(sec.settings) ? sec.settings : {};
    const img = isObj(st.image) && typeof st.image.media === "string" ? st.image : null;
    const parts = [];
    if (img) parts.push(`<p><img src="${escapeAttr(img.media)}" alt="${escapeAttr(img.alt ?? "")}"></p>`);
    if (typeof st.text === "string" && st.text.trim()) parts.push(`<p>${escapeText(st.text)}</p>`);
    if (typeof st.caption === "string" && st.caption.trim()) parts.push(`<p>${escapeText(st.caption)}</p>`);
    const title = [st.title, st.caption, img?.alt].find((x) => typeof x === "string" && x.trim());
    const html = sanitize(parts.join(""));
    if (title && html) out.push({ title, html });
  }
  return out;
}

// Phase 9 line 5: a text setting as a live column (trimmed; empty is null).
const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function liveRowFor(type, body, { documentId, versionId, publishedAt, entityId } = {}) {
  const s = settingsOf(body);
  if (type === "product_content") {
    const gallery = overlayValue(s.gallery);
    const list = Array.isArray(gallery) ? gallery.filter((g) => isObj(g) && typeof g.media === "string").map((g) => ({ url: g.media, alt: typeof g.alt === "string" ? g.alt : null })) : null;
    const html = overlayValue(s.description_html);
    const modules = modulesOf(body);
    const pairs = isObj(s.pairs) && Array.isArray(s.pairs.products) && s.pairs.products.length ? s.pairs.products.filter((x) => typeof x === "string") : null;
    const row = {
      document_id: documentId,
      version_id: versionId,
      title: overlayValue(s.title),
      description: typeof html === "string" ? plainText(html) : null,
      description_html: typeof html === "string" ? html : null,
      featured_image: list && list.length ? list[0].url : null,
      featured_image_alt: list && list.length ? list[0].alt : null,
      gallery: json(list),
      seo_title: textOrNull(s.seo_title),
      seo_description: textOrNull(s.seo_description),
      og_image: null,
      display_vendor: overlayValue(s.display_vendor),
      display_type: overlayValue(s.display_type),
      badge: typeof s.badge === "string" && s.badge.trim() ? s.badge : null,
      modules: modules.length ? JSON.stringify(modules) : null,
      layout_document_id: null,
      pairs: json(pairs),
      keep_variant_images: s.keep_variant_images === true ? 1 : s.keep_variant_images === false ? 0 : null,
      published_at: publishedAt,
      pairs_title: pairs && isObj(s.pairs) && typeof s.pairs.title === "string" && s.pairs.title.trim() ? s.pairs.title : null,
      layout_template: typeof s.template === "string" ? s.template : null,
    };
    return entityId != null ? { product_id: entityId, ...row } : row;
  }
  if (type === "collection_content") {
    const pinned = Array.isArray(s.pinned) && s.pinned.length ? s.pinned.filter((x) => typeof x === "string") : null;
    const row = { document_id: documentId, version_id: versionId, pinned: json(pinned), layout_document_id: null, published_at: publishedAt, layout_template: typeof s.template === "string" ? s.template : null };
    return entityId != null ? { collection_id: entityId, ...row } : row;
  }
  throw new Error(`liveRowFor: "${type}" has no live row`);
}

const POINTER_IS = "(SELECT live_release_id FROM release_state WHERE id = 1) = ?";

export function liveRowStatement({ type, entityId, row, pointer = null }) {
  const e = liveTableOf(type);
  if (!e) throw new Error(`liveRowStatement: "${type}" has no live row`);
  if (typeof entityId !== "string" || !entityId) throw new Error("liveRowStatement: the entity id is required");
  const guard = pointer == null ? "" : ` AND ${POINTER_IS}`;
  const guardArgs = pointer == null ? [] : [pointer];
  if (row == null) return { sql: `DELETE FROM ${e.table} WHERE ${e.key} = ?${guard}`, args: [entityId, ...guardArgs] };
  const values = e.columns.map((c) => (c === e.key ? entityId : row[c] ?? null));
  const updates = e.columns.filter((c) => c !== e.key).map((c) => `${c} = excluded.${c}`);
  return {
    sql: `INSERT INTO ${e.table} (${e.columns.join(", ")}) SELECT ${e.columns.map(() => "?").join(", ")} WHERE 1${guard} ON CONFLICT(${e.key}) DO UPDATE SET ${updates.join(", ")}`,
    args: [...values, ...guardArgs],
  };
}

export const OUTBOX_REASONS = Object.freeze(["publish", "undo", "discard"]);

export function outboxStatement({ productId, reason, at, pointer = null }) {
  if (!OUTBOX_REASONS.includes(reason)) throw new Error(`outboxStatement: unknown reason "${reason}"`);
  const guard = pointer == null ? "" : ` AND ${POINTER_IS}`;
  return {
    sql: `INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) SELECT ?, (SELECT handle FROM products WHERE id = ?), ?, ?, NULL WHERE 1${guard}`,
    args: [productId, productId, reason, at, ...(pointer == null ? [] : [pointer])],
  };
}
