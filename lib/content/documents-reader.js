// P2-READ (PUB-01, PERF-01, DOC-07): the version 4 shopper reader.
//
// A v4 release holds a small list, never bodies (spec 8.4):
//   { v: 4, m, documents: { doc_x: {version, hash} | null }, pages, redirects,
//     indexes: { journal: {version, hash} | null } }
// This module
//   · checks that list (parseList),
//   · fetches only the versions a route needs, by id IN (…), once per request
//     for the same set (liveVersions, React cache keyed by the sorted ids),
//   · upgrades each body in memory with the registry's pure migrate steps
//     (the stored body is never rewritten),
//   · and maps each body onto the shape today's getters already return, so
//     every component keeps rendering what it renders today.
//
// Fail closed: a list that can't be read, a required singleton missing from
// it, or a listed version missing after one re-read is ContentUnavailableError.
// Never a draft, never a code default. A null entry is the explicit code
// default, and so is a singleton that shipped after the list was written
// (its sinceManifest is above the list's m).
//
// Edge-safe: no node: imports. React cache, ../db.js and pure modules only.
import { cache } from "react";
import { libsql } from "../db.js";
import { documentType, singletonTypes, upgradeBody, sectionType, linkHref, validateDocument, SCHEMA_VERSION } from "../registry/index.js";
import { settingsToLegacyHero } from "../registry/legacy.js";
import { isV4List, emptyList as emptyReleaseList } from "../documents/release-list.js";
import { DEFAULT_ANNOUNCEMENT } from "../cms/defaults.js";
import { unfinishedTitle, unfinishedText, unfinishedHtml } from "./unfinished.js";

// S53 (audit A2): thrown when published content SHOULD exist but cannot be
// read or validated. The storefront's error boundary renders: shoppers never
// silently receive drafts because a release read failed. Defined here so the
// v4 reader can throw it; lib/content/resolve.js re-exports it.
export class ContentUnavailableError extends Error {
  constructor(detail) {
    super("published content unavailable");
    this.code = "CONTENT_UNAVAILABLE";
    this.detail = detail;
  }
}

// True for ContentUnavailableError, also when a bundler has loaded this
// module twice (the class would then differ, the code would not).
export const isContentUnavailable = (e) => e instanceof ContentUnavailableError || e?.code === "CONTENT_UNAVAILABLE";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const unavailable = (code, extra = {}) => new ContentUnavailableError({ code, ...extra });

// The documents each part of the storefront reads, as fixed sets, so every
// getter of one part asks liveVersions for the SAME ids and the per-request
// cache makes it one statement (PERF-01).
//   chrome  the layout: header, footer, announcement bar, brand
//   home    the home page: hero and sections, and the curated collections
//           (the home page reads both, so they come in one statement)
export const CHROME_DOCUMENTS = Object.freeze(["doc_header", "doc_footer", "doc_announcement", "doc_design"]);
export const HOME_DOCUMENTS = Object.freeze(["doc_home", "doc_collections_index"]);
export const PRODUCT_LAYOUT_DOCUMENTS = Object.freeze(["doc_product_layout"]);
export const COLLECTION_LAYOUT_DOCUMENTS = Object.freeze(["doc_collection_layout"]);
export const CART_DOCUMENTS = Object.freeze(["doc_cart"]);

// ---- the list --------------------------------------------------------------------

function checkEntry(entry, where) {
  if (entry === null) return null;
  if (!isObj(entry) || typeof entry.version !== "string" || !entry.version.startsWith("ver_") || typeof entry.hash !== "string" || !entry.hash) {
    throw unavailable("BAD_LIST", { where });
  }
  return { version: entry.version, hash: entry.hash };
}

