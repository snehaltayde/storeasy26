// P4-OVL07 (MIG-01, OVL-02, ED-12; spec 8.3, 8.11): the entity part of the
// MIG-01 mapper. Replaces P4-MAPPER's stub. The product and collection
// content documents a legacy store's extras become, and the live rows a
// cutover writes for what is published (P4-LIVEROW's liveRowFor, the very
// function a publish uses).
//
//   mapEntities(source, ctx) -> Promise<{
//     built,       true
//     documents,   [{ id, type, slug: null, entityId, label, draft, draftHash,
//                     published: { versionId, bodyHash, body } | null,
//                     publishedHash, dirty, warnings }]
//     bodies,      Map versionId -> { document_id, body, schema_version }
//     liveRows,    { product: [row], collection: [row] }   (rows carry their
//                  product_id / collection_id)
//     refs,        [{ version_id, ref_type, ref_id }]
//     holds,       counts of the entity content the source holds, plus what
//                  the mapping had to leave out or change (see `notes`);
//                  P4-CUTOVER adds modulesEmpty and badgesBlank (a module
//                  with no title or no text, a badge of only spaces: shown by
//                  the old product page, left out by the new one) and
//                  `dropped`, the same by product and side, for the report
//     notes,       [{ side, what, reason, ... }] for the report and CUTOVER
//   }>
//
//   source   what map.js read (readLegacySource): source.raw holds the live
//            tables, source.state.live the live release (its frozen arrays)
//   ctx      { published: 'release' | 'release+tables' | 'drafts' | 'none' | null,
//              release: the live release content or null,
//              existing: Map "<type>\u0000<entity id>" -> the documents row
//              already there (a phase-3 random id is reused, never duplicated) }
//
// What maps to what (each side read the way shoppers read it today):
//   product_overrides modules  rich_text sections {title, html}, in order. The
//                              html goes through today's sanitizer (the one a
//                              save uses), so HTML stored before sanitizing
//                              existed shows as a difference in the data
//                              check. Nothing is cut: a 7th module, a long
//                              title or long text are carried, with the
//                              editor's inherited warnings.
//   product_overrides badge    settings.badge (null when empty)
//   placements pdp_pairs       settings.pairs {title, products}: the FIRST
//                              ENABLED placement by position for each source
//                              product (lib/cms/placements.js getPdpPairs). A
//                              switched-off placement is never published, and
//                              later placements of the same product never
//                              showed: both are left out and noted.
//   surface_templates.products settings.template (a choice the product page
//                              offers; another value never showed: noted)
//   collection_overrides       collection_content settings.pinned
//   surface_templates.collections
//                              collection_content settings.template
//
// Sides: the drafts are the live tables (cms_blocks for the templates). The
// published side follows the store's state: a v2 or v3 release's frozen
// arrays (product_overrides, placements, collection_pins) and its
// surface_templates block; a v1 release never froze the arrays, so those come
// from the live tables, as v1 shoppers read them, and its surface_templates
// block from the release; a store open with no release publishes its drafts;
// a store that never launched (or is refused) publishes nothing.
//
// Ids: an existing (type, entity_id) row's id, else productDocumentId /
// collectionDocumentId. Versions are content-addressed (ids.js
// migratedVersion), so mapping twice gives the same ids.
//
// Pure apart from Web Crypto: no database read here (map.js reads).
import { SCHEMA_VERSION, emptyBody, sectionType, documentType, sanitize, validateDocument } from "../registry/index.js";
import { productModuleNotes } from "../registry/document-types.js";
import { SURFACE_TEMPLATE_CHOICES } from "../cms/defaults.js";
import { productDocumentId, collectionDocumentId } from "../documents/ids.js";
import { liveRowFor } from "../documents/live-rows.js";
import { refRows } from "../documents/refs.js";
import { migratedVersion, draftHash as hashDraft } from "./ids.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const len = (v) => (Array.isArray(v) ? v.length : 0);

