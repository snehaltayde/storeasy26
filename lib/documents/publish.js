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
import { libsql } from "../db.js";
import { getCmsMode } from "../cms-mode.js";
import { slog } from "../log.js";
import { captureError } from "../errors.js";
import { issue, NotFoundError, validationBody, infraMessage } from "../cms/issues.js";
import { documentType, singletonTypes, validateDocument, documentHash, stripIds, stableStringify, SCHEMA_VERSION } from "../registry/index.js";
import { issueClass, STRUCTURE } from "../registry/validate.js";
import { commitPublishBatch } from "./commit.js";
import { emptyList, setEntries, isV4List } from "./release-list.js";
import { relId, setId as newSetId, logId } from "./ids.js";
import { versionRow } from "./versions.js";
import { DocumentError, publicDocument, actorString } from "./service.js";
import { JOURNAL_INDEX_ID, journalEntriesOf, nextJournalIndexBody } from "./journal-index.js";

export const PUBLISH_SET_CAP = 200;
export const MAX_ATTEMPTS = 3;

export const BUSY_MESSAGE = "Publishing is busy, try again in a moment: nothing was published. Your live store hasn't changed.";
export const UNKNOWN_MESSAGE = "Your publish may have gone live. Reload to check.";
export const DELETED_MESSAGE = "This page was deleted while you were publishing. Reload to see the current pages.";
export const RELEASES_MESSAGE = "This store still publishes with Releases, so nothing was published here. Publish from Releases until the move to the new editor is done.";

// Tests only (the "interleave hook"): beforeCommit({ attempt, build }) runs
// after the build and before its batch; commit(build) replaces
// commitPublishBatch (a spy, or a forced outcome). Production never sets them.
const hooks = {};
export function setPublishHooks(h = {}) {
  for (const k of Object.keys(hooks)) delete hooks[k];
  Object.assign(hooks, h || {});
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const now = () => new Date().toISOString();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nounOf = (type) => documentType(type)?.noun || "this page";
const quoted = (label) => `“${label}”`;

// The highest manifest any registered singleton is listed from: what a first
// list is made at.
const currentManifest = () => Math.max(1, ...singletonTypes().map((t) => documentType(t).sinceManifest || 1));

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
    return { id: it.id, revision: it.revision, draftHash: it.draftHash };
  });
}

// ---- reads ---------------------------------------------------------------------------

const DOC_COLS = "id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, published_version_id, published_hash, undone_version_id, archived_at, created_at, updated_at";

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
  return new Map(r.rows.map((row) => [String(row.id), fromRow(row)]));
}