// The v4 list, checked against the registry's manifest. Returns a list whose
// `documents` holds an explicit null for every registered singleton that came
// after the list's manifest. Throws ContentUnavailableError otherwise.
export function parseList(content, { releaseId = null } = {}) {
  if (!isV4List(content)) throw unavailable("BAD_LIST", { release: releaseId, where: "shape" });
  const m = content.m;
  if (!Number.isInteger(m) || m < 1) throw unavailable("BAD_LIST", { release: releaseId, where: "m" });
  const documents = {};
  for (const [id, entry] of Object.entries(content.documents)) documents[id] = checkEntry(entry, id);
  for (const type of singletonTypes()) {
    const id = `doc_${type}`;
    if (Object.hasOwn(documents, id)) continue;
    // spec 8.4: missing is an error only when the list's manifest already
    // carried this singleton; a singleton that shipped later reads as default
    if (documentType(type).sinceManifest <= m) throw unavailable("MISSING_SINGLETON", { release: releaseId, document: id, m });
    documents[id] = null;
  }
  const pages = content.pages.map((p) => {
    if (!isObj(p) || typeof p.slug !== "string" || !p.slug || typeof p.document !== "string") throw unavailable("BAD_LIST", { release: releaseId, where: "pages" });
    return p;
  });
  const redirects = content.redirects.filter((r) => isObj(r) && typeof r.from_slug === "string" && typeof r.to_slug === "string");
  const journal = checkEntry(content.indexes.journal ?? null, "indexes.journal");
  return { v: 4, m, documents, pages, redirects, indexes: { journal } };
}

// The listed entry of a document: {version, hash}, or null for the code
// default (null in the list, or not listed at all).
export const entryOf = (list, id) => (Object.hasOwn(list.documents, id) ? list.documents[id] : null);

// ---- the closed store (PUB-06) -----------------------------------------------------
//
// A store in documents mode that has never published is closed. Its content
// source is v4-shaped over this list, so every getter takes its ordinary v4
// path and nothing has a closed branch of its own (default-deny):
//   · no documents, no pages, no redirects, no journal index;
//   · `neutral`: every document a getter asks for is an empty body of its type
//     (documentBodies below), never null. null is "the code default", and the
//     code defaults carry copy (the default hero, DEFAULT_HOME_SECTIONS, the
//     default policy pages), which a closed store must not show;
//   · the header and footer are an empty custom menu, as the P2-VGATE neutral
//     chrome is: an "auto" menu would list the catalog's collections.
// Nothing is read from the database for it. A getter that asks for a version
// by id (a page, the journal index) finds none listed; asking anyway would
// fail closed (MISSING_VERSION), never fall back.
export function emptyList() {
  return { v: 4, m: currentManifest(), documents: {}, pages: [], redirects: [], indexes: { journal: null }, neutral: true };
}

// The registry's manifest number now: the highest sinceManifest of any singleton.
const currentManifest = () => Math.max(1, ...singletonTypes().map((t) => documentType(t).sinceManifest || 1));

// false for the closed list: the getters' code-default pages (lib/content/
// pages.js, for the brand's own stores) are not served from it either.
export const usesCodeDefaults = (list) => list?.neutral !== true;

const NEUTRAL_SETTINGS = { header: { mode: "custom", items: [] }, footer: { mode: "custom", items: [] } };
function neutralBody(id) {
  const type = id.startsWith("doc_") ? id.slice(4) : null;
  return { schema: SCHEMA_VERSION, type, meta: {}, settings: { ...(NEUTRAL_SETTINGS[type] || {}) }, sections: [] };
}

// ---- version bodies ----------------------------------------------------------------

async function readVersions(ids) {
  const r = await libsql.execute({
    sql: `SELECT id, document_id, body, schema_version FROM document_versions WHERE id IN (${ids.map(() => "?").join(", ")})`,
    args: ids,
  });
  const out = new Map();
  for (const row of r.rows) out.set(String(row.id), { document_id: String(row.document_id), body: String(row.body), schema_version: Number(row.schema_version) });
  return out;
}

function parseVersion(id, row) {
  let body;
  try {
    body = JSON.parse(row.body);
  } catch {
    throw unavailable("BAD_VERSION", { version: id });
  }
  if (!isObj(body)) throw unavailable("BAD_VERSION", { version: id });
  // A body written by newer code than this: never guess at its shape.
  const schema = body.schema ?? row.schema_version;
  if (!Number.isInteger(schema) || schema < 1 || schema > SCHEMA_VERSION || row.schema_version > SCHEMA_VERSION) {
    throw unavailable("UNKNOWN_SCHEMA", { version: id, schema: body.schema ?? null, schema_version: row.schema_version });
  }
  return { document_id: row.document_id, body: upgradeBody(body) };
}

