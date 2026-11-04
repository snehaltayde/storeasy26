// P3-COMMIT (PUB-02, PUB-04, PUB-05): the shared build helpers of every
// guarded publish-shaped write (publish, Undo, take offline). Node console
// routes only. Moved out of lib/documents/publish.js with no change in
// behaviour, so publish and Undo share one proven commit core and never fork it.
//
//   readLive()                      the live pointer and its list, one statement
//   liveFrom(pointer, content)      the same, from what a {lost} handed back
//   liveEntryOf(list, journalBody, doc)
//                                   what is live for a document: a journal
//                                   post's row in the journal index, else its
//                                   list entry
//   readVersionBodies(ids)          version bodies by id, one statement
//   journalIndexOf(list)            the live journal index body
//   slugClash(list, journalEntries, items)
//                                   the 409 SLUG_TAKEN naming the other page
//   pageRow(type, body), redirectsOf(body)
//                                   the list's page row and redirects of a body
//   makeBuild(live, items, ctx)     one build with fresh ids (plan section 6)
//   failedError(r, context)         a {failed} outcome in plain words
//   runGuardedBuild(buildFn, context)
//                                   the rebuild loop: up to MAX_ATTEMPTS, with
//                                   the ok / lost / unknown / failed mapping
//
// P3-COMMIT extensions (plan decisions 1 and 4):
//   makeBuild items may carry action, offline, draft, published, undone,
//   expectPublished, extraVersions, undoesLogId, savedVersionId and note (see
//   makeBuild below). Take offline keeps the list entry, pointing at a fresh
//   copy of the last live body, with its pages row or journal index entry
//   enabled: false and its redirects dropped.
//   liveEntryOf: an offline entry is { offline: true, liveBody: null, … }, so
//   nothing in it counts as already live (the inherited rule).
//   slugClash / checkSlugs: the slug of an archived offline page is released
//   (its entry is removed) when a publish claims it. Archive is terminal: no
//   code sets archived_at back to NULL (a grep test), so no guard term is
//   needed for that.
//   draftSlugOwner(slug, exceptId)  which other draft holds a slug
//   hasRefsTable()                  is migration 0023 there (one statement,
//                                   only a yes is remembered)
//   After every build that went live, runAfterCommit (after-commit.js).
//   NotBuiltError                   501 NOT_BUILT, for the phase 3 stubs
import { libsql } from "../db.js";
import { slog } from "../log.js";
import { captureError } from "../errors.js";
import { infraMessage } from "../cms/issues.js";
import { tenantId } from "../tenant-context.js";
import { documentType, singletonTypes, documentHash, SCHEMA_VERSION } from "../registry/index.js";
import { refRows } from "./refs.js";
import { runAfterCommit } from "./after-commit.js";
import { commitPublishBatch } from "./commit.js";
import { emptyList, setEntries, isV4List } from "./release-list.js";
import { relId, setId as newSetId, logId } from "./ids.js";
import { versionRow } from "./versions.js";
import { DocumentError } from "./service.js";
import { JOURNAL_INDEX_ID, journalEntriesOf, nextJournalIndexBody } from "./journal-index.js";

export const MAX_ATTEMPTS = 3;

export const BUSY_MESSAGE = "Publishing is busy, try again in a moment: nothing was published. Your live store hasn't changed.";
export const UNKNOWN_MESSAGE = "Your publish may have gone live. Reload to check.";
export const DELETED_MESSAGE = "This page was deleted while you were publishing. Reload to see the current pages.";
export const RELEASES_MESSAGE = "This store still publishes with Releases, so nothing was published here. Publish from Releases until the move to the new editor is done.";

// Tests only (the "interleave hook"): beforeCommit({ attempt, build }) runs
// after the build and before its batch; commit(build) replaces
// commitPublishBatch (a spy, or a forced outcome). Production never sets them.
const hooks = {};
export function setBuildHooks(h = {}) {
  for (const k of Object.keys(hooks)) delete hooks[k];
  Object.assign(hooks, h || {});
}

// P3-COMMIT: what a phase 3 stub answers until its owner lands (501).
export class NotBuiltError extends DocumentError {
  constructor(message = "This isn't available yet.") {
    super(501, "NOT_BUILT", message);
    this.name = "NotBuiltError";
  }
}

// ---- migration 0023 ------------------------------------------------------------------

