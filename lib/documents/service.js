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
// P4-MEDIA (MED-03, plan decision 6): every version this service writes is
// indexed in document_refs (migration 0023) in the same batch as the version
// row: the first checkpoint of createDocument, the checkpoint a save adds when
// one is due, the checkpoint kept before a restore, a discard or a rewrite,
// and the undo_saved versions of saveVersion and keepEarlierDraft. A version
// row that is written only when a condition holds (checkpointIfDueStatement,
// keptStatement) gets its refs through a conditional INSERT … SELECT … WHERE
// EXISTS (that version row), so a checkpoint that wasn't due leaves no refs.
// Always ON CONFLICT DO NOTHING on the table's key, never INSERT OR IGNORE
// (commit.js). A store without 0023 writes no refs (hasRefsTable, the probe
// publish uses too). Refs of a checkpoint the prune later deletes stay in the
// table but never count: usage joins document_versions (lib/media.js).
//
// P4-LIVEROW (OVL-01, OVL-02, OVL-04, OVL-07, ED-12): product and collection
// content are real documents.
//   - createDocument gives them their deterministic ids (productDocumentId,
//     collectionDocumentId) and the product's or collection's name as label;
//     the label of these documents is kept on every save.
//   - openEntityContent({ type, entityId }) finds the document of a product or
//     collection (a phase-3 random-id row too), makes one, or brings an
//     archived one back while the entity is in Shopify. It answers with the
//     title gate (titleEditable, titleBlockedReason) and shopifyAdminUrl.
//   - The overlay rules (normalizeOverlays), enforced here, not in the editor:
//     null follows Shopify ("Reset", "Use Shopify's"); a value equal to what
//     Shopify sends now is stored as null; a new value takes its base
//     (base_hash, base_value) from what Shopify sends now, and later edits
//     keep that base. resolveShopifyChange re-bases ('keep') or follows
//     Shopify again ('shopify'), in the draft only.
//   - A field Shopify owns (price, handle, tags, …) is refused: 422
//     SHOPIFY_OWNED. An empty name is refused (422).
//   - The title gate (lib/catalog/title-gate.js): while it is closed, a save
//     that sets a new name, display_type or display_vendor is refused with
//     its words; clearing one never is.
//   - Deleting a product in Shopify never archives its document: whether it
//     is "no longer in Shopify" is read live from products.
//     discardOrphanEdits removes the live row and the edits of a product that
//     is gone, in one guarded batch.
//   - The cart ruling (plan OQ-6 default): doc_cart is an ordinary document
//     now (storefront.write to save, storefront.publish to publish);
//     refuseCart is gone.
//
// Errors: ValidationError (422, lib/cms/issues.js), NotFoundError (404) and
// DocumentError (a deliberate 4xx with a code and plain words, plus `extra`
// such as the current document). Anything else is infrastructure.
import { libsql } from "../db.js";
import { documentType, validateDocument, ensureIds, documentHash, upgradeBody, emptyBody, stableStringify, SCHEMA_VERSION } from "../registry/index.js";
import { OVERLAY_FIELDS, isLiveRowType, productModuleNotes } from "../registry/document-types.js";
import { ValidationError, NotFoundError, issue } from "../cms/issues.js";
import { isDriverError, notMigratedYet } from "../schema-shape.js";
import { singletonId, newRouteId, productDocumentId, collectionDocumentId, logId, setId as newSetId } from "./ids.js";
import { refRows } from "./refs.js";
import { tenantId } from "../tenant-context.js";
import { documentsGuardStatement, classifyAbort, MIGRATING_MESSAGE } from "../cms-mode.js";
import { sha256Hex } from "../releases.js";
import { titleGate, GATED_FIELDS, TITLE_GATE_MESSAGE } from "../catalog/title-gate.js";
import { sanitize } from "../registry/text.js";
import { shopifyAdminUrl } from "../admin/shopify-admin-url.js";
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
  BACKUP_NOTE,
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