// One request, one read per distinct set: React cache, keyed by the sorted ids
// joined into one string (cache() compares arguments by value for strings).
const fetchVersionSet = cache(async (key) => {
  const ids = key.split("\n");
  let rows = await readVersions(ids);
  let missing = ids.filter((id) => !rows.has(id));
  if (missing.length) {
    // replica lag: a version written moments ago may not have reached this
    // replica yet. One re-read of what is missing, then fail closed.
    const again = await readVersions(missing);
    for (const [k, v] of again) rows.set(k, v);
    missing = ids.filter((id) => !rows.has(id));
    if (missing.length) throw unavailable("MISSING_VERSION", { versions: missing });
  }
  const out = new Map();
  for (const id of ids) out.set(id, parseVersion(id, rows.get(id)));
  return out;
});

// Map of version id -> { document_id, body } (body upgraded), for exactly the
// given ids. A version still missing after one re-read throws.
export async function liveVersions(ids) {
  const key = [...new Set(ids)].sort().join("\n");
  if (!key) return new Map();
  return fetchVersionSet(key);
}

// The bodies of the given documents, from the list: { doc_x: body | null }.
// null is the code default. Every listed version is read in one statement.
// P2-PREVIEW: in a preview, an overlaid document's entry is marked `draft`
// and its body comes from the overlay (list.drafts), never from a version.
export async function documentBodies(list, ids) {
  if (list?.neutral === true) return Object.fromEntries(ids.map((id) => [id, neutralBody(id)])); // the closed store: no statement
  const wanted = ids.map((id) => [id, entryOf(list, id)]);
  const versions = await liveVersions(wanted.filter(([, e]) => e && !e.draft).map(([, e]) => e.version));
  const out = {};
  for (const [id, entry] of wanted) {
    if (!entry) {
      out[id] = null;
      continue;
    }
    if (entry.draft) {
      out[id] = draftOf(list, id);
      continue;
    }
    const v = versions.get(entry.version);
    // the list says doc_x is at this version: it must be doc_x's
    if (v.document_id !== id) throw unavailable("VERSION_MISMATCH", { document: id, version: entry.version, belongs_to: v.document_id });
    const type = id.startsWith("doc_") && documentType(id.slice(4))?.singleton ? id.slice(4) : null;
    if (type && v.body.type !== type) throw unavailable("VERSION_MISMATCH", { document: id, version: entry.version, type: v.body.type ?? null });
    out[id] = v.body;
  }
  return out;
}

// One version body by version id (a page, a journal post, the journal index).
export async function versionBody(versionId, { documentId = null, type = null } = {}) {
  const v = (await liveVersions([versionId])).get(versionId);
  if (documentId && v.document_id !== documentId) throw unavailable("VERSION_MISMATCH", { document: documentId, version: versionId, belongs_to: v.document_id });
  if (type && v.body.type !== type) throw unavailable("VERSION_MISMATCH", { version: versionId, type: v.body.type ?? null });
  return v.body;
}

// ---- mappers: a body -> what each getter returns today ------------------------------

const settingsOf = (body) => (isObj(body?.settings) ? body.settings : {});
const sectionsOf = (body) => (Array.isArray(body?.sections) ? body.sections.filter(isObj) : []);
const shown = (s) => s.enabled !== false;
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

export function announcementFromBody(body) {
  const s = settingsOf(body);
  const out = { ...DEFAULT_ANNOUNCEMENT, ...without(s, ["link"]) };
  out.href = linkHref(s.link) ?? "";
  return out;
}

// header / footer: "auto" (or no document) is null, the catalog-derived menu,
// exactly as an unset legacy nav block. "custom" is the items, [] included.
export function navFromBody(body) {
  if (!body) return null;
  const s = settingsOf(body);
  if (s.mode !== "custom") return null;
  const item = (it) => {
    if (!isObj(it)) return null;
    const out = { label: it.label, href: linkHref(it.link) };
    if (Array.isArray(it.children)) out.children = it.children.map(item).filter((c) => c && c.label && c.href);
    return out;
  };
  return (Array.isArray(s.items) ? s.items : []).map(item).filter((i) => i && i.label && i.href);
}

export const templateFromBody = (body) => (typeof settingsOf(body).template === "string" ? settingsOf(body).template : null);

// The hero section of a home body, or null when the home page has none shown.
export const heroSectionOf = (body) => sectionsOf(body).find((s) => s.kind === "hero" && shown(s)) || null;

