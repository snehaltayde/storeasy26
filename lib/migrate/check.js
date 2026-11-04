// P4-MAPPER (MIG-02, decision 8a): the in-process data check. P4-MAPPER built
// the non-entity part; P4-OVL07 added the entity getters (batch 3); P4-CUTOVER
// runs the full check after its backfill and before the flip (batch 5), with
// entities "live" (lib/migrate/cutover.js), while the store is migrating and
// the catalog sync is parked.
//
// It compares, for every route, what each resolved* getter of
// lib/content/resolve.js answers today (the legacy source, built exactly as a
// shopper request builds it: contentSource() outside any preview) with what
// the same getter answers over the mapped candidate: P4-SEAM's
// candidateSource({ list, bodies, releaseId }), whose versions are held in
// memory. Nothing is written and nothing is flipped.
//
//   NON_ENTITY_GETTERS, ENTITY_GETTERS
//   isEntityRoute([fn, args])         true for the per-product and per-collection
//                                     routes (P4-OVL07)
//   routesFor(source, extra)          the routes: every non-entity getter, every
//                                     page slug the store holds or serves from
//                                     code, every old address, plus `extra`
//                                     (the routes recordOutputs records)
//   entityRoutesFor(mapped)           P4-OVL07: the entity routes for EVERY
//                                     product and collection with content on
//                                     either side (the legacy tables, the live
//                                     release's frozen arrays, its templates,
//                                     the mapped documents and live rows, and
//                                     any row already in the live tables)
//   sameForShoppers(a, b)             the comparison (the rules below)
//   sameAnswer(fn, a, b)              P4-CUTOVER: one getter's two settled
//                                     answers ({ ok } | { threw }), compared
//                                     as dataCheck compares them
//   dataCheck(mapped, { routes, entities })
//                                     run inside the tenant's context. Every
//                                     route in `routes` plus entityRoutesFor.
//                                     entities: "mapped" (default; the dry run)
//                                     gives the candidate the mapped live rows
//                                     (mapped.liveRows) and nothing else;
//                                     "live" gives it none, so the entity
//                                     getters read product_content_live and
//                                     collection_content_live (after a backfill,
//                                     before the flip)
//     -> { ran, reason?, compared, skipped: 0, entityRoutes, entities, differences: [{ fn, args, legacy, candidate }] }
//   assertHeldBodies(bodies)          P4-CUTOVER (from the P4-SEAM review): every
//                                     entry of the bodies map handed to
//                                     candidateSource is a real body. A null or
//                                     undefined entry would make the seam read
//                                     that version from the database instead,
//                                     so the comparison could check something
//                                     other than what is about to go live.
//                                     dataCheck refuses such a map (throws).
//
// The comparison is deep equality of the getters' plain-JSON answers, except
// for these differences, which no shopper sees (each is what the renderers
// already do with the answer; P4-CUTOVER may move them into
// lib/migrate/allowed-differences.js):
//   1. a section's `id` and `legacyKey` (any object with a `kind`): the old
//      index keys (i-<n>) become the section's sec_l<n> id. Ids only reach
//      the page as the data-sec attribute, which the MIG-02 DOM comparison
//      also strips;
//   2. a field one side leaves out and the other holds as "", null or [] (an
//      old row that never had the field reads as empty), and `enabled` left
//      out against `enabled: true` (left out means shown);
//   3. resolvedSurfaceTemplates: only the header and footer are compared, the
//      two the layout reads (the product and collection templates are
//      compared through resolvedSurfaceTemplateFor);
//   4. resolvedHomePage: the hero's settings are compared as the home page
//      renders them, with today's fallbacks under any key the stored hero
//      lacks (heroWithDefaults in app/(storefront)/page.js). This is how the
//      default hero keeps following the store name;
//   5. resolvedContentPageList: each row's slug, title, enabled, source and
//      family (the footer, the sitemap and the checkout read these; the
//      draft list's updated_at is the console's). Journal posts are left out
//      of both sides: the documents list never carries them (P2-READ), the
//      footer and the sitemap filter them out, and resolvedJournalEntries is
//      compared on its own. A journal post whose address the checkout's
//      policy links would pick (privacy, terms, refund, return, shipping,
//      delivery) is kept in, so that case still shows as a difference;
//   6. resolvedJournalEntries: each post's slug, title, description, family
//      and dates (the journal list and the sitemap read these; the old loop
//      also carried each post's sections, which no reader of the list uses);
//   7. resolvedProductOverride (P4-OVL07): each module's title and html, in
//      order, and the badge, the two things the product page reads. A store
//      on a v1 release (or drafts) answers the table row, with product_id
//      and updated_at, or null for a product with none; null is no modules
//      and no badge. Module HTML is compared exactly: HTML that today's
//      sanitizer rewrites (stored before sanitizing at save) is a difference.
import { defaultHero } from "../cms/defaults.js";
import { siteName } from "../site.js";
import { legacyHeroToSettings } from "../registry/legacy.js";
import { DOCUMENTS_RELEASE_VERSION } from "../releases.js";
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const ENTITY_GETTERS = Object.freeze(["resolvedProductOverride", "resolvedCollectionPins", "resolvedPdpPairs"]);
export const NON_ENTITY_GETTERS = Object.freeze([
  "resolvedAnnouncement",
  "resolvedHero",
  "resolvedHomeSections",
  "resolvedHomePage",
  "resolvedNav",
  "resolvedCollectionsIndex",
  "resolvedPdpExtras",
  "resolvedContentPage",
  "resolvedContentPageList",
  "resolvedJournalEntries",
  "resolvedBrand",
  "resolvedTheme",
  "resolvedSurfaceTemplates",
  "resolvedSurfaceTemplateFor",
  "resolvedCartUpsell",
  "resolvedSlugRedirect",
]);

