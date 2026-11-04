// P4-SEARCH (OVL-04, OVL-05; R4 "founders can't reach every product"): the
// editor's product list, behind the listProductContent operation of the
// documents API (lib/admin/documents-api.js). Node console routes only.
//
//   listProductContent({ q, filter, cursor, limit })
//     -> { items, nextCursor, counts }
//
// Every product in the catalog, paged (limit 1..100, default 30), ordered by
// the name shoppers see (then id). The cursor encodes that name and the id.
//   items[]  { productId, documentId, handle, title, shopifyTitle, thumb,
//              edited, live, inShopify, changedInShopify, changedFields }
//     title           the PUBLISHED name (product_content_live over Shopify's),
//                     never a draft
//     shopifyTitle    Shopify's own name when it differs from title, else null
//     edited          the product has a live row, or a content document whose
//                     draft holds any setting or module
//     live            the product has a live row
//     documentId      its content document, or null when none was made yet
//     changedInShopify, changedFields
//                     see below
//   q       matches the published name, Shopify's name or the handle
//           (case-insensitive, contains)
//   filter  'all' (default) | 'changed_in_shopify' | 'orphaned'
//     changed_in_shopify  edited products only: for each overlay field the
//                         DRAFT holds a value for, its base_hash is compared
//                         with the hash of what Shopify sends now
//                         (lib/documents/service.js overlayBaseHash, image
//                         addresses without their query string). A field that
//                         is null in the draft never counts, so "Keep mine"
//                         (a re-base), "Use Shopify's" and Reset clear it at
//                         once, with no publish (P4-LIVEROW (3b)).
//     orphaned            content documents (not archived, with edits or a
//                         live row) whose product is no longer in the catalog.
//                         Their title is the document's label (the product's
//                         name when it was made); handle and shopifyTitle are
//                         null; inShopify false.
//   counts  { all, edited, changedInShopify, orphaned }, for the shell: the
//           whole store, whatever q, filter and cursor say.
//
// Reads only: nothing here writes. Statements per call: the live-table probe
// (once per database per instance, lib/catalog/effective.js), the page, the
// counts, the changed check and the orphans.
import { sql } from "kysely";
import { db } from "../db.js";
import { documentType } from "../registry/index.js";
import { OVERLAY_FIELDS } from "../registry/document-types.js";
import { liveTableReady } from "../catalog/effective.js";
import { overlayBaseHash, rawValueOf } from "../documents/service.js";

export const LIST_FILTERS = Object.freeze(["all", "changed_in_shopify", "orphaned"]);
export const LIST_LIMIT = Object.freeze({ min: 1, max: 100, default: 30 });

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
export const encodeListCursor = (title, id) => b64url(JSON.stringify([String(title ?? ""), String(id)]));
export function decodeListCursor(cursor) {
  try {
    const [title, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    return typeof id === "string" && id ? { title: String(title ?? ""), id } : null;
  } catch {
    return null;
  }
}

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const OVERLAYS = OVERLAY_FIELDS.product_content;
// JSON paths are made from the registry's own keys (letters and _ only)
const pathOf = (key) => {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`product-content-list: unexpected setting key ${key}`);
  return `$.settings.${key}`;
};

// SQL: the draft (alias d) holds any setting or module
function draftHasEdits() {
  const keys = documentType("product_content").settings.map((s) => s.key);
  const any = keys.map((k) => `json_extract(d.draft, '${pathOf(k)}') IS NOT NULL`);
  any.push("COALESCE(json_array_length(d.draft, '$.sections'), 0) > 0");
  return `(${any.join(" OR ")})`;
}