// Tenants whose document_refs table was seen, in this isolate. Only a yes is
// remembered: a missing table is asked again on the next publish, so a store
// migrated while the instance is warm starts writing refs at once. One
// statement per publish until 0023 has run, none after.
const refsSeen = new Set();
export async function hasRefsTable() {
  const key = tenantId();
  if (refsSeen.has(key)) return true;
  const r = await libsql.execute("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'document_refs'");
  if (!r.rows.length) return false;
  refsSeen.add(key);
  return true;
}
// Tests only.
export const __forgetRefsTable = () => refsSeen.clear();

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const quoted = (label) => `“${label}”`;

// The highest manifest any registered singleton is listed from: what a first
// list is made at.
const currentManifest = () => Math.max(1, ...singletonTypes().map((t) => documentType(t).sinceManifest || 1));

// ---- reads ---------------------------------------------------------------------------

// The live pointer and its list, in one statement (the P2-VGATE join).
export async function readLive() {
  const r = await libsql.execute("SELECT s.live_release_id AS live, r.content AS content FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const row = r.rows[0] || {};
  return liveFrom(row.live ?? null, row.content ?? null);
}

export function liveFrom(pointer, content) {
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

// What is live for a document: a journal post's row in the journal index
// (`journalBody`, the body of list.indexes.journal), else its list entry.
// Index rows carry no hash; version ids are minted fresh for every build, so
// the version alone says whether the post moved.
//
// P3-COMMIT: an entry taken offline (its pages row or index entry enabled:
// false, and the document no longer pointing at that version) comes back as
// { version, hash, offline: true, liveBody: null }: nothing in it is live, so
// the inherited rule never applies to it. A page the founder hid with its own
// meta.enabled is still published (the document points at the listed
// version), so it is not offline.
export function liveEntryOf(list, journalBody, doc) {
  if (doc.type === "journal") {
    const row = journalEntriesOf(journalBody).find((e) => e.document === doc.id);
    if (row && typeof row.version === "string") {
      const e = { version: row.version, hash: null };
      return row.enabled === false && doc.publishedVersionId !== row.version ? { ...e, offline: true, liveBody: null } : e;
    }
  }
  const e = entryOf(list, doc.id);
  if (!e) return e;
  const page = list.pages.find((p) => p.document === doc.id);
  return page && page.enabled === false && doc.publishedVersionId !== e.version ? { ...e, offline: true, liveBody: null } : e;
}
export const sameEntry = (a, b) => (a == null && b == null) || (a != null && b != null && a.version === b.version && a.hash === b.hash);

// Version bodies by id, in one statement: Map id -> { document_id, body }.
export async function readVersionBodies(versionIds) {
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

// ---- the page list and slugs ---------------------------------------------------------

export const pageRow = (type, body) => {
  const m = body.meta;
  return { slug: m.slug, type, title: m.title, description: m.description ?? null, enabled: m.enabled !== false, effective_at: m.effective_at ?? null, window_start: m.window_start ?? null, window_end: m.window_end ?? null };
};
export const redirectsOf = (body) => (Array.isArray(body.meta?.redirect_from) ? [...new Set(body.meta.redirect_from)].filter((s) => s !== body.meta.slug).map((from) => ({ from_slug: from, to_slug: body.meta.slug })) : []);

// Every slug a live page or post will hold after this publish must be held by
// one document only (DOC-10, partial). The other page is named.
// P3-COMMIT: { error, release }. A disabled (offline) entry whose document is
// in `archived` doesn't hold its slug; when this set claims that slug, the
// document is listed in `release` and makeBuild removes its entry. A disabled
// entry of a document that is not archived still holds its slug (plan
// decision 4: an offline page keeps its address until it is archived).
export function slugClash(list, journalEntries, items, { archived = new Set() } = {}) {
  const inSet = new Set(items.map((p) => p.doc.id));
  const taken = new Map();
  const releasable = new Map();
  const hold = (row, title) => {
    if (inSet.has(row.document)) return;
    if (row.enabled === false && archived.has(row.document)) {
      if (!releasable.has(row.slug)) releasable.set(row.slug, row.document);
      return;
    }
    if (!taken.has(row.slug)) taken.set(row.slug, { id: row.document, title });
  };
  for (const p of list.pages) hold(p, p.title || p.slug);
  for (const e of journalEntries) hold(e, e.title || e.slug);
  const release = new Set();
  for (const p of items) {
    if (!documentType(p.doc.type)?.route) continue;
    const slug = p.body.meta.slug;
    const other = taken.get(slug);
    if (other) {
      const error = new DocumentError(
        409,
        "SLUG_TAKEN",
        `Another live page already uses /${slug}: ${other.title}. Change the address of ${quoted(p.doc.label)}, then publish again.`,
        { slug, document: p.doc.id, other },
      );
      return { error, release: [] };
    }
    if (releasable.has(slug)) release.add(releasable.get(slug));
    taken.set(slug, { id: p.doc.id, title: p.body.meta.title || slug });
  }
  return { error: null, release: [...release] };
}

// The documents of disabled entries that hold a slug this set wants: the only
// ones whose archived state matters. Pure.
export function disabledHolders(list, journalEntries, items) {
  const inSet = new Set(items.map((p) => p.doc.id));
  const wanted = new Set(items.filter((p) => documentType(p.doc.type)?.route).map((p) => p.body?.meta?.slug));
  const out = new Set();
  for (const row of [...list.pages, ...journalEntries]) if (row.enabled === false && wanted.has(row.slug) && !inSet.has(row.document)) out.add(row.document);
  return [...out];
}

// Which of these documents are archived: one statement, and none at all when
// no disabled entry holds a wanted slug.
export async function archivedAmong(ids) {
  if (!ids.length) return new Set();
  const r = await libsql.execute({ sql: `SELECT id FROM documents WHERE id IN (${ids.map(() => "?").join(", ")}) AND archived_at IS NOT NULL`, args: ids });
  return new Set(r.rows.map((row) => String(row.id)));
}

// slugClash with the archived state it needs read first.
export async function checkSlugs(list, journalEntries, items) {
  const holders = disabledHolders(list, journalEntries, items);
  return slugClash(list, journalEntries, items, { archived: await archivedAmong(holders) });
}

// The other non-archived document whose draft holds `slug`, or null. One
// statement (documents_slug is unique over non-archived drafts).
export async function draftSlugOwner(slug, exceptId) {
  if (typeof slug !== "string" || !slug) return null;
  const r = await libsql.execute({ sql: "SELECT id, label FROM documents WHERE slug = ? AND archived_at IS NULL AND id <> ?", args: [slug, String(exceptId ?? "")] });
  const row = r.rows[0];
  return row ? { id: String(row.id), label: String(row.label) } : null;
}

export async function journalIndexOf(list) {
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

// ---- the build -------------------------------------------------------------------------

// items: [{ doc, body, hash, liveEntry, … }] where doc is the document row
// as publish.js reads it, body the body to put live, hash its documentHash.
// P3-COMMIT: each item may also carry
//   action          'publish' (default) | 'unpublish' | 'undo': the log action
//   offline: true   take it offline: `body` is the last live body (not
//                   edited, so its documentHash is unchanged). A fresh
//                   version of it keeps the list entry; the pages row (or a
//                   post's index entry) is enabled: false and the redirects
//                   are dropped. Route documents only.
//   draft           {body, hash, slug, label}: rewrite the draft in the batch
//                   (revision + 1)
//   published       {versionId|null, hash|null}: the pointer fields. Default:
//                   this build's fresh version and documentHash(body); for an
//                   offline item {null, null}
//   undone          id|null: undone_version_id (left as it is when absent)
//   expectPublished id|null: the batch loses unless published_version_id is
//                   still this
//   extraVersions   [{id, kind: 'undo_saved', body, by?, note?}]: kept,
//                   never listed, inside the guarded batch
//   undoesLogId, savedVersionId, note   the log row's fields
// ctx: { by, at, journal: {body}, release: [document ids] (slugClash), refs:
// true to write document_refs rows for every fresh published version }.
export async function makeBuild(live, items, { by, at, journal, release = [], refs = false }) {
  const versions = [];
  const extraVersions = [];
  const documents = [];
  const log = [];
  const changes = [];
  const refRowsOut = [];
  const sid = newSetId();
  const releaseId = relId();
  const posts = [];
  const disabled = [];
  for (const p of items) {
    const t = documentType(p.doc.type);
    const offline = p.offline === true;
    if (offline && !t?.route) throw new Error(`makeBuild: ${p.doc.id} has no address, so it can't be taken offline`);
    // always a fresh published version row: never a checkpoint's or any other
    // existing version id (plan section 6). Undo and take offline copy the
    // body into a new one too.
    const v = await versionRow({ documentId: p.doc.id, kind: "published", body: p.body, schemaVersion: SCHEMA_VERSION, createdBy: by, createdAt: at });
    versions.push(v);
    if (refs) refRowsOut.push(...refRows(v.id, p.body));
    // documents.published_hash is documentHash(body) (ids stripped), never
    // v.body_hash (ids kept)
    const hash = typeof p.hash === "string" ? p.hash : await documentHash(p.body);
    const published = isObj(p.published) ? { versionId: p.published.versionId ?? null, hash: p.published.hash ?? null } : offline ? { versionId: null, hash: null } : { versionId: v.id, hash };
    const doc = { id: p.doc.id, revision: p.doc.revision, published_version_id: published.versionId, published_hash: published.hash };
    if (p.undone !== undefined) doc.undone = p.undone ?? null;
    if (p.expectPublished !== undefined) doc.expectPublished = p.expectPublished ?? null;
    if (p.draft !== undefined) doc.draft = { body: p.draft.body, hash: p.draft.hash, slug: p.draft.slug ?? null, label: p.draft.label, by: p.draft.by ?? by, at: p.draft.at ?? at };
    documents.push(doc);
    for (const ev of p.extraVersions || []) {
      extraVersions.push(await versionRow({ id: ev.id, documentId: p.doc.id, kind: ev.kind ?? "undo_saved", body: ev.body, schemaVersion: SCHEMA_VERSION, note: ev.note ?? null, createdBy: ev.by ?? by, createdAt: at }));
    }
    log.push({
      id: logId(),
      document_id: p.doc.id,
      action: p.action ?? "publish",
      from_version_id: p.liveEntry?.version ?? null,
      to_version_id: v.id,
      actor: by,
      undoes_log_id: p.undoesLogId ?? null,
      saved_version_id: p.savedVersionId ?? null,
      note: p.note ?? null,
    });
    const listed = t.route && p.doc.type !== "journal";
    const rows = listed ? [offline ? { ...pageRow(p.doc.type, p.body), enabled: false } : pageRow(p.doc.type, p.body)] : [];
    changes.push({ document: p.doc.id, entry: { version: v.id, hash: v.body_hash }, pages: rows, redirects: t.route && !offline ? redirectsOf(p.body) : [] });
    if (p.doc.type === "journal") {
      posts.push({ documentId: p.doc.id, versionId: v.id, body: p.body });
      if (offline) disabled.push(p.doc.id);
    }
  }
  // archived offline documents whose slug this set claims (slugClash)
  const inIndex = new Set(journalEntriesOf(journal?.body).map((e) => e.document));
  for (const id of release) {
    changes.push({ document: id, remove: true });
    if (inIndex.has(id)) posts.push({ documentId: id, remove: true });
  }
  if (posts.length) {
    const indexBody = nextJournalIndexBody(journal.body, posts, { disabled });
    const iv = await versionRow({ documentId: JOURNAL_INDEX_ID, kind: "published", body: indexBody, schemaVersion: SCHEMA_VERSION, note: "Journal index", createdBy: by, createdAt: at });
    versions.push(iv);
    changes.push({ index: "journal", entry: { version: iv.id, hash: iv.body_hash } });
  }
  const list = setEntries(live.list, changes);
  // posts are listed through the index only (PERF-01); their redirects stay
  for (const p of posts) delete list.documents[p.documentId];
  const build = { releaseId, setId: sid, pointer: live.pointer, list, versions, documents, log, actor: by, now: at, note: null };
  if (extraVersions.length) build.extraVersions = extraVersions;
  if (refRowsOut.length) build.refs = refRowsOut;
  return build;
}

// ---- outcomes ----------------------------------------------------------------------------

export function failedError(r, context) {
  if (r.code === "MISSING_DOCUMENT") return new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: r.missing || [] });
  slog("documents_publish_failed", { ...context, code: r.code || "THREW", error: String(r.cause?.message || r.cause || "").slice(0, 300), problems: r.problems });
  captureError({ source: "documents-publish", error: r.cause instanceof Error ? r.cause : new Error(`publish failed: ${r.code}`), extra: { ...context, code: r.code } }).catch(() => {});
  return new DocumentError(500, "PUBLISH_FAILED", infraMessage("internal", "publish"), { reason: r.code || "THREW" });
}

// A draft rewrite (Undo) whose slug another draft holds: the batch refused on
// documents_slug, so nothing was written. Name the other page when it can be
// read back; the refusal stands without the name.
async function draftSlugTaken(build) {
  for (const d of build.documents) {
    if (!d.draft?.slug) continue;
    let other = null;
    try {
      other = await draftSlugOwner(d.draft.slug, d.id);
    } catch {
      other = null;
    }
    if (other || build.documents.filter((x) => x.draft?.slug).length === 1) {
      const slug = d.draft.slug;
      return new DocumentError(409, "SLUG_TAKEN", other ? `Another page already uses /${slug}: ${other.label}` : `Another page already uses /${slug}`, {
        slug,
        other: other ? { id: other.id, title: other.label, label: other.label } : null,
      });
    }
  }
  return new DocumentError(409, "SLUG_TAKEN", "Another page already uses this address", { slug: null, other: null });
}

// ---- the rebuild loop ----------------------------------------------------------------------

// One guarded write, rebuilt from what moved until it commits:
//   buildFn({ attempt, live })     makes this attempt's build from `live` (and
//                                  may throw a refusal, such as a slug clash)
//   context.live                   the live pointer and list the first build
//                                  starts from
//   context.log                    fields for the log lines
//   context.onLost({ attempt, live, next, sent })
//                                  after a {lost}: returns one of this call's
//                                  own earlier builds when `next` shows it went
//                                  live after all (`sent` maps every version id
//                                  sent so far to its build), throws a refusal
//                                  when something the founder saw moved, or
//                                  returns null to rebuild from `next`
//   context.done(build, attempt, extra)
//                                  the answer for a build that is live
//   context.items                  handed to the after-commit handlers
// buildFn also gets { refs }: whether document_refs (0023) is there, probed
// once per call (hasRefsTable); when it isn't, the build must leave the refs
// out, and 'document_refs_missing' is logged.
// Outcomes: ok -> done; unknown -> 503 PUBLISH_UNKNOWN, never rebuilt; failed
// -> failedError (never "someone else published"); lost -> onLost, then a
// rebuild, and after MAX_ATTEMPTS losses 503 PUBLISH_BUSY.
export async function runGuardedBuild(buildFn, context) {
  const { log = {}, onLost, done, items = [] } = context;
  let live = context.live;
  const refs = await hasRefsTable();
  if (!refs) slog("document_refs_missing", { ...log });
  // Only `versions` go in here, never extraVersions: a kept (undo_saved)
  // version is in no list slot, so it can't show that a build went live.
  const sent = new Map();
  const live_ = async (build, attempt, extra) => {
    await runAfterCommit({ build, items });
    return done(build, attempt, extra);
  };
  for (let attempt = 1; ; attempt++) {
    const build = await buildFn({ attempt, live, refs });
    for (const v of build.versions) sent.set(v.id, build);
    if (hooks.beforeCommit) await hooks.beforeCommit({ attempt, build });
    let r;
    try {
      r = await (hooks.commit || commitPublishBatch)(build);
    } catch (cause) {
      r = { failed: true, outcome: "failed", code: "THREW", cause };
    }
    if (!isObj(r)) r = { failed: true, outcome: "failed", code: "NO_OUTCOME" };

    if (r.ok) return live_(build, attempt, { reconciled: !!r.reconciled });
    if (r.unknown) {
      slog("documents_publish_unknown", { ...log, release: build.releaseId, error: String(r.cause?.message || "").slice(0, 200), readError: String(r.readError?.message || "").slice(0, 200) });
      throw new DocumentError(503, "PUBLISH_UNKNOWN", UNKNOWN_MESSAGE, { release: { id: build.releaseId } });
    }
    if (r.failed && r.code === "SLUG_TAKEN") throw await draftSlugTaken(build);
    if (!r.lost) throw failedError(r, { ...log, release: build.releaseId, attempt });

    // lost: what moved?
    slog("documents_publish_lost", { ...log, attempt, busy: !!r.busy, pointer: r.pointer ?? null });
    const next = liveFrom(r.pointer ?? null, r.list ?? null);
    const mine = await onLost({ attempt, live, next, sent });
    if (mine) return live_(mine, attempt, { reconciled: true, lateCommit: true });
    if (attempt >= MAX_ATTEMPTS) {
      slog("documents_publish_busy", { ...log, attempts: attempt });
      throw new DocumentError(503, "PUBLISH_BUSY", BUSY_MESSAGE);
    }
    live = next;
  }
}