// A per-product or per-collection template choice is entity content.
export const isEntityRoute = ([fn, args]) =>
  ENTITY_GETTERS.includes(fn) || (fn === "resolvedSurfaceTemplateFor" && Array.isArray(args) && args[1] != null && ["pdp", "collection", "product"].includes(args[0]));

const BASE_ROUTES = [
  ["resolvedAnnouncement", []],
  ["resolvedHero", []],
  ["resolvedHomeSections", []],
  ["resolvedHomePage", []],
  ["resolvedNav", ["header"]],
  ["resolvedNav", ["footer"]],
  ["resolvedCollectionsIndex", []],
  ["resolvedPdpExtras", []],
  ["resolvedContentPage", ["no-such-page"]],
  ["resolvedContentPageList", []],
  ["resolvedJournalEntries", []],
  ["resolvedBrand", []],
  ["resolvedTheme", []],
  ["resolvedSurfaceTemplates", []],
  ["resolvedSurfaceTemplateFor", ["pdp", null]],
  ["resolvedSurfaceTemplateFor", ["collection", null]],
  ["resolvedSurfaceTemplateFor", ["header", null]],
  ["resolvedSurfaceTemplateFor", ["footer", null]],
  ["resolvedCartUpsell", [[]]],
  ["resolvedCartUpsell", [[], { limit: 8 }]],
  ["resolvedSlugRedirect", ["no-such-address"]],
];

const routeKey = ([fn, args]) => `${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`;

export function routesFor(source, extra = []) {
  const out = [];
  const seen = new Set();
  const add = (r) => {
    const k = routeKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push([r[0], JSON.parse(JSON.stringify(r[1]))]);
  };
  for (const r of BASE_ROUTES) add(r);
  const slugs = new Set();
  const froms = new Set();
  for (const p of source?.raw?.cms_pages ?? []) if (typeof p.slug === "string") slugs.add(p.slug);
  for (const r of source?.raw?.page_redirects ?? []) if (typeof r.from_slug === "string") froms.add(r.from_slug), slugs.add(String(r.to_slug));
  const live = source?.state?.live?.state === "live" ? source.state.live.release.content : null;
  if (isObj(live)) {
    for (const p of Array.isArray(live.pages) ? live.pages : []) if (typeof p?.slug === "string") slugs.add(p.slug);
    for (const r of Array.isArray(live.redirects) ? live.redirects : []) if (typeof r?.from_slug === "string") froms.add(r.from_slug), slugs.add(String(r.to_slug));
  }
  for (const s of source?.codeDefaultPages ?? []) slugs.add(s);
  for (const s of [...slugs].sort()) add(["resolvedContentPage", [s]]);
  for (const s of [...froms].sort()) add(["resolvedSlugRedirect", [s]]);
  for (const r of extra) if (Array.isArray(r) && typeof r[0] === "string") add([r[0], Array.isArray(r[1]) ? r[1] : []]);
  return out;
}

const EMPTY = (v) => v === "" || v === null || (Array.isArray(v) && v.length === 0);

export function sameForShoppers(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameForShoppers(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const section = Object.hasOwn(a, "kind") || Object.hasOwn(b, "kind");
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (section && (k === "id" || k === "legacyKey")) continue;
      const inA = Object.hasOwn(a, k) && a[k] !== undefined;
      const inB = Object.hasOwn(b, k) && b[k] !== undefined;
      if (inA && inB) {
        if (!sameForShoppers(a[k], b[k])) return false;
      } else if (inA || inB) {
        const v = inA ? a[k] : b[k];
        if (!(EMPTY(v) || (k === "enabled" && v === true))) return false;
      }
    }
    return true;
  }
  return a === b;
}