// The name shoppers see, and whether a live row exists, with or without the
// live table (a store from before 0024 reads Shopify's names).
const titleExpr = (live) => (live ? "COALESCE(c.title, p.title)" : "p.title");
const liveExpr = (live) => (live ? "(c.product_id IS NOT NULL)" : "0");
const joinLive = (live) => (q) => (live ? q.leftJoin("product_content_live as c", "c.product_id", "p.id") : q);
const joinDoc = (q) => q.leftJoin("documents as d", (j) => j.onRef("d.entity_id", "=", "p.id").on("d.type", "=", "product_content").on("d.archived_at", "is", null));
const editedExpr = (live) => `(${liveExpr(live)} OR (d.id IS NOT NULL AND ${draftHasEdits()}))`;

// ---- changed in Shopify -------------------------------------------------------------

// Map productId -> [fields whose draft base no longer matches Shopify].
async function changedInShopify() {
  const h = (f) => sql.raw(`json_extract(d.draft, '${pathOf(f)}.base_hash')`).as(`h_${f}`);
  const t = (f) => sql.raw(`json_type(d.draft, '${pathOf(f)}.value')`).as(`t_${f}`);
  const anyBase = OVERLAYS.map((f) => `json_extract(d.draft, '${pathOf(f)}.base_hash') IS NOT NULL`).join(" OR ");
  const rows = await db
    .selectFrom("documents as d")
    .innerJoin("products as p", "p.id", "d.entity_id")
    .select(["d.entity_id as product_id", "p.title", "p.description_html", "p.vendor", "p.product_type"])
    .select(OVERLAYS.flatMap((f) => [h(f), t(f)]))
    .select(
      sql
        .raw(
          `CASE WHEN json_extract(d.draft, '${pathOf("gallery")}.base_hash') IS NOT NULL THEN ` +
            "(SELECT json_group_array(json_object('url', i.url, 'alt', i.alt)) FROM (SELECT url, alt FROM product_images WHERE product_id = p.id ORDER BY position, id) i) END",
        )
        .as("images"),
    )
    .where("d.type", "=", "product_content")
    .where("d.archived_at", "is", null)
    .where(sql.raw(`(${anyBase})`))
    .execute();
  const out = new Map();
  for (const r of rows) {
    let images = [];
    try {
      images = r.images ? JSON.parse(r.images) : [];
    } catch {
      images = [];
    }
    const raw = { title: r.title, description_html: r.description_html, vendor: r.vendor, product_type: r.product_type, images: images.map((i) => ({ url: String(i.url), alt: i.alt == null ? null : String(i.alt) })) };
    const fields = [];
    for (const f of OVERLAYS) {
      const type = r[`t_${f}`];
      const base = r[`h_${f}`];
      // a field that follows Shopify (null in the draft) never counts
      if (type == null || type === "null" || base == null) continue;
      if ((await overlayBaseHash(f, rawValueOf(f, raw))) !== String(base)) fields.push(f);
    }
    if (fields.length) out.set(String(r.product_id), fields);
  }
  return out;
}

// ---- orphans --------------------------------------------------------------------------

async function orphans(live) {
  const rows = await db
    .selectFrom("documents as d")
    .$call((q) => (live ? q.leftJoin("product_content_live as c", "c.product_id", "d.entity_id") : q))
    .select(["d.id", "d.entity_id", "d.label"])
    .select(sql.raw(live ? "(c.product_id IS NOT NULL)" : "0").as("live"))
    .where("d.type", "=", "product_content")
    .where("d.archived_at", "is", null)
    .where(sql.raw("NOT EXISTS (SELECT 1 FROM products p WHERE p.id = d.entity_id)"))
    .where(sql.raw(`(${live ? "c.product_id IS NOT NULL OR " : ""}${draftHasEdits()})`))
    .execute();
  return rows.map((r) => ({
    productId: String(r.entity_id),
    documentId: String(r.id),
    handle: null,
    title: String(r.label),
    shopifyTitle: null,
    thumb: null,
    edited: true,
    live: !!Number(r.live),
    inShopify: false,
    changedInShopify: false,
    changedFields: [],
  }));
}

// ---- the list ---------------------------------------------------------------------------

