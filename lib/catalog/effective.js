// P4-EFFECTIVE (OVL-03, OVL-05, OVL-06; spec 8.9): the ONE shopper-path read of
// product content. Edge-safe: Kysely over lib/db.js, no node: imports.
//
// Every value a shopper sees is the effective one: what the founder published
// (product_content_live, written only by a publish) over what Shopify synced.
//
//   COALESCE(c.x, p.x) over products p LEFT JOIN product_content_live c
//
// Rules (spec 8.9, phase 4 plan decision 3):
//   · Null in a live column means "follow Shopify". An empty string is a real
//     value and is kept (COALESCE only skips NULL).
//   · The featured image's alt follows its image: when the founder's image (or
//     gallery) is live, its own alt is used, never Shopify's alt for another
//     picture.
//   · A live gallery (JSON [{url, alt}]) replaces Shopify's photos on the
//     product page; its first item is the featured image.
//   · A live description_html with no plain description gets one derived from
//     it, so the page, the meta description and JSON-LD never disagree.
//   · Logic stays on raw values: logic_tags and logic_type are Shopify's tags
//     and product type, for offers, quiz scoring and filters. Rows carry
//     display_type and display_vendor for showing, and NO product_type, vendor
//     or tags key, so a component reading product_type gets undefined.
//   · Only published values are read. A draft (documents.draft) is never read
//     here, so a draft cannot reach the cart, search, the sitemap or an email.
//   · modules, badge, pairs and template are not read here (P4-OVL07).
//
// Not-yet-migrated tenants: the live table comes with migration 0024. Whether a
// database has it is asked once (lib/schema-compat.js hasColumns: present is
// remembered for good, absent is asked again after 60 s, per database). Without
// it every selector reads the raw catalog with the same shape. If a joined read
// still fails with "no such table" (a race the probe cannot see), it is retried
// raw and the database is read raw for the next 60 s.
//
// Cost: the join rides on the read each caller already made, so a request pays
// no extra statement for it. The one exception is the probe, once per database
// per instance (and once a minute while a database has no table). Gift lines
// cost one statement, only on a cart whose offers grant a gift.
import { sql } from "kysely";
import { db, currentDatabase } from "../db.js";
import { hasColumns } from "../schema-compat.js";
import { notMigratedYet } from "../schema-shape.js";

export const LIVE_TABLE = "product_content_live";
export const LIVE_COLUMNS = Object.freeze([
  "product_id",
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
]);

const RAW_RECHECK_MS = 60_000;
let rawUntil = new WeakMap(); // database instance -> time before which reads go raw

// The founder's image is live when the overlay sets a featured image or a
// gallery; then its alt is the founder's too (possibly null), never Shopify's.
const OWN_IMAGE = "(c.featured_image IS NOT NULL OR c.gallery IS NOT NULL)";

// name -> [effective SQL, raw SQL]. The raw form is what a tenant without the
// live table reads, with the same column names.
const EXPR = {
  title: ["COALESCE(c.title, p.title)", "p.title"],
  display_type: ["COALESCE(c.display_type, p.product_type)", "p.product_type"],
  display_vendor: ["COALESCE(c.display_vendor, p.vendor)", "p.vendor"],
  featured_image: [`CASE WHEN ${OWN_IMAGE} THEN c.featured_image ELSE p.featured_image END`, "p.featured_image"],
  featured_image_alt: [`CASE WHEN ${OWN_IMAGE} THEN c.featured_image_alt ELSE p.featured_image_alt END`, "p.featured_image_alt"],
  // read as parts; the description rule is applied in JS (describe())
  live_description: ["c.description", "NULL"],
  live_description_html: ["c.description_html", "NULL"],
  raw_description: ["p.description", "p.description"],
  raw_description_html: ["p.description_html", "p.description_html"],
  gallery: ["c.gallery", "NULL"],
  seo_title: ["c.seo_title", "NULL"],
  seo_description: ["c.seo_description", "NULL"],
  og_image: ["c.og_image", "NULL"],
  // raw, for logic and for matching orders in Shopify (OVL-06)
  logic_tags: ["p.tags", "p.tags"],
  logic_type: ["p.product_type", "p.product_type"],
  catalog_title: ["p.title", "p.title"],
  // the founder's published title alone (null: none), for gift lines
  live_title: ["c.title", "NULL"],
};
const col = (live, name, as = name) => sql.raw(EXPR[name][live ? 0 : 1]).as(as);
const cols = (live, names) => names.map((n) => col(live, n));
const joinLive = (live) => (q) => (live ? q.leftJoin(`${LIVE_TABLE} as c`, "c.product_id", "p.id") : q);

