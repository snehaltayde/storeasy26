// P2-PUBLISH (PUB-01, PUB-02, DOC-05, DOC-07, DOC-08; partly PUB-03, PUB-05,
// DOC-10): publishing one document, or a set, on top of the proven commit
// (lib/documents/commit.js). Node console routes only. Spec 8.6 steps 2 to 7.
// The panel (PUB-09), Undo (PUB-04) and schedules (PUB-07) are not here.
//
//   publish({ ids: [{ id, revision, draftHash }], actor })
//     -> { release: {id} | null, setId, published: [{id, versionId, hash}],
//          skipped: [id], issues }
//
// How a publish works:
//   1. The set is checked (1 to 200 documents, each with its revision and the
//      draft hash the founder reviewed) and the store must be in documents
//      mode.
//   2. Each document is read once. Gone (404), archived, another revision or
//      another draft hash (409 with the current document, per document in a
//      set). product_content is refused (PUBLISH_NOT_AVAILABLE, until OVL-02);
//      the journal index is made by the store, never published by hand.
//   3. The live pointer L and its list M are read. A live version 1 to 3
//      release is refused ("This store still publishes with Releases"). No
//      release yet: M starts as emptyList(m, singletonTypes()), so every other
//      singleton stays an explicit null (code default).
//   4. Each body is validated and re-sanitized in publish mode against what is
//      live (the live body, for the design checks and the inherited rule).
//      Structure and sanitizing always block. Any other problem in a section
//      that is hidden, or whose id-stripped content equals the live version's
//      section of the same id, only warns (the minimal inherited rule of PUB-03). Any
//      remaining error refuses the whole set with 422, naming each document.
//   5. A document whose id-stripped hash equals what is live is skipped.
//   6. Slugs must be unique across the resulting page list plus the journal
//      index; a clash names the other live page (409 SLUG_TAKEN).
//   7. Fresh ids are minted for every build (release, set, versions, log):
//      never a checkpoint's or any other existing version id, and the release
//      row is never written before its flip (plan section 6). M2 changes only
//      the set's entries, plus a new indexes.journal version when a post
//      changed. Then commitPublishBatch, wrapped in a try: a throw is a
//      failure, never a race.
//      A journal post has no list.documents entry (PERF-01: the list stays the
//      same size however many posts there are). Its live entry is its row in
//      the journal index, and every check above that needs "what is live for
//      this document" (the inherited rule, the skip, the lost check, the log's
//      from-version) reads it from there. A list written before this rule may
//      still hold a post's own entry: it is read when the index has none, and
//      dropped when that post is published again.
//   8. The outcome:
//        ok       done
//        lost     re-read. A list that holds a version of one of this call's
//                 own builds means that batch went live after all: success.
//                 Otherwise a document whose list entry differs from M, or whose
//                 revision moved, is 409 with the current document. Otherwise
//                 rebuild from M' with new ids. After 3 losses: 503 "Publishing
//                 is busy, try again in a moment".
//        unknown  503 "Your publish may have gone live. Reload to check." Never
//                 rebuilt, never a 409.
//        failed   MISSING_DOCUMENT: "This page was deleted while you were
//                 publishing. Reload to see the current pages." Every other
//                 code: 500, nothing was published. Never "someone else
//                 published".
//
// Known limit (ED-03): an autosave between the read and the batch makes the
// publish lose; the editor must hold autosaves while a publish runs, or it can
// starve.
//
// P3-COMMIT: the build helpers (reads, slugs, the build, the outcome words and
// the rebuild loop) live in lib/documents/build.js, shared with Undo. This file
// keeps the set, the per-document checks, validation and the publish answer.
//
// P3-CHECKS (PUB-03, PUB-05, PUB-04, PUB-11, PUB-06, TOK-03):
//   - step 4 adds the reference checks of lib/documents/checks.js, over the
//     set's own bodies only, against M2 (the live list with the set applied).
//     Every issue in a 422 and in the 200's warnings carries level ("blocks",
//     "warns", "inherited"), anchor, where and actions.
//   - a link to an existing document that isn't live is 422
//     LINKS_TO_UNPUBLISHED with offer.publishSet (the set plus the targets,
//     each {id, revision, draftHash, label}). Sending that set runs the
//     targets' own checks; a target changed since the offer is the usual 409.
//   - a closed store (no live release yet) must open with its home page: a
//     set without doc_home is 409 FIRST_PUBLISH_NEEDS_HOME, offering the set
//     plus doc_home (until PUB-12).
//   - a draft equal to the content that was taken offline (documentHash of
//     the undone_version_id body; never document_versions.body_hash) needs
//     confirmRepublish: 409 REPUBLISH_CONFIRM_NEEDED. Every publish clears
//     undone_version_id (the plan's decision 4: once it is live again, there
//     is nothing taken offline to confirm).
//   - each published item carries liveUrl (liveExitUrl(livePath(type, meta)))
//     and undo {id, revision, logId}.
//   - the 409 conflicts DOCUMENT_CHANGED, DRAFT_CHANGED and
//     PUBLISHED_ELSEWHERE carry current.updatedBy and current.updatedByName
//     ("another tab" when it was the same person).
import { libsql } from "../db.js";
import { getCmsMode } from "../cms-mode.js";
import { slog } from "../log.js";
import { issue, NotFoundError, validationBody } from "../cms/issues.js";
import { documentType, validateDocument, documentHash, stripIds, stableStringify } from "../registry/index.js";
import { issueClass, STRUCTURE } from "../registry/validate.js";
import { DocumentError, publicDocument, actorString } from "./service.js";
import { journalEntriesOf } from "./journal-index.js";
import { tenantId } from "../tenant-context.js";
import { namesFor, plainName } from "./versions.js";
import { livePath, liveExitUrl } from "./paths.js";
import { referenceChecks, relevel, decorate, linkLead, LINKS_TO_UNPUBLISHED } from "./checks.js";
import {
  MAX_ATTEMPTS,
  BUSY_MESSAGE,
  UNKNOWN_MESSAGE,
  DELETED_MESSAGE,
  RELEASES_MESSAGE,
  setBuildHooks,
  readLive,
  liveFrom,
  liveEntryOf,
  sameEntry,
  readVersionBodies,
  slugClash,
  checkSlugs,
  journalIndexOf,
  makeBuild,
  runGuardedBuild,
} from "./build.js";