const itemOf = (r, changed) => {
  const fields = changed.get(String(r.id)) || [];
  return {
    productId: String(r.id),
    documentId: r.document_id == null ? null : String(r.document_id),
    handle: String(r.handle),
    title: String(r.title),
    shopifyTitle: r.shopify_title != null && String(r.shopify_title) !== String(r.title) ? String(r.shopify_title) : null,
    thumb: r.thumb || null,
    edited: !!Number(r.edited),
    live: !!Number(r.live),
    inShopify: true,
    changedInShopify: fields.length > 0,
    changedFields: fields,
  };
};

export async function listProductContent({ q = "", filter = "all", cursor = null, limit = LIST_LIMIT.default } = {}) {
  if (!LIST_FILTERS.includes(filter)) throw new TypeError(`listProductContent: filter must be one of ${LIST_FILTERS.join(", ")}`);
  const size = Math.max(LIST_LIMIT.min, Math.min(Number(limit) || LIST_LIMIT.default, LIST_LIMIT.max));
  const after = cursor ? decodeListCursor(cursor) : null;
  if (cursor && !after) throw new TypeError("listProductContent: bad cursor");
  const needle = String(q ?? "").trim();
  const live = await liveTableReady();
  const title = titleExpr(live);

  const [changed, gone, counted] = await Promise.all([
    changedInShopify(),
    orphans(live),
    db
      .selectFrom("products as p")
      .$call(joinLive(live))
      .$call(joinDoc)
      .select(sql.raw("count(*)").as("all"))
      .select(sql.raw(`sum(CASE WHEN ${editedExpr(live)} THEN 1 ELSE 0 END)`).as("edited"))
      .executeTakeFirst(),
  ]);
  const counts = { all: Number(counted?.all || 0), edited: Number(counted?.edited || 0), changedInShopify: changed.size, orphaned: gone.length };

  if (filter === "orphaned") {
    const lc = needle.toLowerCase();
    const list = gone
      .filter((o) => !lc || o.title.toLowerCase().includes(lc))
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
      .filter((o) => !after || o.title > after.title || (o.title === after.title && o.productId > after.id));
    const page = list.slice(0, size);
    const last = page[page.length - 1];
    return { items: page, nextCursor: list.length > size ? encodeListCursor(last.title, last.productId) : null, counts };
  }

  if (filter === "changed_in_shopify" && !changed.size) return { items: [], nextCursor: null, counts };
  let query = db
    .selectFrom("products as p")
    .$call(joinLive(live))
    .$call(joinDoc)
    .select(["p.id", "p.handle", "d.id as document_id"])
    .select(sql.raw(title).as("title"))
    .select(sql.raw("p.title").as("shopify_title"))
    .select(sql.raw(live ? "CASE WHEN c.featured_image IS NOT NULL OR c.gallery IS NOT NULL THEN c.featured_image ELSE p.featured_image END" : "p.featured_image").as("thumb"))
    .select(sql.raw(liveExpr(live)).as("live"))
    .select(sql.raw(editedExpr(live)).as("edited"))
    .orderBy(sql.raw(title))
    .orderBy("p.id")
    .limit(size + 1);
  if (filter === "changed_in_shopify") query = query.where("p.id", "in", [...changed.keys()]);
  if (needle) {
    const like = `%${likeEscape(needle)}%`;
    query = query.where(sql`(${sql.raw(title)} LIKE ${like} ESCAPE '\\' OR p.title LIKE ${like} ESCAPE '\\' OR p.handle LIKE ${like} ESCAPE '\\')`);
  }
  if (after) query = query.where(sql`(${sql.raw(title)} > ${after.title} OR (${sql.raw(title)} = ${after.title} AND p.id > ${after.id}))`);
  const rows = await query.execute();
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return { items: page.map((r) => itemOf(r, changed)), nextCursor: rows.length > size ? encodeListCursor(last.title, last.id) : null, counts };
}
