// P6-GEN (GEN-01): the first store, planned from the catalog. Pure and
// edge-safe: no I/O, no clock, no randomness beyond the section ids that
// newSection mints (documentHash strips them, so two plans of one catalog
// hash alike). Never imports lib/ai: every word comes from a fixed template,
// the store's name, or the founder's own catalog (titles and alt text).
//
//   planFirstStore({ siteName, catalog, paletteId }) -> { home, design, summary }
//
//   catalog.products     [{ id, title, available, featured_image, featured_image_alt, created_at }]
//   catalog.collections  [{ id, handle, title, available, total, listed?, productIds? }]
//                        available: how many of its products are in stock
//                        (null or missing: unknown); total: how many it holds;
//                        listed: its membership rows, as the live grid counts
//                        them (the summary only; total when missing);
//                        productIds: its products in their collection order
//                        (used only to pick the hero image, top collection first)
//
// What the home page gets:
//   hero         title = the store name (cut to 60 at a word boundary, never
//                inside a grapheme);
//                highlight and badge empty; a subtitle from SUBTITLES filled
//                with collection titles, else DEFAULT_HERO_SUBTITLE, and empty
//                on an empty catalog (never EMPTY_STORE_HERO_SUBTITLE: "opening
//                soon" would be wrong once the store opens); one button:
//                /collections when a collection has products in stock, "#new"
//                when there are products but no such collection (only if
//                "#new" passes the button's own check in publish mode), none
//                on an empty catalog; no second button; the image of the first
//                available product (top collection first) whose image link is
//                https and 500 characters or fewer, else none
//   collections  a collections grid when 2+ collections have products in stock
//   product_rail up to 2, each on a collection with a KNOWN count of products
//                in stock above 0 (never a sold-out or unknown one), titled
//                with the collection's title cut to 50
//   new          newest products, whenever the catalog has products
// All sold out: hero and 'new' only. Empty catalog: the hero alone (it is
// shown, so the home page is not empty).
// The design: designBodyFor(paletteId), or the default palette (slate). No kit
// presets, no announcement, no reviews, no badge. Header and footer are not
// made: with no document they stay automatic (menus from the catalog).
import { emptyBody, newSection, validateDocument, isStorefrontHref } from "../registry/index.js";
import { pickRailCollection } from "../registry/starter.js";
import { DEFAULT_HERO_SUBTITLE } from "../cms/defaults.js";
import { designBodyFor, paletteById, paletteIdOfBrand, DEFAULT_PALETTE_ID } from "../themes/palettes.js";

export const HERO_TITLE_MAX = 60;
export const RAIL_TITLE_MAX = 50;
export const RAILS_MAX = 2;
export const IMAGE_URL_MAX = 500;
export const ALT_MAX = 300;
// A subtitle filled with collection titles is used only when it stays short
// enough to read on a phone; otherwise the default line is used.
export const SUBTITLE_MAX = 160;
export const GRID_LIMIT = 6;
export const RAIL_LIMIT = 8;
export const NEW_LIMIT = 8;

// The fixed words. Every text the planner writes is one of these, the store's
// name, or catalog words (P6-GEN provenance test).
export const WORDS = Object.freeze({
  heroFallbackTitle: "Welcome to our store",
  shopCollections: "Shop all collections",
  seeNew: "See what’s new",
  gridTitle: "Shop by collection",
  newTitle: "New arrivals",
  railFallbackTitle: "Featured products",
});
// Subtitle templates, tried in order; {a} and {b} are collection titles.
export const SUBTITLES = Object.freeze([
  { needs: 2, text: "Shop {a} and {b}." },
  { needs: 1, text: "Shop {a}." },
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const squash = (s) => str(s).replace(/\s+/g, " ").trim();
const count = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// The text's graphemes (what a shopper sees as one character: an emoji, a
// flag, a letter with its accents), so a cut never splits one. Intl.Segmenter
// where the runtime has it (Node and the edge runtime do), else code points.
function graphemes(s) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (g) => g.segment);
  }
  return Array.from(s);
}

// The longest run of whole graphemes from the start whose length (UTF-16
// code units, what the validator and the limits count) is `max` or less.
function cutGraphemes(s, max) {
  let out = "";
  for (const g of graphemes(s)) {
    if (out.length + g.length > max) break;
    out += g;
  }
  return out;
}

