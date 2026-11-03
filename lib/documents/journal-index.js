// P2-PUBLISH (PUB-01, PERF-01): the generated journal index. Pure, edge-safe.
//
// The journal index is a system document (`journal_index`, never edited by a
// founder) whose version is listed in the release list as `indexes.journal`.
// Its body carries one small entry per published journal post, with the
// fields the journal list, the sitemap and campaignVisible() need, so none of
// them has to load a post body (plan decision 5, P2-READ's
// resolvedJournalEntries):
//
//   { schema, type: "journal_index", meta: {},
//     settings: { entries: [ { document, version, slug, title, description,
//                              enabled, family, effective_at, window_start,
//                              window_end }, … ] } }
//
// Entries are sorted by slug, so the same posts always give the same body and
// the same hash. The shape is the registry's (entries under settings); the
// reader also accepts P2-ATOM's older top-level `entries`.
//
//   JOURNAL_INDEX_ID                 the document id its versions belong to
//   journalEntry(documentId, versionId, body)
//                                    one entry, from a post's published body
//   journalEntriesOf(body)           the entries of an index body (either shape)
//   nextJournalIndexBody(prevBody, changes)
//                                    a new index body: the entries of the posts
//                                    in `changes` replaced (or removed), every
//                                    other entry kept as it is
//   journalIndexBodyFrom(posts)      an index built from scratch from
//                                    [{ documentId, versionId, body }]
import { SCHEMA_VERSION } from "../registry/index.js";

export const JOURNAL_INDEX_ID = "doc_journal_index";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : null);

// One entry from a journal post's published body. The visibility fields
// (enabled and the three dates) come from the body's meta, so the reader can
// decide what shoppers see without the body.
export function journalEntry(documentId, versionId, body) {
  if (typeof documentId !== "string" || !documentId) throw new Error("journalEntry: a post needs its document id");
  if (typeof versionId !== "string" || !versionId.startsWith("ver_")) throw new Error(`journalEntry: ${documentId} needs its published version id`);
  const meta = isObj(body?.meta) ? body.meta : {};
  if (typeof meta.slug !== "string" || !meta.slug) throw new Error(`journalEntry: ${documentId} has no slug`);
  return {
    document: documentId,
    version: versionId,
    slug: meta.slug,
    title: str(meta.title) ?? "",
    description: str(meta.description) ?? "",
    enabled: meta.enabled !== false,
    family: "journal",
    effective_at: str(meta.effective_at),
    window_start: str(meta.window_start),
    window_end: str(meta.window_end),
  };
}

export function journalEntriesOf(body) {
  const list = Array.isArray(body?.settings?.entries) ? body.settings.entries : Array.isArray(body?.entries) ? body.entries : [];
  return list.filter((e) => isObj(e) && typeof e.slug === "string" && e.slug);
}

const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : String(a.document) < String(b.document) ? -1 : String(a.document) > String(b.document) ? 1 : 0);

function indexBody(entries) {
  return { schema: SCHEMA_VERSION, type: "journal_index", meta: {}, settings: { entries: [...entries].sort(bySlug) } };
}

// changes: [{ documentId, versionId, body }] (published now) or
//          [{ documentId, remove: true }]    (no longer listed)
export function nextJournalIndexBody(prevBody, changes) {
  if (!Array.isArray(changes)) throw new Error("nextJournalIndexBody: changes must be a list");
  const touched = new Set(changes.map((c) => c?.documentId));
  const kept = journalEntriesOf(prevBody).filter((e) => !touched.has(e.document));
  const added = changes.filter((c) => !c.remove).map((c) => journalEntry(c.documentId, c.versionId, c.body));
  return indexBody([...kept, ...added]);
}

export const journalIndexBodyFrom = (posts) => nextJournalIndexBody(null, posts);