// The live pointer and its list, in one statement (the P2-VGATE join).
async function readLive() {
  const r = await libsql.execute("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const row = r.rows[0] || {};
  return liveFrom(row.live ?? null, row.content ?? null);
}

function liveFrom(pointer, content) {
  if (pointer == null) return { pointer: null, list: emptyList(currentManifest(), singletonTypes()) };
  let list = content;
  if (typeof content === "string") {
    try {
      list = JSON.parse(content);
    } catch {
      list = null;
    }
  }
  if (isObj(list) && [1, 2, 3].includes(list.v)) throw new DocumentError(409, "STORE_USES_RELEASES", RELEASES_MESSAGE);
  if (!isV4List(list)) {
    const e = new Error(`publish: the live release ${pointer} is not a readable release list`);
    e.code = "BAD_LIVE_LIST";
    throw e;
  }
  return { pointer: String(pointer), list };
}

const entryOf = (list, id) => (Object.hasOwn(list.documents, id) ? list.documents[id] : null);
const sameEntry = (a, b) => (a == null && b == null) || (a != null && b != null && a.version === b.version && a.hash === b.hash);

// Version bodies by id, in one statement: Map id -> { document_id, body }.
async function readVersionBodies(versionIds) {
  const ids = [...new Set(versionIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const r = await libsql.execute({ sql: `SELECT id, document_id, body FROM document_versions WHERE id IN (${ids.map(() => "?").join(", ")})`, args: ids });
  const out = new Map();
  for (const row of r.rows) {
    let body = null;
    try {
      body = JSON.parse(String(row.body));
    } catch {
      body = null;
    }
    out.set(String(row.id), { document_id: String(row.document_id), body });
  }
  return out;
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
    if (s.enabled === false) return { ...i, severity: "warning", message: `${i.message} This section is hidden, so it doesn't stop publishing.` };
    if (live.get(s.id) === sectionKey(s)) return { ...i, severity: "warning", message: `${i.message} It was already live like this, so it doesn't stop publishing.` };
    return i;
  });
}

function refusedForIssues(blocked, allIssues) {
  const names = blocked.map((d) => quoted(d.label));
  const errors = allIssues.filter((i) => i.severity === "error").length;
  const things = errors === 1 ? "There's 1 thing to fix" : `There are ${errors} things to fix`;
  const which = names.length === 1 ? `in ${names[0]}` : `in ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const body = validationBody(allIssues, { documents: blocked.map((d) => ({ id: d.id, label: d.label })) });
  const { error: _e, code: _c, ...extra } = body;
  return new DocumentError(422, "VALIDATION_FAILED", `${things} ${which}, so nothing was published.`, extra);
}

// ---- the page list and slugs (step 6) ------------------------------------------------------

const pageRow = (type, body) => {
  const m = body.meta;
  return { slug: m.slug, type, title: m.title, description: m.description ?? null, enabled: m.enabled !== false, effective_at: m.effective_at ?? null, window_start: m.window_start ?? null, window_end: m.window_end ?? null };
};
const redirectsOf = (body) => (Array.isArray(body.meta?.redirect_from) ? [...new Set(body.meta.redirect_from)].filter((s) => s !== body.meta.slug).map((from) => ({ from_slug: from, to_slug: body.meta.slug })) : []);

// Every slug a live page or post will hold after this publish must be held by
// one document only (DOC-10, partial). The other page is named.
function slugClash(list, journalEntries, items) {
  const inSet = new Set(items.map((p) => p.doc.id));
  const taken = new Map();
  for (const p of list.pages) if (!inSet.has(p.document)) taken.set(p.slug, { id: p.document, title: p.title || p.slug });
  for (const e of journalEntries) if (!inSet.has(e.document) && !taken.has(e.slug)) taken.set(e.slug, { id: e.document, title: e.title || e.slug });
  for (const p of items) {
    if (!documentType(p.doc.type)?.route) continue;
    const slug = p.body.meta.slug;
    const other = taken.get(slug);
    if (other) {
      return new DocumentError(
        409,
        "SLUG_TAKEN",
        `Another live page already uses /${slug}: ${other.title}. Change the address of ${quoted(p.doc.label)}, then publish again.`,
        { slug, document: p.doc.id, other },
      );
    }
    taken.set(slug, { id: p.doc.id, title: p.body.meta.title || slug });
  }
  return null;
}

async function journalIndexOf(list) {
  const e = list.indexes?.journal;
  if (!e) return { entry: null, body: null };
  const v = (await readVersionBodies([e.version])).get(e.version);
  if (!v || !isObj(v.body)) {
    const err = new Error(`publish: the live journal index version ${e.version} couldn't be read`);
    err.code = "JOURNAL_INDEX_UNREADABLE";
    throw err;
  }
  return { entry: e, body: v.body };
}

// ---- the build (step 7) ----------------------------------------------------------------------