// ---- migration 0023: the reference index (P4-MEDIA) -------------------------------

// Tenants whose document_refs table was seen, in this isolate. Only a yes is
// remembered: a missing table is asked again on the next call, so a store
// migrated while the instance is warm starts writing refs at once. One
// statement per call until 0023 has run, none after. (Moved here from
// build.js, which re-exports it, so saves and publishes share it.)
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

const REF_CHUNK = 200;
// The refs of one version, each chunk written only when that version row
// exists by then in the same batch. VALUES columns are column1..3.
export function versionRefsStatements(versionId, body) {
  const rows = refRows(versionId, body);
  const out = [];
  for (let i = 0; i < rows.length; i += REF_CHUNK) {
    const chunk = rows.slice(i, i + REF_CHUNK);
    out.push({
      sql:
        `INSERT INTO document_refs (version_id, ref_type, ref_id) SELECT column1, column2, column3 FROM (VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}) ` +
        "WHERE EXISTS (SELECT 1 FROM document_versions WHERE id = ?) ON CONFLICT DO NOTHING",
      args: [...chunk.flatMap((r) => [r.version_id, r.ref_type, r.ref_id]), versionId],
    });
  }
  return out;
}
const refsFor = async (versionId, body) => ((await hasRefsTable()) ? versionRefsStatements(versionId, body) : []);

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

// P4-LIVEROW (plan OQ-6, the default ruling): doc_cart is saved with
// storefront.write and published with storefront.publish like every other
// document (lib/registry/editability.js cartEditable() is true). The old
// CART_NOT_AVAILABLE refusal is gone.

// ---- the body ---------------------------------------------------------------------

const slugOf = (type, body) => (documentType(type)?.route && typeof body?.meta?.slug === "string" && body.meta.slug.trim() ? body.meta.slug : null);
// P4-LIVEROW: product and collection content keep the label they were made
// with (the product's or collection's name), never a Shopify id.
function labelOf(type, body, entityId, current = null) {
  const t = documentType(type);
  if (t.route) {
    const title = body?.meta?.title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : t.label;
  }
  if (isLiveRowType(type)) return typeof current === "string" && current ? current : t.label;
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
  if (!r.ok) {
    // P4-LIVEROW: a field Shopify owns is its own refusal (422 SHOPIFY_OWNED)
    const owned = r.issues.filter((i) => i.code === "SHOPIFY_OWNED");
    if (owned.length) throw new DocumentError(422, "SHOPIFY_OWNED", owned[0].message, { issues: r.issues });
    throw new ValidationError(r.issues);
  }
  return { body: r.body, hash: await documentHash(r.body), slug: slugOf(type, r.body), issues: [...r.issues, ...notesOf(r.body, documentId)] };
}

// P4-LIVEROW: the inherited notes of product modules (an image-with-text
// module, more than 6 modules, a module beyond today's length), as warnings
// that ride along with a save.
function notesOf(body, documentId) {
  return productModuleNotes(body).map((n) => issue({ documentId, sectionId: n.sectionId ?? null, field: n.field ?? null, code: n.code, severity: "warning", message: n.message }));
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
      args: [JSON.stringify(body), hash, slug, labelOf(d.type, body, d.entityId, d.label), at, by, d.id, d.revision],
    },
    ABORT,
  ];
}