export function heroFromSection(section, defaults) {
  const hero = { ...defaults, ...settingsToLegacyHero(settingsOf(section)) };
  // a preview of an unfinished hero: the hint where the missing words go
  if (section.unfinished && !(typeof hero.title === "string" && hero.title.trim())) hero.title = section.unfinished.placeholder;
  return hero;
}

// P2-PREVIEW (DOC-05, spec 8.8): drafts render in tolerant mode. A section the
// overlay marked `unfinished` (it has an incomplete or invalid field) renders
// as a plain note with its placeholder, in the founder's preview only. Live
// versions never carry the mark: the overlay adds it in memory, and a stored
// section with an unknown key is refused at save. The words live in
// ./unfinished.js, shared with the home page's renderer map.

// Registry section -> legacy home section ({id, kind, enabled, ...fields}).
// Kinds the legacy home renderer can't show are left out (P2-SECTIONS renders
// every registered kind through the renderer map).
const HOME_LEGACY = {
  collections: (s) => ({ ...s }),
  new: (s) => ({ ...s }),
  rich_text: (s) => ({ ...s }),
  banner: (s) => ({ ...without(s, ["button"]), label: s.button?.label ?? "", href: linkHref(s.button?.link) ?? "" }),
  image_with_text: (s) => ({
    ...without(s, ["image", "button"]),
    image: s.image?.media ?? "",
    image_alt: s.image?.alt ?? "",
    label: s.button?.label ?? "",
    href: linkHref(s.button?.link) ?? "",
  }),
  product_rail: (s) => {
    const out = { ...without(s, ["collection"]), collection: s.collection?.handle ?? "" };
    if (s.collection?.id) out.collection_id = s.collection.id;
    return out;
  },
};

// The shown, non-hero sections of a home body, in the legacy shape.
export function homeSectionsFromBody(body) {
  return sectionsOf(body)
    .filter((s) => shown(s) && s.kind !== "hero" && (Object.hasOwn(HOME_LEGACY, s.kind) || s.unfinished))
    .map((s) =>
      s.unfinished
        ? { id: s.id, kind: "rich_text", enabled: true, title: unfinishedTitle(s.unfinished), html: unfinishedHtml(s.unfinished), unfinished: true }
        : { id: s.id, kind: s.kind, enabled: true, ...HOME_LEGACY[s.kind](settingsOf(s)) },
    );
}

// The shown sections of a home body, registry-shaped, kinds the registry knows.
export const registrySectionsFromBody = (body) => sectionsOf(body).filter((s) => shown(s) && sectionType(s.kind));

// Registry section -> legacy page section (components/ContentPage.js).
const PAGE_LEGACY = {
  text: (s) => ({ kind: "text", ...without(s, ["title"]), heading: s.title ?? "", body: Array.isArray(s.body) ? s.body : [] }),
  rich_text: (s) => ({ kind: "rich", ...without(s, ["title"]), heading: s.title ?? "", html: s.html ?? "" }),
  image_with_text: (s) => ({ kind: "image", ...without(s, ["image", "button", "image_side", "title", "text"]), src: s.image?.media ?? "", alt: s.image?.alt ?? "", caption: s.caption ?? "" }),
  faq: (s) => ({ kind: "faq", ...without(s, ["title"]), heading: s.title ?? "", items: Array.isArray(s.items) ? s.items : [] }),
};

export const pageSectionsFromBody = (body) =>
  sectionsOf(body)
    .filter((s) => shown(s) && (Object.hasOwn(PAGE_LEGACY, s.kind) || s.unfinished))
    .map((s) =>
      s.unfinished
        ? { id: s.id, kind: "text", heading: unfinishedTitle(s.unfinished), body: [unfinishedText(s.unfinished)], unfinished: true }
        : { id: s.id, ...PAGE_LEGACY[s.kind](settingsOf(s)) },
    );

// A page, campaign or journal body plus its list (or index) row -> the shape
// getContentPage returns.
export function pageFromBody(body, row) {
  const meta = isObj(body?.meta) ? body.meta : {};
  const pick = (k) => meta[k] ?? row?.[k] ?? null;
  return {
    slug: row?.slug ?? meta.slug,
    title: pick("title") ?? "",
    description: pick("description") || "",
    sections: pageSectionsFromBody(body),
    effective_at: pick("effective_at") || null,
    family: row?.type || row?.family || body?.type || "page",
    window_start: pick("window_start") || null,
    window_end: pick("window_end") || null,
  };
}