const parse = (v, fallback) => {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const templates = (st) => (isObj(st) ? Object.keys(isObj(st.products) ? st.products : {}).length + Object.keys(isObj(st.collections) ? st.collections : {}).length : 0);

// What entity content a source holds (the live tables and the live release's
// frozen arrays), whether or not all of it shows.
export function entityHoldings(source) {
  const raw = isObj(source?.raw) ? source.raw : {};
  const live = source?.state?.live?.state === "live" ? source.state.live.release?.content : null;
  const rel = isObj(live) && live.v >= 2 ? live : null;
  const pairs = (list) => (Array.isArray(list) ? list.filter((p) => isObj(p) && p.kind === "pdp_pairs").length : 0);
  const st = (Array.isArray(raw.cms_blocks) ? raw.cms_blocks : []).find((b) => b.key === "surface_templates");
  return {
    products: len(raw.product_overrides) + (rel ? len(rel.product_overrides) : 0),
    collections: len(raw.collection_overrides) + (rel ? len(rel.collection_pins) : 0),
    pairs: pairs(raw.placements) + (rel ? pairs(rel.placements) : 0),
    templates: templates(parse(st?.value, null)) + (isObj(live?.blocks) ? templates(live.blocks.surface_templates) : 0),
  };
}

// ---- one side ------------------------------------------------------------------------------
//
// A side is { products: Map id -> {modules, badge, pairs, template},
// collections: Map id -> {pinned, template} } of what that side shows.

const enabled = (p) => p.enabled !== false && p.enabled !== 0 && p.enabled !== "0";

// pdp_pairs placements -> Map source product -> the placement shoppers see
// (the first enabled one by position; ties keep the stored order).
function pairsBySource(rows, note) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => isObj(p) && p.kind === "pdp_pairs");
  const out = new Map();
  for (const { p } of list.filter(({ p }) => !enabled(p))) note({ what: "pairs", reason: "switched_off", product: p.source_product_id ?? null, placement: p.id ?? null });
  const on = list.filter(({ p }) => enabled(p)).sort((a, b) => (Number(a.p.position) || 0) - (Number(b.p.position) || 0) || a.i - b.i);
  for (const { p } of on) {
    const src = typeof p.source_product_id === "string" && p.source_product_id ? p.source_product_id : null;
    if (!src) continue;
    if (out.has(src)) {
      note({ what: "pairs", reason: "never_shown", product: src, placement: p.id ?? null, title: p.title ?? null });
      continue;
    }
    const targets = parse(p.target_product_ids, []);
    out.set(src, { title: typeof p.title === "string" && p.title ? p.title : null, products: Array.isArray(targets) ? targets.filter((x) => typeof x === "string" && x) : [], placement: p.id ?? null });
  }
  return out;
}

function templateMap(st, key, surface, note) {
  const out = new Map();
  const map = isObj(st) && isObj(st[key]) ? st[key] : {};
  for (const [id, pick] of Object.entries(map)) {
    if (typeof pick === "string" && (SURFACE_TEMPLATE_CHOICES[surface] || []).includes(pick)) out.set(id, pick);
    else note({ what: "template", reason: "not_a_layout", surface, entity: id, value: pick ?? null });
  }
  return out;
}

function sideOf({ overrides, placements, pins, surfaceTemplates }, note) {
  const products = new Map();
  const collections = new Map();
  const product = (id) => {
    if (!products.has(id)) products.set(id, { modules: [], badge: null, pairs: null, template: null, has: false });
    return products.get(id);
  };
  const collection = (id) => {
    if (!collections.has(id)) collections.set(id, { pinned: null, template: null, has: false });
    return collections.get(id);
  };
  for (const r of Array.isArray(overrides) ? overrides : []) {
    if (!isObj(r) || typeof r.product_id !== "string" || !r.product_id) continue;
    const e = product(r.product_id);
    const modules = parse(r.modules, []);
    e.modules = Array.isArray(modules) ? modules : [];
    e.badge = typeof r.badge === "string" && r.badge ? r.badge : null;
    e.has = e.has || e.modules.length > 0 || e.badge != null;
  }
  for (const [id, pr] of pairsBySource(placements, note)) {
    const e = product(id);
    e.pairs = pr;
    e.has = true;
  }
  for (const [id, pick] of templateMap(surfaceTemplates, "products", "pdp", note)) {
    const e = product(id);
    e.template = pick;
    e.has = true;
  }
  for (const r of Array.isArray(pins) ? pins : []) {
    if (!isObj(r) || typeof r.collection_id !== "string" || !r.collection_id) continue;
    const list = parse(r.pinned, []);
    const e = collection(r.collection_id);
    e.pinned = Array.isArray(list) ? list.filter((x) => typeof x === "string" && x) : [];
    e.has = e.has || e.pinned.length > 0;
  }
  for (const [id, pick] of templateMap(surfaceTemplates, "collections", "collection", note)) {
    const e = collection(id);
    e.template = pick;
    e.has = true;
  }
  return { products, collections };
}