const written = (d, { body, hash, slug, at }) => ({ ...d, body, draftHash: hash, slug, label: labelOf(d.type, body, d.entityId, d.label), revision: d.revision + 1, updatedAt: at });
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
  const entity = isLiveRowType(t.type);
  if (entity && !(typeof entityId === "string" && entityId.trim())) {
    throw new ValidationError([issue({ field: "entityId", code: "REQUIRED", message: t.type === "collection_content" ? "Choose the collection this content is for." : "Choose the product this content is for." })]);
  }
  const ent = entity ? entityId.trim() : null;
  // P4-LIVEROW: deterministic ids, so the cutover's backfill and the editor agree
  const id = t.singleton ? singletonId(t.type) : t.type === "product_content" ? await productDocumentId(ent) : t.type === "collection_content" ? await collectionDocumentId(ent) : newRouteId();
  let start = body === undefined || body === null ? emptyBody(t.type) : body;
  if (t.route && isObj(meta) && isObj(start)) start = { ...start, meta: { ...(isObj(start.meta) ? start.meta : emptyBody(t.type).meta), ...meta } };
  let shop = null;
  if (t.type === "product_content") {
    shop = await rawProduct(ent);
    start = await normalizeOverlays(t.type, start, null, shop);
    gateNewNames(start, null);
  } else if (t.type === "collection_content") shop = await rawCollection(ent);
  const p = await prepare(t.type, start, id);
  const at = now();
  const by = actorString(actor);
  const label = entity ? (shop?.title ? String(shop.title).slice(0, 120) : t.label) : labelOf(t.type, p.body, ent);
  const first = await versionRow({ documentId: id, kind: "checkpoint", body: p.body, schemaVersion: SCHEMA_VERSION, note: "Created", createdBy: by, createdAt: at });
  const firstRefs = await refsFor(first.id, p.body);
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
        ...firstRefs,
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
  let next = body;
  if (d.type === "product_content") {
    next = await normalizeOverlays(d.type, body, d.body, await rawProduct(d.entityId));
    gateNewNames(next, d.body);
  }
  const p = await prepare(d.type, next, d.id);
  const at = now();
  const by = actorString(actor);
  const cp = await versionRow({ documentId: d.id, kind: "checkpoint", body: p.body, schemaVersion: SCHEMA_VERSION, createdBy: by, createdAt: at });
  const cpRefs = await refsFor(cp.id, p.body);
  try {
    // the refs only when the checkpoint was due (WHERE EXISTS the row), and
    // before the prune, which may later remove it (its refs then never count)
    await libsql.batch([...draftWrite(d, { ...p, by, at }), checkpointIfDueStatement(cp), ...cpRefs, pruneStatement(d.id)], "write");
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
  if (d.type === "product_content") gateNewNames(p.body, d.body);
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
  const at = now();
  const by = actorString(actor);
  const kept = await versionRow({ documentId: d.id, kind: "checkpoint", body: d.body, schemaVersion: SCHEMA_VERSION, note, createdBy: by, createdAt: at });
  const keptRefs = await refsFor(kept.id, d.body);
  try {
    // the checkpoint first, so changes() after the UPDATE is the UPDATE's own;
    // its refs after the abort, which reads changes() of the UPDATE
    await libsql.batch([versionStatement(kept), ...draftWrite(d, { ...p, by, at }), ...keptRefs, pruneStatement(d.id)], "write");
  } catch (e) {
    await settle(e, { id: d.id, revision: d.revision, mine: isMine(d, at, p.hash), slug: p.slug, actor });
  }
  return { document: written(d, { ...p, at }), issues: p.issues };
}

