// P2-ATOM (PUB-01): the version 4 release list. Pure, edge-safe.
//
// A v4 release row holds references only, never document bodies:
//   { v: 4, m, documents: { <doc id>: {version, hash} | null }, pages, redirects,
//     indexes: { journal: {version, hash} | null } }
//
//   null in `documents`  "use the code default", written out explicitly. A
//                        singleton missing from the list is an error for the
//                        reader (spec 8.4), so emptyList() lists every one.
//   pages / redirects    small index rows for chrome and routing, each owned by
//                        the document named in its `document` field
//   indexes.journal      the generated journal index version, so the list stays
//                        the same size however many posts there are
//
// Hashing is the release hash everywhere: stableStringify + sha256Hex.
import { stableStringify, sha256Hex } from "../releases.js";

export const LIST_VERSION = 4;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function assertManifest(m) {
  if (!Number.isInteger(m) || m < 1) throw new Error(`release list: the manifest number must be a whole number of 1 or more, got ${JSON.stringify(m)}`);
}

// Only {version, hash} is kept, so nothing else can ride into the list.
function cleanEntry(entry, what) {
  if (entry === null) return null;
  if (!isObj(entry) || typeof entry.version !== "string" || !entry.version.startsWith("ver_") || typeof entry.hash !== "string" || !entry.hash) {
    throw new Error(`release list: ${what} needs {version: "ver_…", hash} or null`);
  }
  return { version: entry.version, hash: entry.hash };
}

const byPage = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.document < b.document ? -1 : a.document > b.document ? 1 : 0);
const byRedirect = (a, b) =>
  a.from_slug < b.from_slug ? -1 : a.from_slug > b.from_slug ? 1 : a.document < b.document ? -1 : a.document > b.document ? 1 : 0;

const PAGE_FIELDS = ["slug", "type", "title", "description", "enabled", "effective_at", "window_start", "window_end"];

function cleanPage(row, document) {
  if (!isObj(row) || typeof row.slug !== "string" || !row.slug) throw new Error(`release list: a page row of ${document} has no slug`);
  const out = { document };
  for (const k of PAGE_FIELDS) out[k] = row[k] ?? null;
  out.enabled = row.enabled !== false;
  return out;
}

function cleanRedirect(row, document) {
  if (!isObj(row) || typeof row.from_slug !== "string" || !row.from_slug || typeof row.to_slug !== "string" || !row.to_slug) {
    throw new Error(`release list: a redirect of ${document} needs from_slug and to_slug`);
  }
  return { document, from_slug: row.from_slug, to_slug: row.to_slug };
}

// The list a tenant starts from before its first publish: every registered
// singleton is an explicit null. `singletonTypes` comes from the registry
// (P2-REG); it is an argument so this module does not depend on it.
export function emptyList(m, singletonTypes = []) {
  assertManifest(m);
  if (!Array.isArray(singletonTypes)) throw new Error("emptyList: singletonTypes must be a list of document types");
  const documents = {};
  for (const type of singletonTypes) documents[`doc_${type}`] = null;
  return { v: LIST_VERSION, m, documents, pages: [], redirects: [], indexes: { journal: null } };
}

export const isV4List = (list) => isObj(list) && list.v === LIST_VERSION && isObj(list.documents) && Array.isArray(list.pages) && Array.isArray(list.redirects) && isObj(list.indexes);

// A new list from `prevList` with only the documents in `changes` replaced.
//   changes: [
//     { document: "doc_x", entry: {version, hash} | null, pages?: [...], redirects?: [...] },
//     { document: "doc_y", remove: true },          // drops its entry, pages and redirects
//     { index: "journal", entry: {version, hash} | null },
//   ]
// Every other document's entry (nulls included), page rows and redirects are
// kept as they are. `pages` and `redirects` default to none for the document.
export function setEntries(prevList, changes, { m } = {}) {
  if (!isV4List(prevList)) throw new Error("setEntries: the previous list is not a version 4 list");
  if (!Array.isArray(changes)) throw new Error("setEntries: changes must be a list");
  const nextM = m ?? prevList.m;
  assertManifest(nextM);
  if (nextM < prevList.m) throw new Error("setEntries: the manifest number can't go down");

  const documents = { ...prevList.documents };
  const indexes = { ...prevList.indexes };
  const owned = new Set();
  const newPages = [];
  const newRedirects = [];
  const seen = new Set();
  for (const change of changes) {
    if (!isObj(change)) throw new Error("setEntries: a change must be an object");
    if (change.index != null) {
      if (change.index !== "journal") throw new Error(`setEntries: unknown index "${change.index}"`);
      if (seen.has("index:journal")) throw new Error("setEntries: the journal index is changed twice");
      seen.add("index:journal");
      indexes.journal = cleanEntry(change.entry, "the journal index");
      continue;
    }
    const id = change.document;
    if (typeof id !== "string" || !id.startsWith("doc_")) throw new Error("setEntries: a change needs a document id (doc_…)");
    if (seen.has(id)) throw new Error(`setEntries: ${id} is changed twice`);
    seen.add(id);
    owned.add(id);
    if (change.remove === true) {
      delete documents[id];
      continue;
    }
    if (change.entry === undefined) throw new Error(`setEntries: ${id} needs an entry (or null for the code default)`);
    documents[id] = cleanEntry(change.entry, id);
    for (const p of change.pages || []) newPages.push(cleanPage(p, id));
    for (const r of change.redirects || []) newRedirects.push(cleanRedirect(r, id));
  }
  const pages = prevList.pages.filter((p) => !owned.has(p.document)).concat(newPages).sort(byPage);
  const redirects = prevList.redirects.filter((r) => !owned.has(r.document)).concat(newRedirects).sort(byRedirect);
  return { v: LIST_VERSION, m: nextM, documents, pages, redirects, indexes };
}

// Every version id the list points at (documents and indexes).
export function listVersionIds(list) {
  if (!isV4List(list)) return [];
  const ids = [];
  for (const e of Object.values(list.documents)) if (e?.version) ids.push(e.version);
  for (const e of Object.values(list.indexes)) if (e?.version) ids.push(e.version);
  return ids;
}

const JOURNAL_FIELDS = ["slug", "title", "description", "enabled", "family", "effective_at", "window_start", "window_end"];

// The body of the generated journal_index document: one small entry per live
// post, enough for the journal list, the sitemap and campaignVisible() to run
// without loading any post body.
export function journalIndexBody(posts) {
  if (!Array.isArray(posts)) throw new Error("journalIndexBody: posts must be a list");
  const entries = posts.map((p) => {
    if (!isObj(p) || typeof p.slug !== "string" || !p.slug) throw new Error("journalIndexBody: every post needs a slug");
    const e = { document: p.document ?? null, version: p.version ?? null };
    for (const k of JOURNAL_FIELDS) e[k] = p[k] ?? null;
    e.enabled = p.enabled !== false;
    e.family = p.family ?? "journal";
    return e;
  });
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { schema: 1, type: "journal_index", entries };
}

export const listCanonical = (list) => stableStringify(list);
export const listHash = (list) => sha256Hex(listCanonical(list));