// What one getter's answer is compared as (rules 3 and 4 above).
function comparable(fn, value) {
  if (!isObj(value) && !Array.isArray(value)) return value;
  if (isObj(value) && Object.hasOwn(value, "threw")) return value;
  const v = value.ok;
  if (fn === "resolvedSurfaceTemplates" && isObj(v)) return { ok: { header: v.header, footer: v.footer } };
  if (fn === "resolvedContentPageList" && Array.isArray(v))
    return {
      ok: v
        .filter((r) => !(isObj(r) && r.family === "journal" && !CHECKOUT_POLICY_SLUG.test(String(r.slug))))
        .map((r) => (isObj(r) ? { slug: r.slug, title: r.title, enabled: r.enabled, source: r.source, family: r.family } : r)),
    };
  if (fn === "resolvedJournalEntries" && Array.isArray(v))
    return { ok: v.map((r) => (isObj(r) ? { slug: r.slug, title: r.title, description: r.description, family: r.family, effective_at: r.effective_at, window_start: r.window_start, window_end: r.window_end } : r)) };
  if (fn === "resolvedProductOverride" && (isObj(v) || v === null)) {
    const modules = Array.isArray(v?.modules) ? v.modules : [];
    return { ok: { modules: modules.map((m) => (isObj(m) ? { title: m.title ?? "", html: m.html ?? "" } : m)), badge: v?.badge || "" } };
  }
  if (fn === "resolvedHomePage" && Array.isArray(v)) {
    const fallbacks = legacyHeroToSettings(defaultHero(siteName()));
    return { ok: v.map((s) => (isObj(s) && s.kind === "hero" ? { ...s, settings: { ...fallbacks, ...(isObj(s.settings) ? s.settings : {}) } } : s)) };
  }
  return value;
}

// P4-CUTOVER: one getter's two answers compared by the rules above (the
// cutover's suite compares what shoppers get before and after a move with it).
export const sameAnswer = (fn, a, b) => sameForShoppers(comparable(fn, plain(a)), comparable(fn, plain(b)));

// ---- P4-OVL07: the entity routes ----------------------------------------------------------

const parseJson = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const ids = (list, key) => (Array.isArray(list) ? list.filter(isObj).map((r) => r[key]).filter((x) => typeof x === "string" && x) : []);
const pairSources = (list) => (Array.isArray(list) ? list.filter((p) => isObj(p) && p.kind === "pdp_pairs").map((p) => p.source_product_id).filter((x) => typeof x === "string" && x) : []);
const templateIds = (st, key) => (isObj(st) && isObj(st[key]) ? Object.keys(st[key]) : []);

// The pairs the product page asks for (4), and the whole list (the most a
// founder can pick), so a limit can never hide a difference.
export const ENTITY_PAIR_LIMITS = Object.freeze([undefined, { limit: 12 }]);

// Every product and collection id with entity content, on either side.
export function entityIdsOf(mapped) {
  const source = mapped?.source ?? {};
  const raw = isObj(source.raw) ? source.raw : {};
  const live = source?.state?.live?.state === "live" ? source.state.live.release?.content : null;
  const rel = isObj(live) ? live : {};
  const st = parseJson((Array.isArray(raw.cms_blocks) ? raw.cms_blocks : []).find((b) => b.key === "surface_templates")?.value, null);
  const relSt = isObj(rel.blocks) ? rel.blocks.surface_templates : null;
  const products = new Set([
    ...ids(raw.product_overrides, "product_id"),
    ...pairSources(raw.placements),
    ...templateIds(st, "products"),
    ...ids(rel.product_overrides, "product_id"),
    ...pairSources(rel.placements),
    ...templateIds(relSt, "products"),
    ...ids(raw.product_content_live, "product_id"),
    ...ids(mapped?.liveRows?.product, "product_id"),
    ...(mapped?.documents ?? []).filter((d) => d.type === "product_content" && typeof d.entityId === "string").map((d) => d.entityId),
  ]);
  const collections = new Set([
    ...ids(raw.collection_overrides, "collection_id"),
    ...templateIds(st, "collections"),
    ...ids(rel.collection_pins, "collection_id"),
    ...templateIds(relSt, "collections"),
    ...ids(raw.collection_content_live, "collection_id"),
    ...ids(mapped?.liveRows?.collection, "collection_id"),
    ...(mapped?.documents ?? []).filter((d) => d.type === "collection_content" && typeof d.entityId === "string").map((d) => d.entityId),
  ]);
  return { products: [...products].sort(), collections: [...collections].sort() };
}

