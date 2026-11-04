// P2-DOCS (DOC-01, DOC-02, DOC-04, DOC-05, DOC-07, DOC-08): the one write
// service for documents. Node console routes only. Every change to the
// documents and document_versions tables outside the publish commit
// (lib/documents/commit.js) goes through here; a test scans the code for
// writes anywhere else.
//
//   createDocument({ type, meta, body, entityId, actor })
//   saveDraft({ id, revision, body, actor })
//   discardDraft({ id, revision, actor })       the draft goes back to the
//                                               published version
//   restoreVersion({ id, versionId, revision, actor })
//                                               an earlier version goes into
//                                               the DRAFT only, never live
//   archive({ id, revision, actor })            refused while live
//   saveVersion({ documentId, kind: "undo_saved", body?, actor, note })
//                                               internal, for Undo (PUB-04)
//   rewriteDraft({ id, revision, actor, note, rewrite })
//                                               P3-CHANGES: a server-side draft
//                                               rewrite (keepLiveSection) under
//                                               the saveDraft rules, with a
//                                               checkpoint of the old draft first
//   keepEarlierDraft({ id, body, actor })       P3-CHANGES: keeps a body as an
//                                               undo_saved version; the draft,
//                                               revision and hash never change
//   getDocument(id), listDocuments({ type, includeArchived }),
//   listHistory(id, { tenant })
//
// How a write works (spec 8.6 "Draft save", plan decision 1):
//   1. read the document once, refuse early when it is gone, archived or at
//      another revision;
//   2. validate in draft mode (lib/registry): structure and limits refuse with
//      a 422 and every issue, nothing stored; a missing title or text is an
//      "incomplete" issue that rides along with a 200 (DOC-05). The stored
//      body is the validator's: HTML sanitized, old sections upgraded;
//   3. ONE libsql.batch(…, "write"): the UPDATE guarded on id, revision and
//      archived_at, then the GEN-02 abort (an INSERT that breaks
//      cms_state's CHECK (id = 1) when the UPDATE changed nothing, so the
//      whole batch rolls back), then the checkpoint and its prune;
//   4. when the batch throws, look at the row once more:
//        our own write is there (the answer was lost and lib/db.js resent
//        it, or the network dropped it)  -> success
//        another revision, or archived    -> 409 with the current document
//        a slug another live page uses    -> 409 SLUG_TAKEN naming that page
//        anything else                    -> the error goes on to failure():
//                                            5xx with a code, never a 422
//
// Errors: ValidationError (422, lib/cms/issues.js), NotFoundError (404) and
// DocumentError (a deliberate 4xx with a code and plain words, plus `extra`
// such as the current document). Anything else is infrastructure.
import { libsql } from "../db.js";
import { documentType, validateDocument, ensureIds, documentHash, upgradeBody, emptyBody, SCHEMA_VERSION } from "../registry/index.js";
import { ValidationError, NotFoundError, issue } from "../cms/issues.js";
import { isDriverError, notMigratedYet } from "../schema-shape.js";
import { singletonId, newRouteId } from "./ids.js";
import { tenantId } from "../tenant-context.js";
import {
  versionRow,
  versionStatement,
  checkpointIfDueStatement,
  pruneStatement,
  listVersions,
  getVersion,
  namesFor,
  plainName,
  undoSavedBodies,
  keptCount,
  keptStatement,
  versionExists,
  KEPT_NOTE,
  KEPT_CAP,
} from "./versions.js";

export class DocumentError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "DocumentError";
    this.status = status;
    this.code = code;
    this.expose = true;
    this.extra = extra;
  }
}

// The GEN-02 abort: cms_state has CHECK (id = 1), so this INSERT fails, and
// the whole batch with it, exactly when the statement before it changed no row.
const ABORT = { sql: "INSERT INTO cms_state (id, mode, updated_at) SELECT 2, 'abort', 'abort' WHERE changes() = 0", args: [] };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const now = () => new Date().toISOString();
export const actorString = (actor) => (typeof actor === "string" ? actor : isObj(actor) && actor.kind ? `${actor.kind}:${actor.id ?? ""}` : null);

// ---- rows -------------------------------------------------------------------------

const DOC_COLS =
  "id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, published_version_id, published_hash, undone_version_id, archived_at, created_at, updated_at, updated_by";

