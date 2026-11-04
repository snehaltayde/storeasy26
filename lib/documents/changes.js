// P3-CHANGES (PUB-09, ED-03): what publishing a document would change, and
// the two ways to act on it from the editor. Node console routes only (it
// reads and writes through lib/documents/service.js). P3-DESIGN (batch 4)
// adds the design rows' `affects`.
//
// P3-DESIGN (TOK-03): for doc_design every row carries `affects`: the parts
// of the live store that use the row's token group (lib/registry/token-usage.js),
// in plain words ("Every page: header and footer", "Home page: Hero and
// Banner"). The live parts are read once per call: the live list (one
// statement), the live bodies (one statement) and, when posts are listed, the
// journal posts (one more). A design that was never published is compared
// with the platform default design (emptyBody("design")), which is what
// shoppers see until then, so it gives rows too, never firstPublish. When the
// live parts can't be read, each row says so instead of naming them.
//
// Called by lib/admin/documents-api.js after parse (400), authorize (401/403),
// mode (409 STORE_USES_LEGACY) and, for keepLiveSection, 428. Each is handed
// the whole parsed operation and returns { status, body }, which the
// dispatcher sends as it is. A refusal is thrown (DocumentError, NotFoundError,
// ValidationError) and the dispatcher's failed() words it. The shapes are
// lib/admin/documents-api-shapes.js (SHAPES.listChanges, keepLiveSection,
// keepAsEarlierDraft).
//
//   listChanges(op, { actor })                         storefront.read
//     op: { kind: "listChanges", id }
//     200 { ok, firstPublish: false, rows: [] }      the draft is what is live
//                                                    (draft_hash = published_hash)
//     200 { ok, firstPublish: true, sections: [{words}] }
//                                                    never published, or offline:
//                                                    firstPublishRows(type, draft)
//     200 { ok, firstPublish: false, rows: [{ kind, sectionId?, words }] }
//     doc_design never published adds neverPublished: true (P3-FIX4)
//                                                    diffBodies(type, live, draft)
//     404 NOT_FOUND
//   Rows carry no hash and no id in their words (diff.js keeps that rule; the
//   sectionId is for the editor only).
//
//   keepLiveSection(op, { actor })                     storefront.write
//     op: { kind: "keepLiveSection", id, sectionId, hasRevision, revision }
//     The live version of one section goes back into the draft:
//       edited section   replaced by its live version, in place
//       moved section    its live version goes back to its live place
//       hidden or shown  as live (the live version carries enabled and show)
//       added section    removed from the draft
//       removed section  put back at its live place
//     "Its live place" is right after the nearest section before it on the
//     live store that the draft still has (else right before the nearest one
//     after it), which is its live index whenever nothing around it was added
//     or removed; with no such neighbour, its live index clamped to the list.
//     Sections are matched the way diff.js matches them (by id, then by
//     content, then by kind for sections without ids), so the row the founder
//     clicked is the section that changes.
//     The write is service.rewriteDraft: the saveDraft rules (revision, 409
//     with current, archived, draft-mode validation 422) and a checkpoint of
//     the replaced draft first, in the same batch.
//     200 { ok, document }   with the new draftHash and revision
//     404 NOT_FOUND          never published, offline (its own words), or no
//                            such section
//
//   keepAsEarlierDraft(op, { actor })                  storefront.write
//     op: { kind: "keepAsEarlierDraft", id, body }   (no revision)
//     200 { ok, savedVersion: { id, note } }
//     409 TOO_MANY_KEPT, 404, 422
import { getVersion } from "./versions.js";
import * as Docs from "./service.js";
import { diffBodies, firstPublishRows, __diffInternals } from "./diff.js";
import { upgradeBody, emptyBody, documentType, sectionType, SECTION_ID_RE } from "../registry/index.js";
import { groupsOfRow, affectsWords } from "../registry/token-usage.js";
import { readLive, readVersionBodies } from "./build.js";
import { JOURNAL_INDEX_ID, journalEntriesOf } from "./journal-index.js";
import { NotFoundError } from "../cms/issues.js";
import { audit } from "../platform/audit.js";
import { slog } from "../log.js";

const { matchSections, movedPairs } = __diffInternals;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validId = (s) => (isObj(s) && typeof s.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : null);

export const KEEP_LIVE_NOTE = "Before keeping the live version of a section";
const NO_LIVE = "This page has never been published, so there is no live version to keep.";
// P3-FIX2: a page that was live and then taken offline (undone_version_id set)
const OFFLINE = "This page is offline, so there is no live version to keep. Publish it again to bring it back.";
const NO_SECTION = "That section is no longer in this page or on your live store. Reload to see the latest changes.";
const LIVE_MISSING = "The live version of this page couldn't be found. Reload and try again.";

async function liveBodyOf(d) {
  const v = await getVersion(d.id, d.publishedVersionId);
  if (!v) throw new NotFoundError(LIVE_MISSING);
  return upgradeBody(v.body);
}

// ---- listChanges -------------------------------------------------------------------