// collections_index settings -> the legacy value ({featured, order, hide} of
// handles, plus the ids sidecar healCollectionsIndex reads).
export function collectionsIndexFromBody(body) {
  if (!body) return null;
  const s = settingsOf(body);
  const ids = {};
  const handles = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((c) => isObj(c) && typeof c.handle === "string")
      .map((c) => {
        if (typeof c.id === "string" && c.id) ids[c.handle] = c.id;
        return c.handle;
      });
  const out = { featured: handles(s.featured), order: handles(s.order), hide: handles(s.hide) };
  if (Object.keys(ids).length) out.ids = ids;
  return out;
}

// product_layout sections -> the PDP accordions ({title, html}) the product
// page renders today. Rich text and text become one accordion each, an FAQ one
// per question. Kinds an accordion can't hold wait for P2-SECTIONS.
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function pdpExtrasFromBody(body) {
  const out = [];
  for (const sec of sectionsOf(body)) {
    if (!shown(sec)) continue;
    const s = settingsOf(sec);
    if (sec.unfinished) out.push({ title: unfinishedTitle(sec.unfinished), html: unfinishedHtml(sec.unfinished) });
    else if (sec.kind === "rich_text") out.push({ title: s.title, html: s.html });
    else if (sec.kind === "text") {
      const paras = (Array.isArray(s.body) ? s.body : []).filter((p) => typeof p === "string" && p.trim());
      out.push({ title: s.title, html: paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("") });
    } else if (sec.kind === "faq") for (const it of Array.isArray(s.items) ? s.items : []) if (isObj(it)) out.push({ title: it.q, html: it.a });
  }
  return out.filter((x) => x.title && x.html);
}

export const designFromBody = (body) => ({ brand: settingsOf(body).brand ?? null, theme: settingsOf(body).theme ?? null });

// The journal index body's entries (journalIndexBody writes `entries`; the
// registry type declares them under settings).
export function journalEntriesFromBody(body) {
  const list = Array.isArray(body?.settings?.entries) ? body.settings.entries : Array.isArray(body?.entries) ? body.entries : [];
  return list.filter((e) => isObj(e) && typeof e.slug === "string" && e.slug);
}

// ---- the preview overlay (P2-PREVIEW: PV-03, DOC-05, spec 8.8) -------------------
//
// A founder's preview on a store in documents mode shows the live list with
// every saved draft laid over it: for each document that is not archived and
// whose draft differs from what is published, the list entry is swapped for
// the draft body (checked, sanitized and upgraded in memory; the stored row
// is never rewritten). Before the first publish the base is emptyList(m), so
// the preview works then too, and every other singleton is its code default.
//
//   · doc_design is overlaid only when the session's show_design is on (the
//     "Show them" toggle). Whether its draft differs is reported either way.
//   · product_content is never overlaid: the reader has no product-content
//     path until OVL-02 (known limit). The journal index is generated at
//     publish, so it is never a draft; draft journal posts are laid over the
//     published index entries instead.

// Document types a preview never overlays.
export const NOT_OVERLAID = Object.freeze(["product_content", "journal_index", "blueprint"]);

// Every non-archived document whose draft differs from what is published
// (never-published documents included), with its draft. One statement.
// Throws on a read error; the caller decides (no overlay, and a log line).
export async function readDirtyDrafts() {
  const r = await libsql.execute({
    sql: `SELECT id, type, draft, draft_hash FROM documents
           WHERE archived_at IS NULL AND draft_hash IS NOT published_hash
             AND type NOT IN (${NOT_OVERLAID.map(() => "?").join(", ")})
           ORDER BY id`,
    args: [...NOT_OVERLAID],
  });
  return r.rows.map((row) => ({ id: String(row.id), type: String(row.type), draft: String(row.draft), draft_hash: row.draft_hash == null ? null : String(row.draft_hash) }));
}

// The base a preview lays drafts over when the store has never published.
export function previewBaseList() {
  return parseList(emptyReleaseList(currentManifest(), singletonTypes()));
}

