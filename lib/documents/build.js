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
import { libsql } from "../db.js";
import { slog } from "../log.js";
import { captureError } from "../errors.js";
import { infraMessage } from "../cms/issues.js";
import { documentType, singletonTypes, SCHEMA_VERSION } from "../registry/index.js";
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
export function liveEntryOf(list, journalBody, doc) {
  if (doc.type === "journal") {
    const row = journalEntriesOf(journalBody).find((e) => e.document === doc.id);
    if (row && typeof row.version === "string") return { version: row.version, hash: null };
  }
  return entryOf(list, doc.id);
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
export function slugClash(list, journalEntries, items) {
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

export async function makeBuild(live, items, { by, at, journal }) {
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
    log.push({ id: logId(), document_id: p.doc.id, action: "publish", from_version_id: p.liveEntry?.version ?? null, to_version_id: v.id, actor: by });
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
  // posts are listed through the index only (PERF-01); their redirects stay
  for (const p of posts) delete list.documents[p.documentId];
  return { releaseId, setId: sid, pointer: live.pointer, list, versions, documents, log, actor: by, now: at, note: null };
}

// ---- outcomes ----------------------------------------------------------------------------

export function failedError(r, context) {
  if (r.code === "MISSING_DOCUMENT") return new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: r.missing || [] });
  slog("documents_publish_failed", { ...context, code: r.code || "THREW", error: String(r.cause?.message || r.cause || "").slice(0, 300), problems: r.problems });
  captureError({ source: "documents-publish", error: r.cause instanceof Error ? r.cause : new Error(`publish failed: ${r.code}`), extra: { ...context, code: r.code } }).catch(() => {});
  return new DocumentError(500, "PUBLISH_FAILED", infraMessage("internal", "publish"), { reason: r.code || "THREW" });
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
// Outcomes: ok -> done; unknown -> 503 PUBLISH_UNKNOWN, never rebuilt; failed
// -> failedError (never "someone else published"); lost -> onLost, then a
// rebuild, and after MAX_ATTEMPTS losses 503 PUBLISH_BUSY.
export async function runGuardedBuild(buildFn, context) {
  const { log = {}, onLost, done } = context;
  let live = context.live;
  const sent = new Map();
  for (let attempt = 1; ; attempt++) {
    const build = await buildFn({ attempt, live });
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
      slog("documents_publish_unknown", { ...log, release: build.releaseId, error: String(r.cause?.message || "").slice(0, 200), readError: String(r.readError?.message || "").slice(0, 200) });
      throw new DocumentError(503, "PUBLISH_UNKNOWN", UNKNOWN_MESSAGE, { release: { id: build.releaseId } });
    }
    if (!r.lost) throw failedError(r, { ...log, release: build.releaseId, attempt });

    // lost: what moved?
    slog("documents_publish_lost", { ...log, attempt, busy: !!r.busy, pointer: r.pointer ?? null });
    const next = liveFrom(r.pointer ?? null, r.list ?? null);
    const mine = await onLost({ attempt, live, next, sent });
    if (mine) return done(mine, attempt, { reconciled: true, lateCommit: true });
    if (attempt >= MAX_ATTEMPTS) {
      slog("documents_publish_busy", { ...log, attempts: attempt });
      throw new DocumentError(503, "PUBLISH_BUSY", BUSY_MESSAGE);
    }
    live = next;
  }
}