export async function listChanges(op, _ctx = {}) {
  const d = await Docs.getDocument(op.id);
  if (d.publishedVersionId && d.draftHash === d.publishedHash) return { status: 200, body: { ok: true, firstPublish: false, rows: [] } };
  // P3-FIX4: a design never published says so (neverPublished), so the editor
  // offers no Undo after its first publish: there is nothing earlier
  if (d.type === "design") return { status: 200, body: { ok: true, firstPublish: false, ...(d.publishedVersionId ? {} : { neverPublished: true }), rows: await designRows(d) } };
  if (!d.publishedVersionId) {
    return { status: 200, body: { ok: true, firstPublish: true, sections: firstPublishRows(d.type, d.body).map((r) => ({ words: r.words })) } };
  }
  const live = await liveBodyOf(d);
  const rows = diffBodies(d.type, live, d.body).map((r) => (r.sectionId ? { kind: r.kind, sectionId: r.sectionId, words: r.words } : { kind: r.kind, words: r.words }));
  return { status: 200, body: { ok: true, firstPublish: false, rows } };
}

// ---- the design document's rows (P3-DESIGN) -------------------------------------------

export const AFFECTS_UNKNOWN = "We couldn't check which parts of your store use this. It still changes everywhere it is used.";

// Which singletons are store chrome (every page), and which are not shown as
// pages of their own here.
const CHROME_IDS = { doc_header: "header", doc_footer: "footer", doc_announcement: "announcement" };
const NOT_A_PAGE = new Set(["design", "header", "footer", "announcement", "cart", "journal_index", "product_content"]);
const PAGE_ORDER = ["home", "collections_index", "product_layout", "collection_layout"];

const sectionsOf = (body) =>
  (Array.isArray(body?.sections) ? body.sections : [])
    .filter((s) => isObj(s) && s.enabled !== false && sectionType(s.kind))
    .map((s) => ({ kind: s.kind, label: sectionType(s.kind).label }));

function pageOf(body) {
  if (!isObj(body)) return null;
  const t = documentType(body.type);
  if (!t || NOT_A_PAGE.has(t.type)) return null;
  if (t.route && body.meta?.enabled === false) return null;
  const title = t.route && typeof body.meta?.title === "string" && body.meta.title.trim() ? body.meta.title.trim().slice(0, 80) : t.label;
  return { type: t.type, label: title, sections: sectionsOf(body) };
}