export async function archive({ id, revision, actor = null } = {}) {
  const d = await current(id, revision, actor);
  const t = documentType(d.type);
  if (t?.singleton) throw new DocumentError(409, "CANNOT_ARCHIVE", `${cap(t.noun)} is part of every store, so it can't be archived.`);
  const live = () =>
    isLiveRowType(d.type)
      ? new DocumentError(409, "DOCUMENT_LIVE", `${cap(nounOf(d.type))} is live, so it can't be archived. To go back to what Shopify sends, choose Use Shopify's on each field and publish.`)
      : new DocumentError(409, "DOCUMENT_LIVE", `${cap(nounOf(d.type))} is live. Take it offline first, then archive it.`);
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
  const kept = body === undefined ? d.body : body;
  const row = await versionRow({ documentId: d.id, kind, body: kept, schemaVersion: SCHEMA_VERSION, note, createdBy: actorString(actor), createdAt: now() });
  const refs = await refsFor(row.id, kept);
  if (refs.length) await libsql.batch([versionStatement(row), ...refs], "write");
  else await libsql.execute(versionStatement(row));
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
//   - at KEPT_CAP kept drafts: 409 TOO_MANY_KEPT, nothing stored;
//   - an archived document: 409 DOCUMENT_ARCHIVED (P3-FIX2), with nothing
//     stored. (The cart's old refusal is gone: P4-LIVEROW.)
// P3-FIX5: from "backup" (the editor's local backup offer) notes it
// BACKUP_NOTE, "Edits this browser kept", never "Kept from another tab".
// Returns { savedVersion: { id, note }, stored }.
export async function keepEarlierDraft({ id, body, actor = null, from = null } = {}) {
  const note = from === "backup" ? BACKUP_NOTE : KEPT_NOTE;
  const d = await getDocument(String(id ?? ""));
  // P3-FIX2: an archived page is refused, as saveDraft refuses it
  if (d.archivedAt) throw archivedError(d);
  const p = await prepare(d.type, body, d.id);
  const same = await keptLike(d.id, p.hash);
  if (same) return { savedVersion: same, stored: false };
  if ((await keptCount(d.id)) >= KEPT_CAP) throw tooManyKept();
  const row = await versionRow({ documentId: d.id, kind: "undo_saved", body: p.body, schemaVersion: SCHEMA_VERSION, note, createdBy: actorString(actor), createdAt: now() });
  const refs = await refsFor(row.id, p.body);
  let added = 0;
  let failedWith = null;
  try {
    // P4-MEDIA: the refs go only with a row keptStatement really stored
    added = refs.length ? (await libsql.batch([keptStatement(row), ...refs], "write"))[0].rowsAffected : (await libsql.execute(keptStatement(row))).rowsAffected;
  } catch (e) {
    failedWith = e;
  }
  if (added === 1) return { savedVersion: { id: row.id, note }, stored: true };
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

// ---- P4-LIVEROW: product and collection content ---------------------------------------

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[A-Za-z0-9_-]{1,64}$/;
const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/[A-Za-z0-9_-]{1,64}$/;

// What Shopify sends now for a product, from the synced catalog, or null when
// the product is not there (deleted in Shopify, or never synced). Two reads.
export async function rawProduct(productId) {
  if (typeof productId !== "string" || !productId) return null;
  const r = await libsql.execute({ sql: "SELECT id, handle, title, description_html, vendor, product_type FROM products WHERE id = ?", args: [productId] });
  const row = r.rows[0];
  if (!row) return null;
  const imgs = await libsql.execute({ sql: "SELECT url, alt FROM product_images WHERE product_id = ? ORDER BY position, id", args: [productId] });
  const str = (v) => (v == null ? null : String(v));
  return {
    id: String(row.id),
    handle: str(row.handle),
    title: str(row.title),
    description_html: str(row.description_html),
    vendor: str(row.vendor),
    product_type: str(row.product_type),
    images: imgs.rows.map((x) => ({ url: String(x.url), alt: str(x.alt) })),
  };
}

export async function rawCollection(collectionId) {
  if (typeof collectionId !== "string" || !collectionId) return null;
  const r = await libsql.execute({ sql: "SELECT id, handle, title FROM collections WHERE id = ?", args: [collectionId] });
  const row = r.rows[0];
  return row ? { id: String(row.id), handle: String(row.handle), title: String(row.title) } : null;
}

// Shopify's value of an overlay field, in the overlay's own shape.
export function rawValueOf(field, raw) {
  if (!raw) return null;
  switch (field) {
    case "title":
      return raw.title;
    case "description_html":
      return raw.description_html;
    case "display_vendor":
      return raw.vendor;
    case "display_type":
      return raw.product_type;
    case "gallery":
      return raw.images.map((i) => ({ media: i.url, alt: i.alt }));
    default:
      return null;
  }
}

// Image addresses are compared without their query string (a CDN size or
// version parameter is the same image); a missing alt equals an empty one.
const stripQuery = (u) => (typeof u === "string" ? u.replace(/[?#].*$/, "") : u);
function comparable(field, value) {
  if (field === "gallery") return Array.isArray(value) ? value.map((g) => (isObj(g) ? { media: stripQuery(g.media), alt: g.alt == null ? "" : g.alt } : g)) : value;
  return value;
}
export async function overlayBaseHash(field, value) {
  return sha256Hex(stableStringify({ v: comparable(field, value) ?? null }));
}
const sameValue = (field, a, b) => stableStringify({ v: comparable(field, a) ?? null }) === stableStringify({ v: comparable(field, b) ?? null });
// P4-SEARCH (P4-LIVEROW review): the description the founder saves is stored
// cleaned (prepare() sanitizes rich text), and an editor sends it back cleaned
// too. So a description equal to Shopify's once both are cleaned the same way
// follows Shopify: compared raw first, then both through the registry's
// sanitizer (lib/registry/text.js sanitize, what prepare() uses).
function sameAsShopify(field, value, rawValue) {
  if (sameValue(field, value, rawValue)) return true;
  if (field !== "description_html" || typeof value !== "string" || typeof rawValue !== "string") return false;
  return sanitize(value) === sanitize(rawValue);
}
const overlayValue = (v) => (isObj(v) && v.value !== undefined ? v.value : null);
const OVERLAY_KEYS = ["value", "base_hash", "base_value"];

// The overlay rules (OVL-04, R4). `prior` is the draft before this write (null
// for a new document), `raw` what Shopify sends now (null when the product is
// gone: then a value is kept with the base it had, or none).
export async function normalizeOverlays(type, body, prior, raw) {
  const fields = OVERLAY_FIELDS[type] || [];
  if (!fields.length || !isObj(body) || !isObj(body.settings)) return body;
  const settings = { ...body.settings };
  for (const f of fields) {
    if (!Object.hasOwn(settings, f)) continue;
    let x = settings[f];
    if (x == null) {
      settings[f] = null;
      continue;
    }
    if (!isObj(x)) x = { value: x };
    // anything else in it is left for the validator to refuse
    else if (Object.keys(x).some((k) => !OVERLAY_KEYS.includes(k))) continue;
    if (x.value == null) {
      settings[f] = null;
      continue;
    }
    if (raw && sameAsShopify(f, x.value, rawValueOf(f, raw))) {
      settings[f] = null;
      continue;
    }
    const before = isObj(prior?.settings) ? prior.settings[f] : null;
    if (isObj(before) && typeof before.base_hash === "string") settings[f] = { value: x.value, base_hash: before.base_hash, base_value: before.base_value ?? null };
    else if (raw) {
      const bv = rawValueOf(f, raw);
      settings[f] = { value: x.value, base_hash: await overlayBaseHash(f, bv), base_value: bv };
    } else settings[f] = { value: x.value, base_hash: null, base_value: null };
  }
  return { ...body, settings };
}

// The title gate at save: a NEW name (one the draft didn't hold) is refused
// while the gate is closed; clearing one never is.
function gateNewNames(next, prior) {
  const gate = titleGate();
  if (!gate.blocked) return;
  const nextS = isObj(next?.settings) ? next.settings : {};
  const priorS = isObj(prior?.settings) ? prior.settings : {};
  for (const f of GATED_FIELDS) {
    const v = overlayValue(nextS[f]);
    if (v == null) continue;
    if (stableStringify({ v }) === stableStringify({ v: overlayValue(priorS[f]) })) continue;
    throw new DocumentError(409, "TITLE_NOT_EDITABLE", gate.reason || TITLE_GATE_MESSAGE, { field: f });
  }
}

export const TITLE_BLOCKED_REASON = TITLE_GATE_MESSAGE;

async function readByEntity(type, entityId) {
  const r = await libsql.execute({ sql: `SELECT ${DOC_COLS} FROM documents WHERE type = ? AND entity_id = ?`, args: [type, entityId] });
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

// What the editor needs beside the document: the gate, the admin link and
// what Shopify sends now (null when the entity is gone).
function entityAnswer(type, entityId, doc, shop, extra = {}) {
  const gate = type === "product_content" ? titleGate() : { blocked: false, reason: null };
  return {
    document: publicDocument(doc),
    ...extra,
    inShopify: shop != null,
    shopify:
      shop == null
        ? null
        : type === "product_content"
          ? { title: shop.title, handle: shop.handle, description_html: shop.description_html, vendor: shop.vendor, product_type: shop.product_type, gallery: rawValueOf("gallery", shop) }
          : { title: shop.title, handle: shop.handle },
    titleEditable: !gate.blocked,
    titleBlockedReason: gate.blocked ? gate.reason || TITLE_GATE_MESSAGE : null,
    shopifyAdminUrl: shopifyAdminUrl(type === "product_content" ? { product: entityId } : { collection: entityId }),
  };
}

// openEntityContent({ type, entityId, actor })
//   -> { document, created, unarchived, inShopify, shopify, titleEditable,
//        titleBlockedReason, shopifyAdminUrl }
// The row found by (type, entity_id), a phase-3 random-id row included; else a
// new one (createDocument, deterministic id). An archived row is brought back
// (archived_at null, revision + 1) when the product or collection is in
// Shopify; a row of an entity that is gone is answered as it is.
export async function openEntityContent({ type, entityId, actor = null } = {}) {
  if (!isLiveRowType(type)) throw new DocumentError(400, "MALFORMED", "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.");
  const ent = typeof entityId === "string" ? entityId.trim() : "";
  if (!(type === "product_content" ? PRODUCT_GID : COLLECTION_GID).test(ent)) {
    throw new DocumentError(400, "MALFORMED", type === "product_content" ? "That product couldn't be found. Choose it again." : "That collection couldn't be found. Choose it again.");
  }
  const shop = type === "product_content" ? await rawProduct(ent) : await rawCollection(ent);
  let doc = await readByEntity(type, ent);
  if (doc?.archivedAt && shop) {
    const at = now();
    const exists = type === "product_content" ? "SELECT 1 FROM products WHERE id = ?" : "SELECT 1 FROM collections WHERE id = ?";
    // archive is otherwise terminal: only a product or collection that is in
    // Shopify again brings its own content back (P4-LIVEROW). P4-SEARCH
    // (LIVEROW review): the store's mode is checked inside the same batch, so
    // a store that leaves documents mode meanwhile changes nothing.
    if (openEntityHooks.beforeUnarchive) await openEntityHooks.beforeUnarchive({ document: doc });
    try {
      await libsql.batch(
        [
          documentsGuardStatement(),
          {
            sql: `UPDATE documents SET archived_at = NULL, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ? AND archived_at IS NOT NULL AND EXISTS (${exists})`,
            args: [at, actorString(actor), doc.id, ent],
          },
        ],
        "write",
      );
    } catch (e) {
      let c = null;
      try {
        c = await classifyAbort(libsql, e, "documents");
      } catch {
        throw e;
      }
      if (c?.kind === "mode") throw c.mode === "migrating" ? new DocumentError(409, "STORE_MIGRATING", MIGRATING_MESSAGE) : new DocumentError(409, "STORE_USES_LEGACY", "This store still uses the current Storefront editor, so nothing changed here.");
      throw e;
    }
    doc = await readByEntity(type, ent);
    return entityAnswer(type, ent, doc, shop, { created: false, unarchived: !doc.archivedAt });
  }
  if (doc) return entityAnswer(type, ent, doc, shop, { created: false, unarchived: false });
  if (!shop) {
    throw new NotFoundError(type === "product_content" ? "This product isn't in your Shopify catalog, so there is no content to open. Reload the product list." : "This collection isn't in your Shopify catalog, so there is no content to open. Reload the collection list.");
  }
  try {
    const r = await createDocument({ type, entityId: ent, actor });
    return entityAnswer(type, ent, r.document, shop, { created: true, unarchived: false });
  } catch (e) {
    // two tabs opened it at once: the other one made it
    if (e instanceof DocumentError && e.code === "DOCUMENT_EXISTS") {
      const again = await readByEntity(type, ent);
      if (again) return entityAnswer(type, ent, again, shop, { created: false, unarchived: false });
    }
    throw e;
  }
}

export const RESOLVE_CHOICES = Object.freeze(["keep", "shopify"]);

// resolveShopifyChange({ id, revision, field, choice, actor }): the founder's
// answer to "Changed in Shopify", in the DRAFT only (a checkpoint of the old
// draft first, the saveDraft rules):
//   'keep'     keeps the founder's value and re-bases it on what Shopify
//              sends now (base_hash, base_value)
//   'shopify'  follows Shopify again (the field is null)
// The published version and the live row are not touched.
export async function resolveShopifyChange({ id, revision, field, choice, actor = null } = {}) {
  const d = await current(id, revision, actor);
  if (d.type !== "product_content") throw new DocumentError(409, "NOT_PRODUCT_CONTENT", "Only a product's content follows Shopify, so there is nothing to decide here.");
  if (!OVERLAY_FIELDS.product_content.includes(field)) throw new DocumentError(400, "MALFORMED", "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.");
  if (!RESOLVE_CHOICES.includes(choice)) throw new DocumentError(400, "MALFORMED", "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.");
  const settings = isObj(d.body?.settings) ? d.body.settings : {};
  const cur = settings[field] ?? null;
  let next;
  if (choice === "shopify") {
    if (cur == null) return { document: d, issues: [], unchanged: true };
    next = null;
  } else {
    if (cur == null) return { document: d, issues: [], unchanged: true };
    const raw = await rawProduct(d.entityId);
    if (!raw) throw new DocumentError(409, "PRODUCT_NOT_IN_SHOPIFY", "This product is no longer in Shopify, so there is nothing to compare your version with. Your version is kept.");
    const bv = rawValueOf(field, raw);
    next = { value: overlayValue(cur), base_hash: await overlayBaseHash(field, bv), base_value: bv };
  }
  const p = await prepare(d.type, { ...d.body, settings: { ...settings, [field]: next } }, d.id);
  return replaceDraft(d, p, { actor, note: choice === "keep" ? "Before keeping your version over Shopify's change" : "Before following Shopify again" });
}

export const DISCARD_NOTE = "Before discarding the edits of a product that left Shopify";

// discardOrphanEdits({ id, revision, actor }) (storefront.publish): the edits
// of a product that is no longer in Shopify go, in ONE guarded batch:
//   [documentsGuardStatement, the orphan guard (aborts when the product is in
//    products again), DELETE the live row WHERE NOT EXISTS the product, the
//    search_outbox row (only when a live row went), a checkpoint of the old
//    draft, the draft reset (revision + 1, nothing published), its abort, a
//    'discard' publish_log row]
// so a webhook that brings the product back between the check and the batch
// keeps the edits. Returns { document, removedLive }.
export async function discardOrphanEdits({ id, revision, actor = null } = {}) {
  const d = await current(id, revision, actor);
  if (d.type !== "product_content") throw new DocumentError(409, "NOT_PRODUCT_CONTENT", "Only a product's content can be discarded this way.");
  const inShopify = () => new DocumentError(409, "PRODUCT_IN_SHOPIFY", "This product is in Shopify, so its edits stay. To go back to what Shopify sends, choose Use Shopify's on each field and publish.");
  if (await rawProduct(d.entityId)) throw inShopify();
  const at = now();
  const by = actorString(actor);
  const fresh = await prepare(d.type, emptyBody(d.type), d.id);
  const kept = await versionRow({ documentId: d.id, kind: "checkpoint", body: d.body, schemaVersion: SCHEMA_VERSION, note: DISCARD_NOTE, createdBy: by, createdAt: at });
  const keptRefs = await refsFor(kept.id, d.body);
  const live = await libsql.execute({ sql: "SELECT 1 AS x FROM product_content_live WHERE product_id = ?", args: [d.entityId] }).catch(() => ({ rows: [] }));
  const log = { id: logId(), set_id: newSetId() };
  const stmts = [
    documentsGuardStatement(),
    { sql: "INSERT INTO cms_state (id, mode, cutover_release_id, updated_at) SELECT 2, 'guard', NULL, '' WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)", args: [d.entityId] },
    { sql: "DELETE FROM product_content_live WHERE product_id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE id = ?)", args: [d.entityId, d.entityId] },
    {
      sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) SELECT ?, (SELECT handle FROM products WHERE id = ?), 'discard', ?, NULL WHERE changes() > 0",
      args: [d.entityId, d.entityId, at],
    },
    versionStatement(kept),
    {
      sql: "UPDATE documents SET draft = ?, draft_hash = ?, slug = NULL, label = ?, revision = revision + 1, updated_at = ?, updated_by = ?, published_version_id = NULL, published_hash = NULL WHERE id = ? AND revision = ? AND archived_at IS NULL",
      args: [JSON.stringify(fresh.body), fresh.hash, d.label, at, by, d.id, d.revision],
    },
    ABORT,
    ...keptRefs,
    {
      sql: "INSERT INTO publish_log (id, set_id, document_id, action, from_version_id, to_version_id, release_id, undoes_log_id, saved_version_id, actor, note, created_at) VALUES (?, ?, ?, 'discard', ?, NULL, NULL, NULL, ?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING",
      args: [log.id, log.set_id, d.id, d.publishedVersionId, kept.id, by, at],
    },
  ];
  if (discardHooks.beforeBatch) await discardHooks.beforeBatch({ document: d });
  try {
    await libsql.batch(stmts, "write");
  } catch (e) {
    // our own write, with its answer lost
    let cur = null;
    try {
      cur = await readRow(d.id);
    } catch {
      throw e;
    }
    if (cur && cur.revision === d.revision + 1 && cur.updatedAt === at && cur.draftHash === fresh.hash) return { document: cur, removedLive: live.rows.length > 0 };
    let c = null;
    try {
      c = await classifyAbort(libsql, e, "documents");
    } catch {
      throw e;
    }
    if (c?.kind === "mode") throw c.mode === "migrating" ? new DocumentError(409, "STORE_MIGRATING", MIGRATING_MESSAGE) : new DocumentError(409, "STORE_USES_LEGACY", "This store still uses the current Storefront editor, so nothing changed here.");
    if (await rawProduct(d.entityId)) throw inShopify();
    await settle(e, { id: d.id, revision: d.revision, mine: (row) => row.revision === d.revision + 1 && row.updatedAt === at, actor });
  }
  return { document: { ...d, body: fresh.body, draftHash: fresh.hash, slug: null, revision: d.revision + 1, updatedAt: at, publishedVersionId: null, publishedHash: null }, removedLive: live.rows.length > 0 };
}

// Tests only: beforeBatch({ document }) runs after discardOrphanEdits' checks
// and right before its batch (a webhook bringing the product back, a mode
// change). Never set in production.
export const discardHooks = { beforeBatch: null };
// Tests only: beforeUnarchive({ document }) runs right before
// openEntityContent's un-archive batch (a mode change). Never set in production.
export const openEntityHooks = { beforeUnarchive: null };

export const __overlayInternals = { normalizeOverlays, rawValueOf, comparable, gateNewNames };