// A stored draft -> the body a preview renders, or null when it can't be
// read as this document at all (then the live version stays). Sections with
// an incomplete or invalid field are marked `unfinished` with their placeholder.
export function previewDraftBody(row) {
  let raw;
  try {
    raw = JSON.parse(row.draft);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.type !== row.type) return null;
  const type = documentType(row.type);
  if (!type) return null;
  const { body, issues } = validateDocument(raw, { mode: "draft", documentId: row.id });
  if (!isObj(body)) return null;
  const unfinished = new Set(issues.filter((i) => i.sectionId && i.severity !== "warning").map((i) => i.sectionId));
  if (!unfinished.size || !Array.isArray(body.sections)) return body;
  return {
    ...body,
    sections: body.sections.map((s) => {
      const decl = isObj(s) ? sectionType(s.kind) : null;
      return decl && unfinished.has(s.id) ? { ...s, unfinished: { label: decl.label, placeholder: decl.placeholder } } : s;
    }),
  };
}

const PAGE_ROW_FIELDS = ["title", "description", "effective_at", "window_start", "window_end"];

// base: a parsed v4 list. rows: readDirtyDrafts(). Returns
//   { list, documents, designDirty }
// list       the base with each overlaid document's entry marked `draft`, the
//            draft bodies in list.drafts, page rows and redirects rebuilt from
//            the drafts' meta, and draft journal posts in list.journalDrafts
// documents  the ids overlaid
// designDirty doc_design's draft differs from what is published
export function overlayList(base, rows, { showDesign = false } = {}) {
  const documents = { ...base.documents };
  const owned = new Set();
  const newPages = [];
  const newRedirects = [];
  const drafts = new Map();
  const journalEntries = [];
  const journalDocs = new Set();
  const shownIds = [];
  let designDirty = false;
  for (const row of rows) {
    const type = documentType(row.type);
    if (!type || NOT_OVERLAID.includes(row.type) || !type.editable || !type.publishable) continue;
    if (row.type === "design") {
      designDirty = true;
      if (!showDesign) continue;
    }
    if (type.singleton && row.id !== `doc_${row.type}`) continue;
    const body = previewDraftBody(row);
    if (!body) continue;
    drafts.set(row.id, body);
    shownIds.push(row.id);
    const draftEntry = { version: `draft:${row.id}`, hash: row.draft_hash, draft: true };
    if (type.singleton) {
      documents[row.id] = draftEntry;
      continue;
    }
    const meta = isObj(body.meta) ? body.meta : {};
    const slug = typeof meta.slug === "string" && meta.slug ? meta.slug : null;
    if (row.type === "journal") {
      journalDocs.add(row.id);
      if (slug) {
        const e = { document: row.id, version: null, slug, family: "journal", enabled: meta.enabled !== false };
        for (const k of PAGE_ROW_FIELDS) e[k] = meta[k] ?? null;
        journalEntries.push(e);
      }
      continue;
    }
    // page, campaign: their own rows and redirects come from the draft
    owned.add(row.id);
    documents[row.id] = draftEntry;
    if (!slug) continue;
    const p = { document: row.id, slug, type: row.type, enabled: meta.enabled !== false };
    for (const k of PAGE_ROW_FIELDS) p[k] = meta[k] ?? null;
    newPages.push(p);
    for (const from of Array.isArray(meta.redirect_from) ? meta.redirect_from : []) if (typeof from === "string" && from && from !== slug) newRedirects.push({ document: row.id, from_slug: from, to_slug: slug });
  }
  const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const pages = base.pages.filter((p) => !owned.has(p.document)).concat(newPages).sort(bySlug);
  const redirects = base.redirects.filter((r) => !owned.has(r.document)).concat(newRedirects);
  const list = { ...base, documents, pages, redirects, drafts, journalDrafts: { entries: journalEntries.sort(bySlug), documents: journalDocs } };
  return { list, documents: shownIds, designDirty };
}

// The overlaid draft body of a document, or null.
export const draftOf = (list, id) => (list?.drafts instanceof Map && id ? list.drafts.get(id) ?? null : null);

// The published journal index entries with the preview's draft posts laid over.
export function overlayJournalEntries(entries, journalDrafts) {
  if (!journalDrafts) return entries;
  const kept = entries.filter((e) => !journalDrafts.documents.has(e.document));
  return kept.concat(journalDrafts.entries).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