export const PUBLISH_SET_CAP = 200;
export { MAX_ATTEMPTS, BUSY_MESSAGE, UNKNOWN_MESSAGE, DELETED_MESSAGE, RELEASES_MESSAGE };

// Tests only (the "interleave hook"), now kept by build.js for every guarded
// build: beforeCommit({ attempt, build }) runs after the build and before its
// batch; commit(build) replaces commitPublishBatch. Production never sets them.
export const setPublishHooks = setBuildHooks;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const now = () => new Date().toISOString();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nounOf = (type) => documentType(type)?.noun || "this page";
const quoted = (label) => `“${label}”`;

// ---- the set -------------------------------------------------------------------------

function checkSet(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new DocumentError(400, "NOTHING_TO_PUBLISH", "Choose at least one page to publish.");
  if (ids.length > PUBLISH_SET_CAP) {
    throw new DocumentError(400, "SET_TOO_LARGE", `You can publish up to ${PUBLISH_SET_CAP} pages at once, so nothing was published. Publish the rest in a second go.`);
  }
  const seen = new Set();
  return ids.map((it) => {
    if (!isObj(it) || typeof it.id !== "string" || !it.id || it.id.length > 200 || seen.has(it.id)) {
      throw new DocumentError(400, "MALFORMED", "The editor sent something we couldn't read, so nothing was published. Reload the page and try again.");
    }
    seen.add(it.id);
    if (!Number.isInteger(it.revision)) throw new DocumentError(428, "REVISION_REQUIRED", "The editor didn't say which version you started from, so nothing was published. Reload the page and try again.");
    if (typeof it.draftHash !== "string" || !it.draftHash) {
      throw new DocumentError(428, "REVIEW_REQUIRED", "The editor didn't say which changes you reviewed, so nothing was published. Reload the page and try again.");
    }
    // P3-COMMIT: confirmRepublish rides along for P3-CHECKS (the republish
    // confirm); nothing reads it yet
    return { id: it.id, revision: it.revision, draftHash: it.draftHash, confirmRepublish: it.confirmRepublish === true };
  });
}