// Cut to `max` characters at a word boundary (the last space within the
// limit), else hard at the limit, never inside a grapheme (P6-FIX1: an emoji
// at the cut once left half a surrogate pair, a broken character). Trailing
// spaces and separators are dropped.
export function cutWords(text, max) {
  const s = squash(text);
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  // a space is one code unit and never inside a surrogate pair, so a cut
  // just before it is whole
  const cut = at > 0 ? head.slice(0, at) : cutGraphemes(s, max);
  return cut.replace(/[\s,;:\-–—]+$/u, "").trim();
}

const isUsableImage = (src) => typeof src === "string" && /^https:\/\//.test(src) && src.length <= IMAGE_URL_MAX && !/\s/.test(src);

// Collections with a KNOWN count of products in stock above 0, the most
// stocked first (ties keep the catalog's order).
function stockedCollections(collections) {
  return collections
    .map((c, i) => ({ c, i, a: count(c.available) }))
    .filter((x) => x.a != null && x.a > 0 && typeof x.c.handle === "string" && x.c.handle)
    .sort((x, y) => y.a - x.a || x.i - y.i)
    .map((x) => x.c);
}

function heroImage(products, top) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const ordered = [];
  const seen = new Set();
  const push = (p) => {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      ordered.push(p);
    }
  };
  for (const c of top) for (const id of Array.isArray(c.productIds) ? c.productIds : []) push(byId.get(id));
  for (const p of products) push(p);
  for (const p of ordered) {
    if (!p.available || !isUsableImage(p.featured_image)) continue;
    const alt = cutWords(squash(p.featured_image_alt) || p.title, ALT_MAX);
    if (!alt) continue;
    return { image: { media: p.featured_image, alt }, product: p };
  }
  return null;
}

// A catch-all collection ("Shop all", "All products", "Frontpage") names no
// kind of product, and "Shop {a}" around "Shop all" reads "Shop Shop all"
// (drill finding P6D-1), so the subtitle never names one.
const CATCH_ALL = /^(?:shop\b|all(?:\s+(?:products|items|collections))?$|frontpage$|home\s*page$|everything$|catalog(?:ue)?$)/i;
export const isCatchAllTitle = (title) => CATCH_ALL.test(squash(title));

function subtitleFor(top) {
  const titles = top.map((c) => squash(c.title)).filter((t) => t && !isCatchAllTitle(t));
  for (const t of SUBTITLES) {
    if (titles.length < t.needs) continue;
    const text = t.text.replace("{a}", titles[0]).replace("{b}", titles[1] ?? "");
    if (text.length <= SUBTITLE_MAX) return text;
  }
  return DEFAULT_HERO_SUBTITLE;
}

const urlCta = (label, href) => ({ label, link: { type: "url", href } });

// "#new" is used only when the button passes its own check in publish mode:
// a hero carrying it validates with no error on the button.
function ctaPasses(cta) {
  if (!isStorefrontHref(cta.link.href)) return false;
  const hero = newSection("hero");
  hero.settings = { ...hero.settings, primary: cta, secondary: null };
  const r = validateDocument({ ...emptyBody("home"), sections: [hero] }, { mode: "publish" });
  return !r.issues.some((i) => String(i.field || "").includes("primary") && i.severity === "error");
}

function railsFor(stocked) {
  // pickRailCollection, fed only collections with a known count above 0 (its
  // later fallbacks would pick an unknown or sold-out one), with its field names
  const pool = stocked.map((c) => ({ handle: c.handle, id: c.id, available_count: count(c.available), product_count: count(c.total), source: c }));
  const rails = [];
  while (rails.length < RAILS_MAX && pool.length) {
    const picked = pickRailCollection(pool, 3);
    if (!picked) break;
    pool.splice(pool.indexOf(picked), 1);
    rails.push(picked.source);
  }
  return rails;
}

function railSection(c) {
  const s = newSection("product_rail");
  const ref = typeof c.id === "string" && c.id && c.id.length <= 120 ? { handle: c.handle, id: c.id } : { handle: c.handle };
  s.settings = { ...s.settings, title: cutWords(c.title, RAIL_TITLE_MAX) || WORDS.railFallbackTitle, collection: ref, limit: RAIL_LIMIT };
  return s;
}