async function makeBuild(live, items, { by, at, journal }) {
  const versions = [];
  const documents = [];
  const log = [];
  const changes = [];
  const sid = newSetId();
  const releaseId = relId();
  const posts = [];
  for (const p of items) {
    // always a fresh published version row: never a checkpoint's or any other
    // existing version id (plan section 6)
    const v = await versionRow({ documentId: p.doc.id, kind: "published", body: p.body, schemaVersion: SCHEMA_VERSION, createdBy: by, createdAt: at });
    versions.push(v);
    documents.push({ id: p.doc.id, revision: p.doc.revision, published_version_id: v.id, published_hash: p.hash });
    log.push({ id: logId(), document_id: p.doc.id, action: "publish", from_version_id: entryOf(live.list, p.doc.id)?.version ?? null, to_version_id: v.id, actor: by });
    const t = documentType(p.doc.type);
    const listed = t.route && p.doc.type !== "journal";
    changes.push({ document: p.doc.id, entry: { version: v.id, hash: v.body_hash }, pages: listed ? [pageRow(p.doc.type, p.body)] : [], redirects: t.route ? redirectsOf(p.body) : [] });
    if (p.doc.type === "journal") posts.push({ documentId: p.doc.id, versionId: v.id, body: p.body });
  }
  if (posts.length) {
    const indexBody = nextJournalIndexBody(journal.body, posts);
    const iv = await versionRow({ documentId: JOURNAL_INDEX_ID, kind: "published", body: indexBody, schemaVersion: SCHEMA_VERSION, note: "Journal index", createdBy: by, createdAt: at });
    versions.push(iv);
    changes.push({ index: "journal", entry: { version: iv.id, hash: iv.body_hash } });
  }
  const list = setEntries(live.list, changes);
  return { releaseId, setId: sid, pointer: live.pointer, list, versions, documents, log, actor: by, now: at, note: null };
}

// ---- outcomes ----------------------------------------------------------------------------