// ---- reads ---------------------------------------------------------------------------

const DOC_COLS = "id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, published_version_id, published_hash, undone_version_id, archived_at, created_at, updated_at, updated_by";

// Who saved each document read last (P3-CHECKS: the conflicts name them).
// Kept beside the document, so the document itself keeps service.js's keys.
const UPDATED_BY = new WeakMap();

function fromRow(r) {
  let body = null;
  try {
    body = JSON.parse(String(r.draft));
  } catch {
    body = null;
  }
  return {
    id: String(r.id),
    type: String(r.type),
    slug: r.slug == null ? null : String(r.slug),
    entityId: r.entity_id == null ? null : String(r.entity_id),
    label: String(r.label),
    body,
    draftHash: String(r.draft_hash),
    revision: Number(r.revision),
    schemaVersion: Number(r.schema_version),
    publishedVersionId: r.published_version_id == null ? null : String(r.published_version_id),
    publishedHash: r.published_hash == null ? null : String(r.published_hash),
    undoneVersionId: r.undone_version_id == null ? null : String(r.undone_version_id),
    archivedAt: r.archived_at == null ? null : String(r.archived_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// The documents of the set, in one statement: Map id -> document.
async function readDocuments(idList) {
  const r = await libsql.execute({ sql: `SELECT ${DOC_COLS} FROM documents WHERE id IN (${idList.map(() => "?").join(", ")})`, args: idList });
  return new Map(
    r.rows.map((row) => {
      const d = fromRow(row);
      UPDATED_BY.set(d, row.updated_by == null ? null : String(row.updated_by));
      return [String(row.id), d];
    }),
  );
}

// The few columns an offer needs (never a draft body): Map id -> row.
async function readOfferRows(idList) {
  if (!idList.length) return new Map();
  const r = await libsql.execute({ sql: `SELECT id, label, revision, draft_hash, archived_at FROM documents WHERE id IN (${idList.map(() => "?").join(", ")})`, args: idList });
  return new Map(r.rows.map((row) => [String(row.id), { id: String(row.id), label: String(row.label), revision: Number(row.revision), draftHash: String(row.draft_hash), archived: row.archived_at != null }]));
}

// ---- refusals, in plain words ------------------------------------------------------------

const stale = (cur) => ({
  id: cur.id,
  code: "DOCUMENT_CHANGED",
  error: `${cap(nounOf(cur.type))} was changed since you opened it, so nothing was published. Review the current version, then publish again.`,
  current: publicDocument(cur),
});
const reviewed = (cur) => ({
  id: cur.id,
  code: "DRAFT_CHANGED",
  error: `${cap(nounOf(cur.type))} changed after you reviewed it, so nothing was published. Review the changes, then publish again.`,
  current: publicDocument(cur),
});
const elsewhere = (cur) => ({
  id: cur.id,
  code: "PUBLISHED_ELSEWHERE",
  error: `Someone else published ${nounOf(cur.type)} at the same moment, so your publish didn't go live. Reload to see what is live now, then publish again.`,
  current: publicDocument(cur),
});
const archived = (cur) => ({ id: cur.id, code: "DOCUMENT_ARCHIVED", error: `${cap(nounOf(cur.type))} was archived, so nothing was published. Reload to see your pages.`, current: publicDocument(cur) });

// One 409 for the whole set, listing each document that refused. A single
// document's refusal also carries `current` at the top level, like saveDraft.
function conflictError(list) {
  const first = list[0];
  const message = list.length === 1 ? first.error : `${list.length} of these pages changed since you opened them, so nothing was published. Review them, then publish again.`;
  return new DocumentError(409, first.code, message, { conflicts: list, ...(list.length === 1 ? { current: first.current } : {}) });
}

// P3-CHECKS: who saved the document last, in plain words: updatedBy is the
// actor string (for the editor only), updatedByName their name, or "another
// tab" when it was the person publishing now.
const NAMED = new Set(["DOCUMENT_CHANGED", "DRAFT_CHANGED", "PUBLISHED_ELSEWHERE"]);
async function withWho(list, by, docOf) {
  if (!list.some((c) => NAMED.has(c.code))) return list;
  const names = await namesFor(tenantId());
  return list.map((c) => {
    if (!NAMED.has(c.code)) return c;
    const updatedBy = UPDATED_BY.get(docOf(c.id)) ?? null;
    const updatedByName = updatedBy && updatedBy === by ? "another tab" : plainName(updatedBy, names);
    return { ...c, current: { ...c.current, updatedBy, updatedByName } };
  });
}

// ---- validation (step 4) -------------------------------------------------------------------

// Problems that always block, inherited or not: the body's structure and
// sanitizing (PUB-03: "Structure and sanitizing always run and always block").
// The validator's own class decides first (issueClass: every "structure"
// issue, which includes INVALID_VALUE, LINK_INVALID, TOO_DEEP,
// SECTIONS_NOT_ALLOWED and the sanitizer refusals). These codes also block
// whatever class they arrive with (an issue made outside the validator has
// none).
const STRUCTURE_CODES = new Set([
  "INVALID_SHAPE",
  "UNKNOWN_TYPE",
  "UNKNOWN_FIELD",
  "UNKNOWN_KIND",
  "KIND_NOT_ALLOWED",
  "SECTION_ID_INVALID",
  "SECTION_ID_DUPLICATE",
  "SECTION_VERSION",
  "SCHEMA_UNSUPPORTED",
  "TYPE_MISMATCH",
  "BLOCKS_NOT_ALLOWED",
  "BINDING_INVALID",
  "PROTECTED_HIDDEN",
  "PROTECTED_MISSING",
  "TOO_MANY_OF_KIND",
  "POSITION_NOT_ALLOWED",
  "TOO_MANY_BEFORE_PROTECTED",
  "WORDS_LOST",
  "ADDRESS_LOST",
  "MEDIA_LOST",
  "PICTURE_LOST",
  "PUBLISH_NOT_AVAILABLE",
  "HOME_EMPTY",
]);

const alwaysBlocks = (i) => issueClass(i) === STRUCTURE || STRUCTURE_CODES.has(i.code);

// A section's content without its ids, for the inherited rule.
const sectionKey = (s) => stableStringify(stripIds({ sections: [s] }).sections[0]);

// The minimal inherited rule (PUB-03, partial): an error in a hidden section,
// or in a section whose id-stripped content equals the live version's section
// of the same id, warns instead of blocking. Structure and sanitizing still
// block, hidden or inherited (P2-FIX4: by the issue's class, not only its code).
function classify(issues, body, liveBody) {
  // by id: a copy of a live section with a new id is new content, not inherited
  const live = new Map((Array.isArray(liveBody?.sections) ? liveBody.sections : []).filter(isObj).map((s) => [s.id, sectionKey(s)]));
  const byId = new Map((Array.isArray(body?.sections) ? body.sections : []).filter(isObj).map((s) => [s.id, s]));
  return issues.map((i) => {
    if (i.severity !== "error" || !i.sectionId || alwaysBlocks(i)) return i;
    const s = byId.get(i.sectionId);
    if (!s) return i;
    if (s.enabled === false) return { ...i, severity: "warning", level: "warns", message: `${i.message} This section is hidden, so it doesn't stop publishing.` };
    if (live.get(s.id) === sectionKey(s)) return { ...i, severity: "warning", level: "inherited", message: `${i.message} It was already live like this, so it doesn't stop publishing.` };
    return i;
  });
}

// offer: { publishSet } when a remaining block is a link to an unpublished
// document (P3-CHECKS), so "publish both" works from this answer too.
function refusedForIssues(blocked, allIssues, offer = null) {
  const names = blocked.map((d) => quoted(d.label));
  const errors = allIssues.filter((i) => i.severity === "error").length;
  const things = errors === 1 ? "There's 1 thing to fix" : `There are ${errors} things to fix`;
  const which = names.length === 1 ? `in ${names[0]}` : `in ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const body = validationBody(allIssues, { documents: blocked.map((d) => ({ id: d.id, label: d.label })), ...(offer ? { offer } : {}) });
  const { error: _e, code: _c, ...extra } = body;
  return new DocumentError(422, "VALIDATION_FAILED", `${things} ${which}, so nothing was published.`, extra);
}

// P3-CHECKS (PUB-05): every block left is a link to a document that isn't
// live. The answer offers to publish them together.
// P3-FIX2: `lead` names what links ("Your header menu links to" for a menu
// item, checks.js linkLead), "This page links to" otherwise.
function linksToUnpublished(allIssues, offer, targets, lead = "This page links to") {
  const labels = [...new Map(targets.map((t) => [t.id, t.label])).values()];
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const message = labels.length === 1 ? `${lead} ${list}, which isn't published yet.` : `${lead} ${list}, which aren't published yet.`;
  return new DocumentError(422, "LINKS_TO_UNPUBLISHED", message, { issues: allIssues, offer });
}

const offerItem = (d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash, label: d.label });

const REPUBLISH_MESSAGE = "You took this page offline. Publish the same content again?";
const NEEDS_HOME_MESSAGE = "Publish your home page with this, so the store opens with a home page.";
const NO_HOME_MESSAGE = "Your store opens with its home page, and it doesn't have one yet, so nothing was published. Make your home page, then publish it with this.";
export const HOME_ID = "doc_home";

// ---- publish -------------------------------------------------------------------------------

export async function publish({ ids, actor = null } = {}) {
  const wanted = checkSet(ids);
  const mode = await getCmsMode();
  if (mode !== "documents") {
    throw new DocumentError(409, "STORE_USES_LEGACY", "This store still uses the current Storefront editor, so nothing was published here. Publish from Storefront instead.");
  }
  const by = actorString(actor);

  // step 2: each document at the revision and draft the founder saw
  const docs = await readDocuments(wanted.map((w) => w.id));
  const missing = wanted.filter((w) => !docs.has(w.id));
  if (missing.length) throw new NotFoundError(missing.length === 1 ? "This page no longer exists. It may have been deleted. Reload to see your pages." : "Some of these pages no longer exist. Reload to see your pages.");
  for (const w of wanted) {
    const d = docs.get(w.id);
    const t = documentType(d.type);
    if (!t || t.system || !t.editable) throw new DocumentError(409, "NOT_PUBLISHABLE", `${cap(nounOf(d.type))} is made by the store itself and is published with the pages that use it.`, { document: d.id });
    if (!t.publishable) throw new DocumentError(409, "PUBLISH_NOT_AVAILABLE", `${cap(t.noun)} is saved as a draft. Publishing it isn't available yet, so nothing was published.`, { document: d.id });
  }
  const conflicts = [];
  for (const w of wanted) {
    const d = docs.get(w.id);
    if (d.archivedAt) conflicts.push(archived(d));
    else if (d.revision !== w.revision) conflicts.push(stale(d));
    else if (d.draftHash !== w.draftHash) conflicts.push(reviewed(d));
  }
  if (conflicts.length) throw conflictError(await withWho(conflicts, by, (id) => docs.get(id)));

  // step 3: the live pointer and its list
  const live = await readLive();

  // P3-CHECKS (PUB-06): a closed store opens with its home page
  if (live.pointer == null && !docs.has(HOME_ID)) {
    const home = (await readOfferRows([HOME_ID])).get(HOME_ID);
    const set = wanted.map((w) => offerItem(docs.get(w.id)));
    if (!home || home.archived) throw new DocumentError(409, "FIRST_PUBLISH_NEEDS_HOME", NO_HOME_MESSAGE, { offer: null });
    throw new DocumentError(409, "FIRST_PUBLISH_NEEDS_HOME", NEEDS_HOME_MESSAGE, { offer: { publishSet: [...set, offerItem(home)] } });
  }

  // the journal index bodies read by this publish, by version id (read once each)
  const indexBodies = new Map();
  const indexOf = async (list) => {
    const e = list.indexes?.journal;
    if (!e) return { entry: null, body: null };
    if (!indexBodies.has(e.version)) indexBodies.set(e.version, (await journalIndexOf(list)).body);
    return { entry: e, body: indexBodies.get(e.version) };
  };
  const anyPost = wanted.some((w) => docs.get(w.id).type === "journal");
  const liveIndex = anyPost ? await indexOf(live.list) : { entry: null, body: null };

  // step 4: validate and re-sanitize in publish mode, against what is live
  // an offline entry has no live body (P3-COMMIT): nothing in it is inherited
  const liveBodies = await readVersionBodies(wanted.map((w) => liveEntryOf(live.list, liveIndex.body, docs.get(w.id))).filter((e) => e && !e.offline).map((e) => e.version));
  const checked = [];
  for (const w of wanted) {
    const d = docs.get(w.id);
    const liveEntry = liveEntryOf(live.list, liveIndex.body, d);
    const liveBody = liveEntry && !liveEntry.offline ? liveBodies.get(liveEntry.version)?.body ?? null : null;
    const r = isObj(d.body) && d.body.type === d.type
      ? validateDocument(d.body, { mode: "publish", live: liveBody, documentId: d.id })
      : { ok: false, body: d.body, issues: [issue({ documentId: d.id, code: "INVALID_SHAPE", message: `${cap(nounOf(d.type))} couldn't be read. Reload the page and try again.` })] };
    checked.push({ w, doc: d, body: r.body, issues: relevel(r.issues), liveEntry, liveBody });
  }
  // P3-CHECKS: links, the catalog, media and redirects, over the set's own
  // bodies, against M2
  const refs = await referenceChecks({ items: checked, list: live.list, journalBody: async () => (await indexOf(live.list)).body });
  const items = [];
  const allIssues = [];
  const blocked = [];
  const targets = [];
  for (const c of checked) {
    const mine = refs.issues.filter((i) => i.documentId === c.doc.id);
    // the validator's class is read before classify() copies anything
    const structural = new Set([...c.issues, ...mine].filter(alwaysBlocks));
    const issues = classify([...c.issues, ...mine], c.body, c.liveBody);
    for (const i of issues) {
      const target = i.severity === "error" ? refs.targets.get(i) ?? null : null;
      if (target) targets.push(target);
      allIssues.push(decorate(i, { body: c.body, target, structure: structural.has(i) }));
    }
    if (issues.some((i) => i.severity === "error")) {
      blocked.push(c.doc);
      continue;
    }
    items.push({ doc: c.doc, body: c.body, hash: await documentHash(c.body), liveEntry: c.liveEntry, w: c.w });
  }
  if (blocked.length) {
    const inSet = new Set(wanted.map((w) => w.id));
    const extra = [...new Map(targets.filter((t) => !inSet.has(t.id)).map((t) => [t.id, t])).values()];
    const offer = extra.length ? { publishSet: [...wanted.map((w) => offerItem(docs.get(w.id))), ...extra] } : null;
    const onlyLinks = allIssues.filter((i) => i.severity === "error").every((i) => i.code === LINKS_TO_UNPUBLISHED);
    if (offer && onlyLinks) {
      const leads = new Set(allIssues.filter((i) => i.severity === "error").map((i) => linkLead(docs.get(i.documentId)?.type, i.sectionId, "This page links to")));
      throw linksToUnpublished(allIssues, offer, extra, leads.size === 1 ? [...leads][0] : "This page links to");
    }
    throw refusedForIssues(blocked, allIssues, offer);
  }

  // P3-CHECKS (PUB-04): publishing again what was taken offline needs the
  // founder's yes. documentHash of the undone version's body (ids stripped),
  // never its body_hash (ids kept).
  const askFor = items.filter((p) => p.doc.undoneVersionId && !p.w.confirmRepublish);
  if (askFor.length) {
    const undone = await readVersionBodies(askFor.map((p) => p.doc.undoneVersionId));
    for (const p of askFor) {
      const v = undone.get(p.doc.undoneVersionId);
      if (v && isObj(v.body) && (await documentHash(v.body)) === p.doc.draftHash) {
        throw new DocumentError(409, "REPUBLISH_CONFIRM_NEEDED", REPUBLISH_MESSAGE, { id: p.doc.id });
      }
    }
  }

  // step 5: skip what is already live exactly as it is (P22: the pointer,
  // the hash AND the live entry must all agree)
  const skipped = [];
  const toPublish = items.filter((p) => {
    const same = p.doc.publishedVersionId != null && p.hash === p.doc.publishedHash && p.liveEntry?.version === p.doc.publishedVersionId;
    if (same) skipped.push(p.doc.id);
    return !same;
  });
  // P3-CHECKS: a publish clears undone_version_id (it is live again)
  for (const p of toPublish) p.undone = null;
  const warnings = allIssues.filter((i) => i.severity !== "error");
  if (!toPublish.length) return { release: null, setId: null, published: [], skipped, issues: warnings };

  const routeSet = toPublish.some((p) => documentType(p.doc.type).route);
  const hasPost = toPublish.some((p) => p.doc.type === "journal");
  const context = { documents: toPublish.map((p) => p.doc.id) };
  const itemOf = new Map(toPublish.map((p) => [p.doc.id, p]));

  const done = (build, attempt, extra = {}) => {
    slog("documents_publish", { release: build.releaseId, set: build.setId, documents: context.documents, attempt, ...extra });
    const logOf = new Map(build.log.map((l) => [l.document_id, l.id]));
    const placeOf = (id) => {
      const p = itemOf.get(id);
      return liveExitUrl(livePath(p.doc.type, p.body?.meta));
    };
    return {
      release: { id: build.releaseId },
      setId: build.setId,
      published: build.documents.map((d) => ({
        id: d.id,
        versionId: d.published_version_id,
        hash: d.published_hash,
        liveUrl: placeOf(d.id),
        undo: { id: d.id, revision: d.revision, logId: logOf.get(d.id) ?? null },
      })),
      skipped,
      issues: warnings,
    };
  };

  // Every build this call has sent is in `sent`, by its published version ids:
  // a {lost} can hide a batch that committed after commitPublishBatch's
  // read-back (P2-FIX4). A later list that holds one of these ids is this
  // call's own publish, never someone else's.
  // A journal post has no list entry (PERF-01): its live version is its row in
  // the journal index, and the index entry itself is a version minted for one
  // build, so either proves the build too.
  const ownBuildIn = (sent, list, indexBody) => {
    for (const p of toPublish) {
      const b = sent.get(liveEntryOf(list, indexBody, p.doc)?.version);
      if (b) return b;
    }
    return sent.get(list.indexes?.journal?.version) || null;
  };

  return runGuardedBuild(
    async ({ live: from, refs }) => {
      // step 6: slugs, against this list and its journal index (every attempt).
      // The slug of an archived offline page is released (P3-COMMIT).
      const journal = routeSet || hasPost ? await indexOf(from.list) : { entry: null, body: null };
      const slugs = routeSet ? await checkSlugs(from.list, journalEntriesOf(journal.body), toPublish) : { error: null, release: [] };
      if (slugs.error) throw slugs.error;
      // step 7: one build, fresh ids, one batch
      return makeBuild(from, toPublish, { by, at: now(), journal, release: slugs.release, refs });
    },
    {
      live,
      log: context,
      items: toPublish,
      done,
      onLost: async ({ live: was, next, sent }) => {
        const [wasIndex, nextIndex] = hasPost ? [await indexOf(was.list), await indexOf(next.list)] : [{ body: null }, { body: null }];
        // one of this call's own earlier batches went live after all (a batch
        // atomically writes all of its entries, so one entry proves the build)
        const mine = ownBuildIn(sent, next.list, nextIndex.body);
        if (mine) return mine;
        const now2 = await readDocuments(toPublish.map((p) => p.doc.id));
        const moved = [];
        for (const p of toPublish) {
          const cur = now2.get(p.doc.id);
          if (!cur) throw new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: [p.doc.id] });
          if (cur.archivedAt) moved.push(archived(cur));
          else if (cur.revision !== p.doc.revision) moved.push(stale(cur));
          else if (!sameEntry(liveEntryOf(next.list, nextIndex.body, p.doc), liveEntryOf(was.list, wasIndex.body, p.doc))) moved.push(elsewhere(cur));
        }
        if (moved.length) throw conflictError(await withWho(moved, by, (id) => now2.get(id)));
        return null;
      },
    },
  );
}

export const __publishInternals = { classify, slugClash, checkSet, liveFrom, STRUCTURE_CODES, alwaysBlocks, withWho };