// The read: with the live table when this database has it, else raw.
async function read(fn) {
  const inst = currentDatabase();
  const until = rawUntil.get(inst);
  const live = !(until && until > Date.now()) && (await hasColumns(LIVE_TABLE, LIVE_COLUMNS));
  if (!live) return fn(false);
  try {
    return await fn(true);
  } catch (e) {
    if (!notMigratedYet(e, { table: LIVE_TABLE, columns: LIVE_COLUMNS })) throw e;
    rawUntil.set(inst, Date.now() + RAW_RECHECK_MS);
    return fn(false);
  }
}

// Is the live table there for the current database? (tests, the speed note)
export async function liveTableReady() {
  return read(async (live) => live);
}

// ---- shaping ------------------------------------------------------------------

const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const parseTags = (value) => {
  const t = parseJson(value, []);
  return Array.isArray(t) ? t.map(String) : [];
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
// Plain text from rich text, for the meta description and search. Deliberately
// simple: tags out, a few entities decoded, whitespace collapsed.
export function plainFromHtml(html) {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// description_html: the founder's, else Shopify's. description: the founder's
// plain text, else derived from the founder's html, else Shopify's.
function describe(r) {
  const html = r.live_description_html ?? r.raw_description_html ?? null;
  let text;
  if (r.live_description != null) text = r.live_description;
  else if (r.live_description_html != null) text = plainFromHtml(r.live_description_html);
  else text = r.raw_description ?? null;
  return { description: text, description_html: html };
}

// A live gallery, as product_images-shaped rows. null when there is none (or
// it is not a JSON list), so Shopify's photos are read.
function galleryRows(productId, value) {
  if (value == null) return null;
  const list = parseJson(value, null);
  if (!Array.isArray(list)) return null;
  return list
    .filter((g) => g && typeof g.url === "string")
    .map((g, i) => ({ id: `${productId}::gallery::${i}`, product_id: productId, url: g.url, alt: g.alt ?? null, width: null, height: null, position: i }));
}

const omit = (row, keys) => {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
};
const DESCRIBE_PARTS = ["live_description", "live_description_html", "raw_description", "raw_description_html"];

// ---- cards ----------------------------------------------------------------------

// What a product card shows (components/ProductCard.js), plus the id.
export const CARD_FIELDS = Object.freeze(["id", "handle", "title", "display_type", "price_min", "price_max", "compare_at_min", "currency", "available", "featured_image", "featured_image_alt"]);
const CARD_RAW = ["p.id", "p.handle", "p.price_min", "p.price_max", "p.compare_at_min", "p.currency", "p.available"];
const CARD_EFFECTIVE = ["title", "display_type", "featured_image", "featured_image_alt"];

function shapeCard(r, { logic }) {
  const out = { ...r, available: !!r.available };
  if (logic) out.logic_tags = parseTags(r.logic_tags);
  else delete out.logic_tags;
  if (!logic) delete out.logic_type;
  if (out.shared !== undefined) out.shared = Number(out.shared);
  return out;
}

export const COLLECTION_SORTS = Object.freeze(["featured", "new", "price-asc", "price-desc"]);

// Card rows. One statement. Options (all optional):
//   ids              only these product ids (order is the caller's job)
//   handles          only these handles
//   availableOnly    only products in stock
//   collection       { handle, sort, inStock, type, pins }: a collection page.
//                    `type` filters on Shopify's RAW product type (the
//                    collection filter stays on raw values by design).
//   sharedWith       a product id: products sharing collections with it, most
//                    shared first, then by EFFECTIVE title (the automatic pairs);
//                    each row also carries `shared`, the count
//   order            "newest" (in stock first, then newest) | "title"
//   limit, offset
//   logic            also return logic_tags (parsed) and logic_type
export async function cardRows(opts = {}) {
  const { ids, handles, availableOnly = false, collection, sharedWith, order, limit, offset, logic = false } = opts;
  if (Array.isArray(ids) && !ids.length) return [];
  if (Array.isArray(handles) && !handles.length) return [];
  return read(async (live) => {
    let q = db.selectFrom("products as p").$call(joinLive(live)).select(CARD_RAW).select(cols(live, CARD_EFFECTIVE));
    if (logic) q = q.select(cols(live, ["logic_tags", "logic_type"]));
    if (Array.isArray(ids)) q = q.where("p.id", "in", ids);
    if (Array.isArray(handles)) q = q.where("p.handle", "in", handles);
    if (availableOnly) q = q.where("p.available", "=", 1);

    if (collection) {
      const { handle, sort = "featured", inStock = false, type = "", pins = [] } = collection;
      q = q
        .innerJoin("collection_products as cp", "cp.product_id", "p.id")
        .innerJoin("collections as k", "k.id", "cp.collection_id")
        .where("k.handle", "=", handle)
        .$if(Boolean(inStock), (b) => b.where("p.available", "=", 1))
        .$if(Boolean(type), (b) => b.where("p.product_type", "=", type));
      if (sort === "new") q = q.orderBy("p.created_at", "desc");
      else if (sort === "price-asc") q = q.orderBy("p.price_min", "asc");
      else if (sort === "price-desc") q = q.orderBy("p.price_min", "desc");
      else {
        // "featured": merchant pins first (S39 / MC06), then Shopify's position
        const pinned = Array.isArray(pins) ? pins.slice(0, 24) : [];
        if (pinned.length) {
          const cases = pinned.map((id, i) => sql`WHEN p.id = ${id} THEN ${i}`);
          q = q.orderBy(sql`CASE ${sql.join(cases, sql` `)} ELSE 9999 END`, "asc");
        }
        q = q.orderBy("cp.position", "asc");
      }
      q = q.orderBy("p.handle", "asc");
    } else if (sharedWith) {
      q = q
        .innerJoin("collection_products as theirs", "theirs.product_id", "p.id")
        .innerJoin("collection_products as mine", "mine.collection_id", "theirs.collection_id")
        .where("mine.product_id", "=", sharedWith)
        .where("p.id", "!=", sharedWith)
        .select((eb) => eb.fn.count("theirs.collection_id").as("shared"))
        .groupBy("p.id")
        .orderBy("shared", "desc")
        .orderBy(sql.raw(EXPR.title[live ? 0 : 1]), "asc");
    } else if (order === "newest") {
      q = q.orderBy("p.available", "desc").orderBy("p.created_at", "desc");
    } else if (order === "title") {
      q = q.orderBy(sql.raw(EXPR.title[live ? 0 : 1]), "asc").orderBy("p.handle", "asc");
    }
    if (limit != null) q = q.limit(limit);
    if (offset) q = q.offset(offset);
    const rows = await q.execute();
    return rows.map((r) => shapeCard(r, { logic }));
  });
}

// How many products a collection page lists with these filters (the page's
// total). Reads no content column; `type` is Shopify's RAW product type, as in
// cardRows. Kept here so the type filter's raw read sits next to its card read.
export async function collectionCount({ handle, inStock = false, type = "" } = {}) {
  const row = await db
    .selectFrom("products as p")
    .innerJoin("collection_products as cp", "cp.product_id", "p.id")
    .innerJoin("collections as k", "k.id", "cp.collection_id")
    .where("k.handle", "=", handle)
    .$if(Boolean(inStock), (b) => b.where("p.available", "=", 1))
    .$if(Boolean(type), (b) => b.where("p.product_type", "=", type))
    .select((eb) => eb.fn.count("cp.product_id").as("n"))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

// Card rows for these ids, any availability, in the order given (ids not in
// the catalog are left out).
export async function byIds(ids, { availableOnly = false, logic = false } = {}) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const rows = await cardRows({ ids: list, availableOnly, logic });
  const at = new Map(list.map((id, i) => [id, i]));
  return rows.sort((a, b) => at.get(a.id) - at.get(b.id));
}

// ---- the product page -------------------------------------------------------------

const PAGE_RAW = ["p.id", "p.handle", "p.price_min", "p.price_max", "p.compare_at_min", "p.currency", "p.available", "p.total_inventory", "p.options", "p.created_at", "p.updated_at", "p.synced_at"];
const PAGE_EFFECTIVE = ["title", "display_type", "display_vendor", "featured_image", "featured_image_alt", "gallery", "seo_title", "seo_description", "og_image", "logic_tags", "logic_type", ...DESCRIBE_PARTS];

// The product page's product, with its photos and variants. Three statements at
// most (the product; then its variants and, without a live gallery, Shopify's
// photos, together), as before.
export async function productPage(handle) {
  return read(async (live) => {
    const row = await db.selectFrom("products as p").$call(joinLive(live)).select(PAGE_RAW).select(cols(live, PAGE_EFFECTIVE)).where("p.handle", "=", handle).executeTakeFirst();
    if (!row) return null;
    const gallery = galleryRows(row.id, row.gallery);
    const [images, variants] = await Promise.all([
      gallery
        ? gallery
        : db.selectFrom("product_images").select(["id", "product_id", "url", "alt", "width", "height", "position"]).where("product_id", "=", row.id).orderBy("position", "asc").execute(),
      db.selectFrom("variants").selectAll().where("product_id", "=", row.id).orderBy("position", "asc").execute(),
    ]);
    const lead = gallery ? gallery[0] || null : null;
    return {
      ...omit(row, ["gallery", ...DESCRIBE_PARTS]),
      ...describe(row),
      ...(gallery ? { featured_image: lead ? lead.url : null, featured_image_alt: lead ? lead.alt : null } : {}),
      available: !!row.available,
      logic_tags: parseTags(row.logic_tags),
      options: parseJson(row.options, []),
      // plain objects: these cross the server -> client boundary (ProductGallery)
      images: images.map((img) => ({ ...img })),
      variants: variants.map((v) => ({ ...v, available: !!v.available, selectedOptions: parseJson(v.selected_options, []) })),
    };
  });
}

// ---- the cart -----------------------------------------------------------------------

// The cart's lines on the live catalog: one statement. `title` is what the
// shopper sees; `catalog_title` is Shopify's own (raw) title and `sku` the
// variant's, which the order freezes for matching in Shopify (OVL-06).
export async function cartRows(cartId) {
  return read(async (live) => {
    const rows = await db
      .selectFrom("cart_items as ci")
      .innerJoin("variants as v", "v.id", "ci.variant_id")
      .innerJoin("products as p", "p.id", "ci.product_id")
      .$call(joinLive(live))
      .where("ci.cart_id", "=", cartId)
      .select(["ci.variant_id", "ci.product_id", "ci.quantity", "ci.price_at_add", "v.title as variant_title", "v.sku", "v.price", "v.currency as v_currency", "v.image_url", "v.available", "p.handle", "p.currency as p_currency"])
      .select(cols(live, ["title", "catalog_title", "featured_image", "logic_tags", "logic_type"]))
      .orderBy("ci.added_at", "asc")
      .execute();
    return rows.map((r) => ({ ...r, logic_tags: parseTags(r.logic_tags) }));
  });
}

// Gift lines by variant (OVL-03 consistency): the founder's published title
// (live_title, null when there is none), Shopify's title and the SKU. One
// statement; variants not in the catalog are left out. lib/cart.js shows
// live_title when there is one and otherwise keeps the title the offer stored,
// so a store with no published titles shows exactly what it showed before.
export async function giftRows(variantIds) {
  const list = [...new Set((variantIds || []).filter(Boolean))];
  if (!list.length) return [];
  return read(async (live) =>
    db
      .selectFrom("variants as v")
      .innerJoin("products as p", "p.id", "v.product_id")
      .$call(joinLive(live))
      .where("v.id", "in", list)
      .select(["v.id as variant_id", "v.product_id", "v.sku"])
      .select(cols(live, ["live_title", "catalog_title"]))
      .execute(),
  );
}

// ---- search (SQL) -------------------------------------------------------------------

// The SQL search (S38 BE05: the supported engine). Every word must match the
// effective title, display type or vendor, or a raw tag; ranked in stock
// first, then effective-title prefix, then effective-title match, then title.
// One statement.
export async function search(q, limit = 8) {
  const terms = String(q ?? "")
    .replace(/[%_]/g, "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!terms.length) return { source: "database", found: 0, hits: [] };
  const first = `${terms[0].toLowerCase()}%`;
  const whole = `%${terms.join(" ").toLowerCase()}%`;
  return read(async (live) => {
    const title = sql.raw(EXPR.title[live ? 0 : 1]);
    const type = sql.raw(EXPR.display_type[live ? 0 : 1]);
    const vendor = sql.raw(EXPR.display_vendor[live ? 0 : 1]);
    let query = db.selectFrom("products as p").$call(joinLive(live)).select(["p.handle", "p.price_min", "p.currency", "p.available"]).select(cols(live, ["title", "featured_image", "display_type"]));
    for (const t of terms) {
      const term = `%${t}%`;
      query = query.where(sql`(${title} LIKE ${term} OR ${type} LIKE ${term} OR ${vendor} LIKE ${term} OR p.tags LIKE ${term})`);
    }
    const rows = await query
      .orderBy("p.available", "desc")
      .orderBy(sql`CASE WHEN lower(${title}) LIKE ${first} THEN 0 WHEN lower(${title}) LIKE ${whole} THEN 1 ELSE 2 END`, "asc")
      .orderBy(title, "asc")
      .limit(limit)
      .execute();
    return {
      source: "database",
      found: rows.length,
      hits: rows.map((r) => ({
        handle: r.handle,
        title: r.title,
        image: r.featured_image,
        price: r.price_min,
        currency: r.currency || "INR",
        display_type: r.display_type,
        available: !!r.available,
      })),
    };
  });
}

// Search hits as the storefront shows them: display_type, never product_type.
// The SQL path already answers this way; a Typesense answer is mapped (its
// documents name the field product_type until P4-SEARCH's buildSearchDoc).
export function displayHits(result) {
  if (!result || !Array.isArray(result.hits)) return result;
  return {
    ...result,
    hits: result.hits.map((h) => {
      const { product_type, ...rest } = h || {};
      return { ...rest, display_type: rest.display_type ?? product_type ?? null };
    }),
  };
}

// ---- the search index's source (P4-SEARCH's buildSearchDoc) ------------------------

const INDEX_RAW = ["p.id", "p.handle", "p.price_min", "p.price_max", "p.compare_at_min", "p.currency", "p.available"];
const INDEX_EFFECTIVE = ["title", "display_type", "display_vendor", "featured_image", "featured_image_alt", "logic_tags", "logic_type", ...DESCRIBE_PARTS];

// Pages through products by id, oldest id first: { rows, cursor }. Pass the
// returned cursor back for the next page; it is null after the last page.
// `ids` limits the read to those products (the one-product reindex); ids not
// in products are skipped. Each row: id, handle, effective title,
// description and description_html, display_type, display_vendor, featured
// image and alt; raw logic_tags (parsed) and logic_type; prices, currency,
// availability and collection_ids. One statement per page.
export async function indexRows({ cursor = null, limit = 250, ids } = {}) {
  const size = Math.max(1, Math.min(Number(limit) || 250, 1000));
  if (Array.isArray(ids) && !ids.length) return { rows: [], cursor: null };
  return read(async (live) => {
    let q = db
      .selectFrom("products as p")
      .$call(joinLive(live))
      .select(INDEX_RAW)
      .select(cols(live, INDEX_EFFECTIVE))
      .select(sql`(SELECT json_group_array(cp.collection_id) FROM collection_products cp WHERE cp.product_id = p.id)`.as("collection_ids"));
    if (Array.isArray(ids)) q = q.where("p.id", "in", [...new Set(ids)]);
    if (cursor != null) q = q.where("p.id", ">", String(cursor));
    const rows = await q.orderBy("p.id", "asc").limit(size).execute();
    const out = rows.map((r) => ({
      ...omit(r, DESCRIBE_PARTS),
      ...describe(r),
      available: !!r.available,
      logic_tags: parseTags(r.logic_tags),
      collection_ids: (parseJson(r.collection_ids, []) || []).filter(Boolean),
    }));
    return { rows: out, cursor: rows.length === size ? rows[rows.length - 1].id : null };
  });
}

// ---- test hooks -----------------------------------------------------------------------
export const __effective = {
  forgetRawWindow() {
    rawUntil = new WeakMap();
  },
};