const blockValue = (rows, key) => {
  const row = (Array.isArray(rows) ? rows : []).find((b) => b.key === key);
  return row ? parse(row.value, null) : null;
};

function draftSide(source, note) {
  const raw = source.raw;
  return sideOf(
    { overrides: raw.product_overrides, placements: raw.placements, pins: raw.collection_overrides, surfaceTemplates: blockValue(raw.cms_blocks, "surface_templates") },
    note,
  );
}

function publishedSide(source, ctx, note) {
  const raw = source.raw;
  const rel = isObj(ctx.release) ? ctx.release : null;
  const relTemplates = isObj(rel?.blocks) ? rel.blocks.surface_templates ?? null : null;
  if (ctx.published === "release")
    return sideOf({ overrides: rel?.product_overrides, placements: rel?.placements, pins: rel?.collection_pins, surfaceTemplates: relTemplates }, note);
  if (ctx.published === "release+tables")
    return sideOf({ overrides: raw.product_overrides, placements: raw.placements, pins: raw.collection_overrides, surfaceTemplates: relTemplates }, note);
  if (ctx.published === "drafts") return draftSide(source, note);
  return null; // nothing published (not launched, or refused)
}

// ---- bodies ---------------------------------------------------------------------------------

const moduleId = (i) => `sec_m${i}`;

export function productBody(e, note = () => {}) {
  const body = emptyBody("product_content");
  // a badge of only spaces shows on the old product page; the new reader
  // treats it as no badge (liveRowFor), so it is named, never dropped quietly
  if (typeof e.badge === "string" && e.badge && !e.badge.trim()) note({ what: "badge", reason: "blank", value: e.badge });
  body.settings = { ...body.settings, badge: e.badge ?? null, template: e.template ?? null, pairs: e.pairs ? { title: e.pairs.title ?? null, products: [...e.pairs.products] } : null };
  const v = sectionType("rich_text").version;
  body.sections = [];
  e.modules.forEach((m, i) => {
    if (!isObj(m)) {
      note({ what: "module", reason: "not_an_object", index: i, value: m });
      return;
    }
    const title = m.title == null ? "" : String(m.title);
    const raw = m.html == null ? "" : String(m.html);
    const html = sanitize(raw);
    if (html !== raw) note({ what: "module", reason: "resanitized", index: i, title });
    // P4-CUTOVER (from the P4-OVL07 review): a module with no title or no
    // text shows on the old product page, but the new reader (and liveRowFor)
    // leaves it out, so the data check shows the product as changed. Named
    // here, so the report can say why.
    if (!title || !html) note({ what: "module", reason: "empty", index: i, title, emptyTitle: !title, emptyText: !html });
    body.sections.push({ id: moduleId(i), kind: "rich_text", v, enabled: true, settings: { title, html }, blocks: [] });
  });
  return body;
}

export function collectionBody(e) {
  const body = emptyBody("collection_content");
  body.settings = { ...body.settings, pinned: e.pinned && e.pinned.length ? [...e.pinned] : null, template: e.template ?? null };
  return body;
}

// ---- the mapping ------------------------------------------------------------------------------