// The routes for those ids. A collection's pins are asked for by its handle
// (the catalog's, one SELECT); a collection not in the catalog has no page,
// so only its template is compared.
export async function entityRoutesFor(mapped) {
  const { products, collections } = entityIdsOf(mapped);
  const out = [];
  for (const id of products) {
    out.push(["resolvedProductOverride", [id]]);
    for (const opts of ENTITY_PAIR_LIMITS) out.push(["resolvedPdpPairs", opts ? [id, opts] : [id]]);
    out.push(["resolvedSurfaceTemplateFor", ["pdp", id]]);
  }
  const handles = new Map();
  for (let i = 0; i < collections.length; i += 200) {
    const part = collections.slice(i, i + 200);
    try {
      const r = await libsql.execute({ sql: `SELECT id, handle FROM collections WHERE id IN (${part.map(() => "?").join(", ")})`, args: part });
      for (const row of r.rows) handles.set(String(row.id), String(row.handle));
    } catch (e) {
      if (!notMigratedYet(e, { table: "collections" })) throw e;
    }
  }
  for (const id of collections) {
    if (handles.has(id)) out.push(["resolvedCollectionPins", [handles.get(id)]]);
    out.push(["resolvedSurfaceTemplateFor", ["collection", id]]);
  }
  return out;
}

// mapped.liveRows as the candidate's entityRows (keyed by entity id).
export function entityRowsOf(liveRows) {
  const map = (list, key) => new Map((Array.isArray(list) ? list : []).filter((r) => isObj(r) && typeof r[key] === "string").map((r) => [r[key], r]));
  return { product: map(liveRows?.product, "product_id"), collection: map(liveRows?.collection, "collection_id") };
}

// app/(storefront)/checkout/page.js policyLinks: the slugs it links by
const CHECKOUT_POLICY_SLUG = /privacy|terms|refund|return|shipping|delivery/;

const settle = async (fn) => {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { threw: String(e?.code || e?.name || "Error"), message: String(e?.message || e) };
  }
};
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

/**
 * The data check for a mapping (map.js mapTenant's output), in the tenant's
 * context. `routes`: routesFor(...) by default; the entity routes of every
 * product and collection with content are always added (entityRoutesFor).
 * `entities`: "mapped" (the dry run: the candidate holds mapped.liveRows and
 * nothing else) or "live" (the candidate reads the live tables: after a
 * backfill, before the flip).
 */
export function assertHeldBodies(bodies) {
  if (!(bodies instanceof Map)) throw new Error("dataCheck: the bodies must be a Map of version id to { document_id, body }");
  for (const [id, v] of bodies) {
    if (typeof id !== "string" || !id) throw new Error("dataCheck: a held version has no id");
    if (v == null || v.body == null || typeof v.body !== "object") throw new Error(`dataCheck: the held version ${id} has no body, so the comparison would read it from the database instead`);
  }
  return bodies;
}

export async function dataCheck(mapped, { routes, entities = "mapped" } = {}) {
  if (entities !== "mapped" && entities !== "live") throw new Error(`dataCheck: entities must be "mapped" or "live", not ${JSON.stringify(entities)}`);
  if (!mapped?.list) return { ran: false, reason: mapped?.state?.published === "none" ? "NOTHING_PUBLISHED" : "REFUSED", compared: 0, skipped: 0, differences: [] };
  assertHeldBodies(mapped.bodies);
  const Res = await import("../content/resolve.js");
  const legacySrc = await Res.contentSource();
  if (legacySrc?.v === DOCUMENTS_RELEASE_VERSION) return { ran: false, reason: "LIVE_IS_DOCUMENTS", compared: 0, skipped: 0, differences: [] };
  const legacy = Res.contentGettersFor(legacySrc);
  const entityRows = entities === "mapped" ? entityRowsOf(mapped.liveRows) : null;
  const candidate = Res.contentGettersFor(Res.candidateSource({ list: mapped.list, bodies: mapped.bodies, releaseId: mapped.releaseId, entityRows }));
  const extra = await entityRoutesFor(mapped);
  const seen = new Set();
  const list = [];
  for (const r of [...(routes ?? routesFor(mapped.source)), ...extra]) {
    const k = routeKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(r);
  }
  const differences = [];
  let compared = 0;
  let entityRoutes = 0;
  for (const [fn, args] of list) {
    if (isEntityRoute([fn, args])) entityRoutes++;
    compared++;
    // a getter added to resolve.js but not to contentGettersFor answers as a
    // difference, never as a pass
    const a = plain(await settle(() => legacy[fn](...args)));
    const b = plain(await settle(() => candidate[fn](...args)));
    if (!sameForShoppers(comparable(fn, a), comparable(fn, b))) differences.push({ fn, args, legacy: a, candidate: b });
  }
  return { ran: true, compared, skipped: 0, entityRoutes, entities, differences };
}