export function planFirstStore({ siteName, catalog, paletteId } = {}) {
  const products = (isObj(catalog) && Array.isArray(catalog.products) ? catalog.products : []).filter((p) => isObj(p) && p.id != null);
  const collections = (isObj(catalog) && Array.isArray(catalog.collections) ? catalog.collections : []).filter(isObj);
  const hasProducts = products.length > 0;
  const stocked = stockedCollections(collections);

  // the hero
  const hero = newSection("hero");
  const picked = hasProducts ? heroImage(products, stocked) : null;
  let primary = null;
  if (stocked.length) primary = urlCta(WORDS.shopCollections, "/collections");
  else if (hasProducts) {
    const cta = urlCta(WORDS.seeNew, "#new");
    primary = ctaPasses(cta) ? cta : null;
  }
  hero.settings = {
    ...hero.settings,
    title: cutWords(siteName, HERO_TITLE_MAX) || WORDS.heroFallbackTitle,
    highlight: "",
    subtitle: hasProducts ? subtitleFor(stocked) : "",
    primary,
    secondary: null,
    badge: "",
    image: picked ? picked.image : null,
  };

  const sections = [hero];
  if (stocked.length >= 2) {
    const grid = newSection("collections");
    grid.settings = { ...grid.settings, title: WORDS.gridTitle, limit: GRID_LIMIT };
    sections.push(grid);
  }
  for (const c of railsFor(stocked)) sections.push(railSection(c));
  if (hasProducts) {
    const fresh = newSection("new");
    fresh.settings = { ...fresh.settings, title: WORDS.newTitle, limit: NEW_LIMIT };
    sections.push(fresh);
  }

  const home = { ...emptyBody("home"), sections };
  const id = paletteById(paletteId) ? paletteId : DEFAULT_PALETTE_ID;
  const design = { ...emptyBody("design"), settings: { ...emptyBody("design").settings, ...designBodyFor(id) } };
  return { home, design, summary: summarizeFirstStore({ home, design, catalog: { products, collections } }) };
}

// The collections the live grid shows, in its order: the same rule as
// lib/repo.js getFeaturedCollections (the collections section's default
// source, lib/registry/sources.js): every collection with at least one
// product, in stock or not (a sold-out collection is a card too), the most
// products first, then by title (SQLite's binary order, which is code point
// order), up to the grid's limit. The count is `listed` (every membership row,
// as getFeaturedCollections counts them), else `total`.
const byCodePoint = (a, b) => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};
export function gridCollections(collections, limit = GRID_LIMIT) {
  return (Array.isArray(collections) ? collections : [])
    .filter(isObj)
    .map((c) => ({ c, n: count(c.listed ?? c.total) }))
    .filter((x) => x.n != null && x.n > 0)
    .sort((x, y) => y.n - x.n || byCodePoint(str(x.c.title), str(y.c.title)))
    .slice(0, limit)
    .map((x) => x.c);
}

// What a home and design say, for the start page's "what was made" copy:
//   { heroImage: { productTitle } | null, collections: [titles], rails: [titles], paletteId }
//   heroImage    the product whose image the hero shows (matched by its image link)
//   collections  the collections the grid shows, in the grid's own order
//                (gridCollections above: sold-out ones included, the most
//                products first, up to the grid's limit); [] with no grid.
//                The grid is placed only when 2+ collections have products in
//                stock, but once placed it lists what getFeaturedCollections
//                reads.
//   rails        each product rail's title
//   paletteId    the curated palette the design's brand is, else null
// Pure; describeFirstStore re-derives it from the stored drafts.
export function summarizeFirstStore({ home, design, catalog } = {}) {
  const products = isObj(catalog) && Array.isArray(catalog.products) ? catalog.products : [];
  const collections = isObj(catalog) && Array.isArray(catalog.collections) ? catalog.collections : [];
  const sections = isObj(home) && Array.isArray(home.sections) ? home.sections.filter((s) => isObj(s) && s.enabled !== false) : [];
  const hero = sections.find((s) => s.kind === "hero");
  const media = isObj(hero?.settings?.image) ? hero.settings.image.media : null;
  const shown = media ? products.find((p) => p.featured_image === media) : null;
  const grid = sections.find((s) => s.kind === "collections");
  const limit = Number.isInteger(grid?.settings?.limit) ? grid.settings.limit : GRID_LIMIT;
  const brand = isObj(design?.settings) ? design.settings.brand : null;
  return {
    heroImage: shown ? { productTitle: squash(shown.title) } : null,
    collections: grid ? gridCollections(collections, limit).map((c) => squash(c.title)) : [],
    rails: sections.filter((s) => s.kind === "product_rail").map((s) => str(s.settings?.title)),
    paletteId: paletteIdOfBrand(brand),
  };
}