function failedError(r, context) {
  if (r.code === "MISSING_DOCUMENT") return new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: r.missing || [] });
  slog("documents_publish_failed", { ...context, code: r.code || "THREW", error: String(r.cause?.message || r.cause || "").slice(0, 300), problems: r.problems });
  captureError({ source: "documents-publish", error: r.cause instanceof Error ? r.cause : new Error(`publish failed: ${r.code}`), extra: { ...context, code: r.code } }).catch(() => {});
  return new DocumentError(500, "PUBLISH_FAILED", infraMessage("internal", "publish"), { reason: r.code || "THREW" });
}

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
  if (conflicts.length) throw conflictError(conflicts);

  // step 3: the live pointer and its list
  let live = await readLive();

  // step 4: validate and re-sanitize in publish mode, against what is live
  const liveBodies = await readVersionBodies(wanted.map((w) => entryOf(live.list, w.id)?.version));
  const items = [];
  const allIssues = [];
  const blocked = [];
  for (const w of wanted) {
    const d = docs.get(w.id);
    const liveEntry = entryOf(live.list, d.id);
    const liveBody = liveEntry ? liveBodies.get(liveEntry.version)?.body ?? null : null;
    const r = isObj(d.body) && d.body.type === d.type
      ? validateDocument(d.body, { mode: "publish", live: liveBody, documentId: d.id })
      : { ok: false, body: d.body, issues: [issue({ documentId: d.id, code: "INVALID_SHAPE", message: `${cap(nounOf(d.type))} couldn't be read. Reload the page and try again.` })] };
    const issues = classify(r.issues, r.body, liveBody);
    allIssues.push(...issues);
    if (issues.some((i) => i.severity === "error")) {
      blocked.push(d);
      continue;
    }
    items.push({ doc: d, body: r.body, hash: await documentHash(r.body), liveEntry });
  }
  if (blocked.length) throw refusedForIssues(blocked, allIssues);

  // step 5: skip what is already live exactly as it is
  const skipped = [];
  const toPublish = items.filter((p) => {
    const same = p.doc.publishedVersionId != null && p.hash === p.doc.publishedHash && p.liveEntry?.version === p.doc.publishedVersionId;
    if (same) skipped.push(p.doc.id);
    return !same;
  });
  const warnings = allIssues.filter((i) => i.severity !== "error");
  if (!toPublish.length) return { release: null, setId: null, published: [], skipped, issues: warnings };

  const routeSet = toPublish.some((p) => documentType(p.doc.type).route);
  const hasPost = toPublish.some((p) => p.doc.type === "journal");
  const context = { documents: toPublish.map((p) => p.doc.id) };

  // Every build this call has sent, by its published version ids: a {lost}
  // can hide a batch that committed after commitPublishBatch's read-back
  // (P2-FIX4). A later list that holds one of these ids is this call's own
  // publish, never someone else's.
  const sent = new Map();
  const done = (build, attempt, extra = {}) => {
    slog("documents_publish", { release: build.releaseId, set: build.setId, documents: context.documents, attempt, ...extra });
    return {
      release: { id: build.releaseId },
      setId: build.setId,
      published: build.documents.map((d) => ({ id: d.id, versionId: d.published_version_id, hash: d.published_hash })),
      skipped,
      issues: warnings,
    };
  };
  const ownBuildIn = (list) => {
    for (const p of toPublish) {
      const b = sent.get(entryOf(list, p.doc.id)?.version);
      if (b) return b;
    }
    return null;
  };

  for (let attempt = 1; ; attempt++) {
    // step 6: slugs, against this list and its journal index
    const journal = routeSet || hasPost ? await journalIndexOf(live.list) : { entry: null, body: null };
    const clash = routeSet ? slugClash(live.list, journalEntriesOf(journal.body), toPublish) : null;
    if (clash) throw clash;

    // step 7: one build, fresh ids, one batch
    const at = now();
    const build = await makeBuild(live, toPublish, { by, at, journal });
    for (const v of build.versions) sent.set(v.id, build);
    if (hooks.beforeCommit) await hooks.beforeCommit({ attempt, build });
    let r;
    try {
      r = await (hooks.commit || commitPublishBatch)(build);
    } catch (cause) {
      r = { failed: true, outcome: "failed", code: "THREW", cause };
    }
    if (!isObj(r)) r = { failed: true, outcome: "failed", code: "NO_OUTCOME" };

    if (r.ok) return done(build, attempt, { reconciled: !!r.reconciled });
    if (r.unknown) {
      slog("documents_publish_unknown", { ...context, release: build.releaseId, error: String(r.cause?.message || "").slice(0, 200), readError: String(r.readError?.message || "").slice(0, 200) });
      throw new DocumentError(503, "PUBLISH_UNKNOWN", UNKNOWN_MESSAGE, { release: { id: build.releaseId } });
    }
    if (!r.lost) throw failedError(r, { ...context, release: build.releaseId, attempt });

    // lost: what moved?
    slog("documents_publish_lost", { ...context, attempt, busy: !!r.busy, pointer: r.pointer ?? null });
    const next = liveFrom(r.pointer ?? null, r.list ?? null);
    // one of this call's own earlier batches went live after all (a batch
    // atomically writes all of its entries, so one entry proves the build)
    const mine = ownBuildIn(next.list);
    if (mine) return done(mine, attempt, { reconciled: true, lateCommit: true });
    const now2 = await readDocuments(toPublish.map((p) => p.doc.id));
    const moved = [];
    for (const p of toPublish) {
      const cur = now2.get(p.doc.id);
      if (!cur) throw new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: [p.doc.id] });
      if (cur.archivedAt) moved.push(archived(cur));
      else if (cur.revision !== p.doc.revision) moved.push(stale(cur));
      else if (!sameEntry(entryOf(next.list, p.doc.id), entryOf(live.list, p.doc.id))) moved.push(elsewhere(cur));
    }
    if (moved.length) throw conflictError(moved);
    if (attempt >= MAX_ATTEMPTS) {
      slog("documents_publish_busy", { ...context, attempts: attempt });
      throw new DocumentError(503, "PUBLISH_BUSY", BUSY_MESSAGE);
    }
    live = next;
  }
}

export const __publishInternals = { classify, slugClash, checkSet, liveFrom, STRUCTURE_CODES, alwaysBlocks };