// P3-CHANGES: who saved the row last ("<kind>:<id>", or null). Kept under a
// symbol, so it never rides along in a document answer (JSON and Object.keys
// skip it); only the stale 409's `current` names it, as updatedBy.
const UPDATED_BY = Symbol("updatedBy");

function fromRow(r) {
  const d = {
    id: String(r.id),
    type: String(r.type),
    slug: r.slug == null ? null : String(r.slug),
    entityId: r.entity_id == null ? null : String(r.entity_id),
    label: String(r.label),
    body: JSON.parse(String(r.draft)),
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
  Object.defineProperty(d, UPDATED_BY, { value: r.updated_by == null ? null : String(r.updated_by), enumerable: false });
  return d;
}

// What the console gets: no raw actor ids.
export function publicDocument(d) {
  if (!d) return null;
  return { ...d, live: d.publishedVersionId != null, unpublishedChanges: d.draftHash !== d.publishedHash };
}

async function readRow(id) {
  const r = await libsql.execute({ sql: `SELECT ${DOC_COLS} FROM documents WHERE id = ?`, args: [id] });
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

export async function getDocument(id) {
  const d = await readRow(String(id ?? ""));
  if (!d) throw new NotFoundError("This page no longer exists. It may have been deleted. Reload to see your pages.");
  return d;
}

export async function listDocuments({ type = null, includeArchived = false } = {}) {
  let r;
  try {
    r = await libsql.execute({
      sql:
        "SELECT id, type, slug, entity_id, label, revision, published_version_id, draft_hash, published_hash, archived_at, updated_at FROM documents " +
        `WHERE (? IS NULL OR type = ?) ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY type, label, id`,
      args: [type, type],
    });
  } catch (e) {
    // a store from before migration 0021 has no documents yet
    if (notMigratedYet(e, { table: "documents" })) return [];
    throw e;
  }
  return r.rows.map((d) => ({
    id: String(d.id),
    type: String(d.type),
    slug: d.slug == null ? null : String(d.slug),
    entityId: d.entity_id == null ? null : String(d.entity_id),
    label: String(d.label),
    revision: Number(d.revision),
    live: d.published_version_id != null,
    unpublishedChanges: d.draft_hash !== d.published_hash,
    archivedAt: d.archived_at == null ? null : String(d.archived_at),
    updatedAt: String(d.updated_at),
  }));
}

export async function listHistory(id, { tenant = null, limit } = {}) {
  const d = await getDocument(id);
  return listVersions(d.id, { tenant, publishedVersionId: d.publishedVersionId, limit });
}

// ---- refusals, in plain words -------------------------------------------------------

const nounOf = (type) => documentType(type)?.noun || "this page";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// P3-CHANGES (ED-03): the current document carries who saved it last.
// updatedBy is the raw "<kind>:<id>" for the editor only; updatedByName is
// the plain name lib/documents/versions.js plainName() gives ("Asha Rao",
// "Someone on your team", "Storeasy"), or "another tab" when it was this same
// person. The names cost one control-plane read, on this refusal only.
export const SAME_ACTOR_NAME = "another tab";
async function whoSaved(current, actor) {
  const by = current?.[UPDATED_BY] ?? null;
  const me = actorString(actor);
  if (by && me && by === me) return { updatedBy: by, updatedByName: SAME_ACTOR_NAME };
  const names = by && by.startsWith("merchant:") ? await namesFor(tenantId()) : new Map();
  return { updatedBy: by, updatedByName: plainName(by, names) };
}
async function stale(current, actor) {
  return new DocumentError(
    409,
    "DOCUMENT_CHANGED",
    `${cap(nounOf(current.type))} was changed somewhere else since you opened it, so nothing was saved. Your changes are still here: compare them with the current version, then save again.`,
    { current: { ...publicDocument(current), ...(await whoSaved(current, actor)) } },
  );
}
const archivedError = (current) =>
  new DocumentError(409, "DOCUMENT_ARCHIVED", `${cap(nounOf(current.type))} was archived, so nothing was saved. Reload to see your pages.`, { current: publicDocument(current) });

// 'Another page already uses /<slug>: <title>', naming the page found by a
// fresh read. That page can be gone again by then; the message still holds.
async function slugTaken(slug) {
  let other = null;
  try {
    const r = await libsql.execute({ sql: "SELECT id, label, draft FROM documents WHERE slug = ? AND archived_at IS NULL", args: [slug] });
    const row = r.rows[0];
    if (row) {
      let title = String(row.label);
      try {
        const t = JSON.parse(String(row.draft))?.meta?.title;
        if (typeof t === "string" && t.trim()) title = t.trim();
      } catch { /* the label still names it */ }
      other = { id: String(row.id), title };
    }
  } catch { /* the refusal stands without the name */ }
  const message = other ? `Another page already uses /${slug}: ${other.title}` : `Another page already uses /${slug}`;
  return new DocumentError(409, "SLUG_TAKEN", message, { slug, other });
}

// Which uniqueness rule of the documents table a driver error broke, if any.
function uniqueBroken(e) {
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 6; cur = cur.cause, depth++) {
    if (!isDriverError(cur)) continue;
    const m = String(cur.message ?? "");
    if (/UNIQUE constraint failed: documents\.slug\b/i.test(m)) return "slug";
    if (/UNIQUE constraint failed: documents\.type, documents\.entity_id\b/i.test(m)) return "entity";
    if (/(?:UNIQUE|PRIMARY KEY) constraint failed: documents\.id\b/i.test(m)) return "id";
  }
  return null;
}

// P2-DOCFIX: who may change the cart suggestions (upsells.write, or
// storefront.* like every other document) is an open owner ruling (plan
// section 3). Until it is made, no document write touches doc_cart: create,
// save, restore and discard all refuse with a 409 and plain words. The
// Upsells screen stays the way to change them.
export const CART_LOCKED_CODE = "CART_NOT_AVAILABLE";
function refuseCart(type) {
  if (type !== "cart") return;
  throw new DocumentError(409, CART_LOCKED_CODE, "Cart suggestions can't be changed here yet, so nothing was saved. Change them on the Upsells screen for now.");
}

// ---- the body ---------------------------------------------------------------------

const slugOf = (type, body) => (documentType(type)?.route && typeof body?.meta?.slug === "string" && body.meta.slug.trim() ? body.meta.slug : null);
function labelOf(type, body, entityId) {
  const t = documentType(type);
  if (t.route) {
    const title = body?.meta?.title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : t.label;
  }
  return entityId ? `${t.label}: ${entityId}` : t.label;
}

// Draft-mode validation. Refuses (422, nothing stored) on any error; returns
// the body to store, its hash and the issues that ride along (incomplete and
// warnings).
async function prepare(type, body, documentId) {
  if (!isObj(body)) {
    throw new ValidationError([issue({ documentId, field: null, code: "INVALID_SHAPE", message: "This document couldn't be read. Reload the page and try again." })]);
  }
  const input = body.type === undefined ? { ...body, type } : body;
  if (input.type !== type) {
    throw new ValidationError([issue({ documentId, field: "type", code: "TYPE_MISMATCH", message: `This content belongs to a different kind of document, so it can't be saved into ${nounOf(type)}. Reload the page and try again.` })]);
  }
  const r = validateDocument(ensureIds(input), { mode: "draft", documentId });
  if (!r.ok) throw new ValidationError(r.issues);
  return { body: r.body, hash: await documentHash(r.body), slug: slugOf(type, r.body), issues: r.issues };
}

// ---- after a batch threw -------------------------------------------------------------

// Look at the row once more and turn the failure into what really happened.
// `mine(row)` says whether the row already holds this very write.
async function settle(e, { id, revision, mine, slug, extra, actor = null }) {
  const which = uniqueBroken(e);
  // our own write first (P2-DOCFIX), then the slug clash, as in createDocument
  let cur;
  let unread = false;
  try {
    cur = await readRow(id);
  } catch {
    unread = true;
  }
  if (cur && mine(cur)) return cur;
  if (which === "slug" && slug) throw await slugTaken(slug);
  if (unread) throw e; // can't tell: report the original failure
  if (!cur) throw new NotFoundError("This page no longer exists. It may have been deleted. Reload to see your pages.");
  if (cur.archivedAt) throw archivedError(cur);
  if (cur.revision !== revision) throw await stale(cur, actor);
  if (extra) extra(cur);
  throw e;
}

// Read, and refuse early: gone, archived, or another revision.
async function current(id, revision, actor = null) {
  if (!Number.isInteger(revision)) throw new DocumentError(428, "REVISION_REQUIRED", "The editor didn't say which version you started from, so nothing was saved. Reload the page and try again.");
  const d = await getDocument(id);
  if (d.archivedAt) throw archivedError(d);
  if (d.revision !== revision) throw await stale(d, actor);
  return d;
}

// The guarded draft UPDATE, the abort, and the checkpoint statements.
function draftWrite(d, { body, hash, slug, by, at }) {
  return [
    {
      sql: "UPDATE documents SET draft = ?, draft_hash = ?, slug = ?, label = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ? AND archived_at IS NULL",
      args: [JSON.stringify(body), hash, slug, labelOf(d.type, body, d.entityId), at, by, d.id, d.revision],
    },
    ABORT,
  ];
}

const written = (d, { body, hash, slug, at }) => ({ ...d, body, draftHash: hash, slug, label: labelOf(d.type, body, d.entityId), revision: d.revision + 1, updatedAt: at });
const isMine = (d, at, hash) => (row) => row.revision === d.revision + 1 && row.updatedAt === at && row.draftHash === hash;

// ---- writes ------------------------------------------------------------------------

export async function createDocument({ type, meta, body, entityId = null, actor = null } = {}) {
  const t = documentType(type);
  if (!t) {
    throw new ValidationError([
      issue({ field: "type", code: "UNKNOWN_TYPE", message: `This is a kind of document the store doesn't know (${JSON.stringify(String(type ?? "")).slice(0, 62)}), so it can't be created.` }),
    ]);
  }
  if (!t.editable || t.system) {
    throw new ValidationError([issue({ field: "type", code: "NOT_EDITABLE", message: `${cap(t.noun)} is made by the store itself and can't be created by hand.` })]);
  }
  refuseCart(t.type);
  if (t.type === "product_content" && !(typeof entityId === "string" && entityId.trim())) {
    throw new ValidationError([issue({ field: "entityId", code: "REQUIRED", message: "Choose the product this content is for." })]);
  }
  const id = t.singleton ? singletonId(t.type) : newRouteId();
  let start = body === undefined || body === null ? emptyBody(t.type) : body;
  if (t.route && isObj(meta) && isObj(start)) start = { ...start, meta: { ...(isObj(start.meta) ? start.meta : emptyBody(t.type).meta), ...meta } };
  const p = await prepare(t.type, start, id);
  const at = now();
  const by = actorString(actor);
  const ent = t.type === "product_content" ? entityId.trim() : null;
  const label = labelOf(t.type, p.body, ent);
  const first = await versionRow({ documentId: id, kind: "checkpoint", body: p.body, schemaVersion: SCHEMA_VERSION, note: "Created", createdBy: by, createdAt: at });
  try {
    await libsql.batch(
      [
        {
          sql:
            "INSERT INTO documents (id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, created_at, updated_at, updated_by) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
          args: [id, t.type, p.slug, ent, label, JSON.stringify(p.body), p.hash, SCHEMA_VERSION, at, at, by],
        },
        versionStatement(first),
      ],
      "write",
    );
  } catch (e) {
    const which = uniqueBroken(e);
    // Read back first (P2-DOCFIX). When the batch committed but its answer was
    // lost, lib/db.js sends it again, and SQLite reports the slug clash with
    // our OWN new row before the primary-key clash. Mapping the slug error
    // first told the founder another page used the address: their own page.
    let cur = null;
    let unread = false;
    try {
      cur = await readRow(id);
    } catch {
      unread = true;
    }
    // a lost answer: the row we sent is there
    if (cur && cur.createdAt === at && cur.draftHash === p.hash) return { document: cur, issues: p.issues };
    if (which === "slug") throw await slugTaken(p.slug);
    if (unread) throw e;
    if (which === "id" || (cur && t.singleton)) {
      throw new DocumentError(409, "DOCUMENT_EXISTS", `${cap(t.noun)} already exists, so nothing new was made. Reload to open it.`, { current: publicDocument(cur) });
    }
    if (which === "entity") throw new DocumentError(409, "DOCUMENT_EXISTS", "This product already has its own content, so nothing new was made. Reload to open it.");
    throw e;
  }
  return {
    document: { id, type: t.type, slug: p.slug, entityId: ent, label, body: p.body, draftHash: p.hash, revision: 1, schemaVersion: SCHEMA_VERSION, publishedVersionId: null, publishedHash: null, undoneVersionId: null, archivedAt: null, createdAt: at, updatedAt: at },
    issues: p.issues,
  };
}

export async function saveDraft({ id, revision, body, actor = null } = {}) {
  const d = await current(id, revision, actor);
  refuseCart(d.type);
  const p = await prepare(d.type, body, d.id);
  const at = now();
  const by = actorString(actor);
  const cp = await versionRow({ documentId: d.id, kind: "checkpoint", body: p.body, schemaVersion: SCHEMA_VERSION, createdBy: by, createdAt: at });
  try {
    await libsql.batch([...draftWrite(d, { ...p, by, at }), checkpointIfDueStatement(cp), pruneStatement(d.id)], "write");
  } catch (e) {
    await settle(e, { id: d.id, revision: d.revision, mine: isMine(d, at, p.hash), slug: p.slug, actor });
  }
  return { document: written(d, { ...p, at }), issues: p.issues };
}

// Puts an earlier version into the draft, and only the draft: the live store
// and release_state are not touched. The draft it replaces is kept first as a
// checkpoint, so nothing typed is lost.
export async function restoreVersion({ id, versionId, revision, actor = null } = {}) {
  const d = await current(id, revision, actor);
  const v = await getVersion(d.id, String(versionId ?? ""));
  if (!v) throw new NotFoundError("That earlier version no longer exists. Reload to see the versions you can restore.");
  const p = await prepare(d.type, upgradeBody(v.body), d.id);
  return replaceDraft(d, p, { actor, note: "Before restoring an earlier version" });
}

// The draft goes back to what is live. The draft it replaces is kept as a
// checkpoint first (spec 8.14). Shoppers see no change.
export async function discardDraft({ id, revision, actor = null } = {}) {
  const d = await current(id, revision, actor);
  if (!d.publishedVersionId) {
    throw new DocumentError(409, "NOTHING_PUBLISHED", `${cap(nounOf(d.type))} has never been published, so there is no live version to go back to.`);
  }
  const v = await getVersion(d.id, d.publishedVersionId);
  if (!v) throw new NotFoundError("The live version of this page couldn't be found. Reload and try again.");
  const p = await prepare(d.type, upgradeBody(v.body), d.id);
  return replaceDraft(d, p, { actor, note: "Before going back to the live version" });
}

async function replaceDraft(d, p, { actor, note }) {
  refuseCart(d.type);
  const at = now();
  const by = actorString(actor);
  const kept = await versionRow({ documentId: d.id, kind: "checkpoint", body: d.body, schemaVersion: SCHEMA_VERSION, note, createdBy: by, createdAt: at });
  try {
    // the checkpoint first, so changes() after the UPDATE is the UPDATE's own
    await libsql.batch([versionStatement(kept), ...draftWrite(d, { ...p, by, at }), pruneStatement(d.id)], "write");
  } catch (e) {
    await settle(e, { id: d.id, revision: d.revision, mine: isMine(d, at, p.hash), slug: p.slug, actor });
  }
  return { document: written(d, { ...p, at }), issues: p.issues };
}

export async function archive({ id, revision, actor = null } = {}) {
  const d = await current(id, revision, actor);
  const t = documentType(d.type);
  if (t?.singleton) throw new DocumentError(409, "CANNOT_ARCHIVE", `${cap(t.noun)} is part of every store, so it can't be archived.`);
  const live = () => new DocumentError(409, "DOCUMENT_LIVE", `${cap(nounOf(d.type))} is live. Take it offline first, then archive it.`);
  if (d.publishedVersionId) throw live();
  const at = now();
  const by = actorString(actor);
  try {
    await libsql.batch(
      [
        {
          sql: "UPDATE documents SET archived_at = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ? AND archived_at IS NULL AND published_version_id IS NULL",
          args: [at, at, by, d.id, d.revision],
        },
        ABORT,
      ],
      "write",
    );
  } catch (e) {
    const mine = (row) => row.archivedAt === at && row.revision === d.revision + 1;
    let cur;
    try {
      cur = await readRow(d.id);
    } catch {
      throw e;
    }
    if (cur && mine(cur)) return { document: cur };
    if (cur && !cur.archivedAt && cur.revision === d.revision && cur.publishedVersionId) throw live();
    await settle(e, { id: d.id, revision: d.revision, mine, actor });
  }
  return { document: { ...d, archivedAt: at, revision: d.revision + 1, updatedAt: at } };
}

// Internal, for Undo (PUB-04): keeps the current draft (or `body`) as a
// version the checkpoint cap never prunes. Returns the version id.
export async function saveVersion({ documentId, kind = "undo_saved", body, actor = null, note = null } = {}) {
  if (kind !== "undo_saved") throw new Error(`saveVersion: only undo_saved versions are written here, not "${kind}"`);
  const d = await getDocument(documentId);
  const row = await versionRow({ documentId: d.id, kind, body: body === undefined ? d.body : body, schemaVersion: SCHEMA_VERSION, note, createdBy: actorString(actor), createdAt: now() });
  await libsql.execute(versionStatement(row));
  return { id: row.id };
}

// P3-CHANGES (PUB-09): a draft rewrite the server makes (keepLiveSection),
// under the saveDraft rules: the revision check (428, 409 with current), the
// archived refusal, the cart lock, draft-mode validation (422, nothing
// stored) and the guarded batch. `rewrite(d)` gets the current document and
// returns the new body. The draft it replaces is kept as a checkpoint first,
// in the same batch, as restoreVersion and discardDraft do.
export async function rewriteDraft({ id, revision, actor = null, note, rewrite } = {}) {
  const d = await current(id, revision, actor);
  refuseCart(d.type);
  const next = await rewrite(d);
  const p = await prepare(d.type, next, d.id);
  return replaceDraft(d, p, { actor, note });
}

const tooManyKept = () => new DocumentError(409, "TOO_MANY_KEPT", `There are already ${KEPT_CAP} kept drafts for this page. Open Earlier versions to tidy them.`);

// The undo_saved version of this document whose body has this documentHash.
async function keptLike(documentId, hash) {
  for (const v of await undoSavedBodies(documentId)) {
    let h = null;
    try {
      h = await documentHash(v.body);
    } catch { /* a body that can't be hashed matches nothing */ }
    if (h === hash) return { id: v.id, note: v.note };
  }
  return null;
}

// P3-CHANGES (ED-03): keeps `body` (another tab's draft) as an undo_saved
// version noted KEPT_NOTE, which the checkpoint prune never removes. The
// draft, revision and hash never change, so no revision is asked for.
//   - validated in draft mode and sanitized like a save (422 on structure);
//   - a body equal (documentHash) to an undo_saved version already kept for
//     this document gives that version back, nothing new stored;
//   - at KEPT_CAP kept drafts: 409 TOO_MANY_KEPT, nothing stored.
// Returns { savedVersion: { id, note }, stored }.
export async function keepEarlierDraft({ id, body, actor = null } = {}) {
  const d = await getDocument(String(id ?? ""));
  refuseCart(d.type);
  const p = await prepare(d.type, body, d.id);
  const same = await keptLike(d.id, p.hash);
  if (same) return { savedVersion: same, stored: false };
  if ((await keptCount(d.id)) >= KEPT_CAP) throw tooManyKept();
  const row = await versionRow({ documentId: d.id, kind: "undo_saved", body: p.body, schemaVersion: SCHEMA_VERSION, note: KEPT_NOTE, createdBy: actorString(actor), createdAt: now() });
  let added = 0;
  let failedWith = null;
  try {
    added = (await libsql.execute(keptStatement(row))).rowsAffected;
  } catch (e) {
    failedWith = e;
  }
  if (added === 1) return { savedVersion: { id: row.id, note: KEPT_NOTE }, stored: true };
  // nothing was added, or the answer was lost: look once more
  const mine = await versionExists(d.id, row.id).catch(() => null);
  if (mine) return { savedVersion: mine, stored: true };
  if (failedWith) throw failedWith;
  const now2 = await keptLike(d.id, p.hash);
  if (now2) return { savedVersion: now2, stored: false };
  if ((await keptCount(d.id)) >= KEPT_CAP) throw tooManyKept();
  // Not reachable in practice: a body blocked by the body_hash term has the
  // same documentHash, so keptLike finds it. An infrastructure error, not the
  // founder's (failure() makes it a 5xx).
  throw new Error("keepEarlierDraft: the kept draft was not stored and no reason was found");
}
