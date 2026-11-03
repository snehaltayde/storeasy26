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
import { documentType, singletonTypes, upgradeBody, sectionType, linkHref, SCHEMA_VERSION } from "../registry/index.js";
import { settingsToLegacyHero } from "../registry/legacy.js";
import { isV4List } from "../documents/release-list.js";
import { DEFAULT_ANNOUNCEMENT } from "../cms/defaults.js";

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
export async function documentBodies(list, ids) {
  const wanted = ids.map((id) => [id, entryOf(list, id)]);
  const versions = await liveVersions(wanted.filter(([, e]) => e).map(([, e]) => e.version));
  const out = {};
  for (const [id, entry] of wanted) {
    if (!entry) {
      out[id] = null;
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
  return { ...defaults, ...settingsToLegacyHero(settingsOf(section)) };
}

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
    .filter((s) => shown(s) && s.kind !== "hero" && Object.hasOwn(HOME_LEGACY, s.kind))
    .map((s) => ({ id: s.id, kind: s.kind, enabled: true, ...HOME_LEGACY[s.kind](settingsOf(s)) }));
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
    .filter((s) => shown(s) && Object.hasOwn(PAGE_LEGACY, s.kind))
    .map((s) => ({ id: s.id, ...PAGE_LEGACY[s.kind](settingsOf(s)) }));

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
    if (sec.kind === "rich_text") out.push({ title: s.title, html: s.html });
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