const KINDS = [
  { type: "product_content", side: "products", body: productBody, docId: productDocumentId, key: "product_id" },
  { type: "collection_content", side: "collections", body: collectionBody, docId: collectionDocumentId, key: "collection_id" },
];

export async function mapEntities(source, ctx = {}) {
  const notes = [];
  const note = (side, entity) => (n) => notes.push({ side, ...(entity ? { entity } : {}), ...n });
  const drafts = draftSide(source, note("draft"));
  const published = publishedSide(source, ctx, note("published"));
  const existing = ctx.existing instanceof Map ? ctx.existing : new Map();
  const publishedAt = source?.raw?.live_release?.[0]?.published_at ?? null;

  const documents = [];
  const bodies = new Map();
  const liveRows = { product: [], collection: [] };
  const refs = [];
  for (const k of KINDS) {
    const ids = [...new Set([...drafts[k.side].keys(), ...(published ? published[k.side].keys() : [])])].sort();
    for (const entityId of ids) {
      const d = drafts[k.side].get(entityId);
      const p = published ? published[k.side].get(entityId) : null;
      if (!d?.has && !p?.has) continue;
      const draft = d?.has ? k.body(d, note("draft", entityId)) : emptyBody(k.type);
      const pubBody = p?.has ? k.body(p, note("published", entityId)) : null;
      const row = existing.get(`${k.type}\u0000${entityId}`);
      const id = row?.id ?? (await k.docId(entityId));
      const draftHashV = await hashDraft(draft);
      let pub = null;
      let publishedHashV = null;
      if (pubBody) {
        const v = await migratedVersion(id, pubBody);
        pub = { versionId: v.id, bodyHash: v.bodyHash, body: pubBody };
        publishedHashV = await hashDraft(pubBody);
        bodies.set(v.id, { document_id: id, body: pubBody, schema_version: SCHEMA_VERSION });
        refs.push(...refRows(v.id, pubBody));
        const live = liveRowFor(k.type, pubBody, { documentId: id, versionId: v.id, publishedAt, entityId });
        liveRows[k.type === "product_content" ? "product" : "collection"].push(live);
      }
      const warnings = k.type === "product_content" ? productModuleNotes(draft).map((n) => n.code) : [];
      documents.push({
        id,
        type: k.type,
        slug: null,
        entityId,
        label: documentType(k.type).label,
        draft,
        draftHash: draftHashV,
        published: pub,
        publishedHash: publishedHashV,
        dirty: draftHashV !== publishedHashV,
        warnings,
        reused: row != null,
      });
    }
  }

  const count = (pred) => notes.filter(pred).length;
  return {
    built: true,
    documents,
    bodies,
    liveRows,
    refs,
    holds: {
      ...entityHoldings(source),
      pairsNotShown: count((n) => n.what === "pairs"),
      modulesResanitized: count((n) => n.what === "module" && n.reason === "resanitized"),
      modulesLeftOut: count((n) => n.what === "module" && n.reason !== "resanitized" && n.reason !== "empty"),
      templatesNotShown: count((n) => n.what === "template"),
      // P4-CUTOVER: modules with no title or no text, and badges of only
      // spaces, which the old product page shows and the new one doesn't
      modulesEmpty: count((n) => n.what === "module" && n.reason === "empty"),
      badgesBlank: count((n) => n.what === "badge"),
      // which products, and on which side (the published side is what
      // shoppers see change; the report names them)
      dropped: notes
        .filter((n) => (n.what === "module" && n.reason === "empty") || n.what === "badge")
        .map((n) => ({ side: n.side, product: n.entity ?? null, what: n.what, ...(n.what === "module" ? { index: n.index, title: n.title, emptyTitle: n.emptyTitle, emptyText: n.emptyText } : {}) })),
    },
    notes,
  };
}

// The strict check of one mapped body (tests and CUTOVER): validateDocument in
// publish mode, plus the inherited product-module notes.
export function entityIssues(body) {
  const r = validateDocument(body, { mode: "publish" });
  return { errors: r.issues.filter((i) => i.severity === "error").map((i) => i.code), notes: productModuleNotes(body).map((n) => n.code) };
}