// The parts of the live store shoppers see now: { chrome, pages } for
// lib/registry/token-usage.js affectsWords.
export async function liveParts() {
  const { list } = await readLive();
  const off = new Set((list.pages || []).filter((p) => p.enabled === false).map((p) => p.document));
  const ids = Object.entries(list.documents || {})
    .filter(([id, e]) => e && typeof e.version === "string" && !off.has(id) && id !== JOURNAL_INDEX_ID)
    .map(([id, e]) => [id, e.version]);
  const indexVersion = list.indexes?.journal?.version ?? null;
  const bodies = await readVersionBodies([...ids.map(([, v]) => v), indexVersion]);
  const chrome = ["header", "footer"];
  const pages = [];
  for (const [id, v] of ids) {
    const body = bodies.get(v)?.body;
    if (id === "doc_announcement") {
      if (body?.settings?.enabled === true) chrome.push("announcement");
      continue;
    }
    if (CHROME_IDS[id]) continue;
    const p = pageOf(body);
    if (p) pages.push(p);
  }
  const posts = journalEntriesOf(indexVersion ? bodies.get(indexVersion)?.body : null).filter((e) => e.enabled !== false && typeof e.version === "string");
  if (posts.length) {
    const postBodies = await readVersionBodies(posts.map((e) => e.version));
    for (const e of posts) {
      const p = pageOf(postBodies.get(e.version)?.body);
      if (p) pages.push(p);
    }
  }
  const rank = (p) => (PAGE_ORDER.includes(p.type) ? PAGE_ORDER.indexOf(p.type) : PAGE_ORDER.length);
  pages.sort((a, b) => rank(a) - rank(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { chrome, pages };
}

async function designRows(d) {
  const from = d.publishedVersionId ? await liveBodyOf(d) : emptyBody("design");
  const rows = diffBodies(d.type, from, d.body).map((r) => ({ kind: r.kind, words: r.words }));
  if (!rows.length) return rows;
  let live = null;
  try {
    live = await liveParts();
  } catch (e) {
    slog("documents_design_affects_failed", { document: d.id, error: String(e?.message || e).slice(0, 200) });
  }
  return rows.map((r) => ({ ...r, affects: live ? affectsWords(groupsOfRow(r.words), live) : [{ words: AFFECTS_UNKNOWN }] }));
}

// ---- keepLiveSection ---------------------------------------------------------------

// Where a live section goes back into `rest` (the draft's sections without
// it). `partnerOf(liveIndex)` gives the index in `rest` of the draft section
// paired with that live section, or undefined.
function livePlace(live, i, rest, partnerOf) {
  for (let k = i - 1; k >= 0; k--) {
    const at = partnerOf(k);
    if (at !== undefined) return at + 1;
  }
  for (let k = i + 1; k < live.length; k++) {
    const at = partnerOf(k);
    if (at !== undefined) return at;
  }
  return Math.max(0, Math.min(i, rest.length));
}

// P3-FIX2: `section` (live section i) put into `rest` at `first`, unless the
// change list would still name it there. diff.js keeps one longest run of
// sections in their live order and names the rest "moved"; when the draft's
// order is scrambled (live [l0..l4], draft [l4, l2, l3, l0], keep l1), the
// place after the nearest live neighbour can fall outside that run. Then the
// nearest place that leaves no row for it is used (one always exists: put
// just before the run's first section with a later live index, it extends
// the run).
function placeQuietly(live, i, rest, section, first) {
  const at = (x) => [...rest.slice(0, x), section, ...rest.slice(x)];
  const quiet = (list, x) => {
    const pairs = matchSections(live, list);
    const k = pairs.findIndex(([, j]) => j === x);
    return k >= 0 && pairs[k][0] === i && !movedPairs(pairs).has(k);
  };
  const tries = Array.from({ length: rest.length + 1 }, (_, x) => x).sort((a, b) => Math.abs(a - first) - Math.abs(b - first) || a - b);
  for (const x of tries) {
    const list = at(x);
    if (quiet(list, x)) return list;
  }
  return at(first);
}

// Pure: the draft body with the live version of section `sectionId` put back.
// null when neither side has that section.
export function keepLiveBody(liveBody, draftBody, sectionId) {
  const live = Array.isArray(liveBody?.sections) ? liveBody.sections : [];
  const draft = Array.isArray(draftBody?.sections) ? draftBody.sections : [];
  const pairs = matchSections(live, draft); // [[liveIndex, draftIndex]], by draftIndex
  const moved = movedPairs(pairs); // pair index -> "moved up" | "moved down" | "moved"
  const draftOfLive = new Map(pairs.map(([i, j]) => [i, j]));
  const liveOfDraft = new Map(pairs.map(([i, j], k) => [j, { i, k }]));

  let j = draft.findIndex((s) => validId(s) === sectionId);
  let i;
  if (j >= 0) i = liveOfDraft.get(j)?.i;
  else {
    i = live.findIndex((s) => validId(s) === sectionId);
    if (i < 0) return null;
    j = draftOfLive.has(i) ? draftOfLive.get(i) : -1;
  }

  const out = (sections) => ({ ...draftBody, sections });
  // added in the draft: it goes
  if (j >= 0 && i === undefined) return out(draft.filter((_, x) => x !== j));
  // removed from the draft: it comes back at its live place
  if (j < 0) {
    const at = livePlace(live, i, draft, (k) => draftOfLive.get(k));
    return out(placeQuietly(live, i, draft, live[i], at));
  }
  // in both: the live version, under the draft's id so the editor keeps it
  // selected (diff.js still pairs it by content), in place unless it moved
  const restored = { ...live[i], id: validId(draft[j]) || validId(live[i]) || draft[j]?.id };
  if (restored.id === undefined) delete restored.id;
  if (!moved.has(liveOfDraft.get(j).k)) return out(draft.map((s, x) => (x === j ? restored : s)));
  const rest = draft.filter((_, x) => x !== j);
  const at = livePlace(live, i, rest, (k) => {
    if (k === i || !draftOfLive.has(k)) return undefined;
    const x = draftOfLive.get(k);
    return x > j ? x - 1 : x;
  });
  return out(placeQuietly(live, i, rest, restored, at));
}

export async function keepLiveSection(op, { actor = null } = {}) {
  const r = await Docs.rewriteDraft({
    id: op.id,
    revision: op.revision,
    actor,
    note: KEEP_LIVE_NOTE,
    rewrite: async (d) => {
      if (!d.publishedVersionId) throw new NotFoundError(d.undoneVersionId ? OFFLINE : NO_LIVE);
      const next = keepLiveBody(await liveBodyOf(d), d.body, op.sectionId);
      if (!next) throw new NotFoundError(NO_SECTION);
      return next;
    },
  });
  slog("documents_write", { op: op.kind, document: r.document.id, revision: r.document.revision });
  await audit({ actor, action: "storefront.write", resource: `document:${r.document.id}`, diff: { op: op.kind, revision: r.document.revision } }); // best-effort, never throws
  return { status: 200, body: { ok: true, document: Docs.publicDocument(r.document) } };
}

// ---- keepAsEarlierDraft ------------------------------------------------------------

export async function keepAsEarlierDraft(op, { actor = null } = {}) {
  const r = await Docs.keepEarlierDraft({ id: op.id, body: op.body, actor });
  slog("documents_kept_draft", { document: op.id, stored: r.stored });
  if (r.stored) await audit({ actor, action: "storefront.write", resource: `document:${op.id}`, diff: { op: op.kind } }); // best-effort, never throws
  return { status: 200, body: { ok: true, savedVersion: { id: r.savedVersion.id, note: r.savedVersion.note } } };
}
