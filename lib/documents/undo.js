// P3-UNDO (PUB-04, PUB-05, PUB-02; spec 8.6 Undo, phase 3 plan decisions 1,
// 4 and 6): Undo of one publish, Undo of a whole set, take offline, and the
// Recently published list. Node console routes only.
//
// Called by lib/admin/documents-api.js after parse (400), authorize
// storefront.publish (401/403; storefront.read for the list), mode (409
// STORE_MODE_INVALID) and 428. Each is handed the whole parsed operation and
// returns { status, body }, which the dispatcher sends as it is. A refusal is
// thrown as a DocumentError and the dispatcher's failed() turns it into
// { status, body: { error, code, ...extra } }. The shapes are
// lib/admin/documents-api-shapes.js (SHAPES.undo, undoSet, unpublish,
// listRecentlyPublished).
//
//   undo(op, { actor })
//     op: { kind: "undo", id, logId, dryRun, hasRevision, revision }
//     200 { ok, message, savedVersion?: { id, where: "Earlier versions" },
//           liveUrl, document }
//     200 { ok, nothing: true, message, liveUrl: null, document }
//     200 dryRun { ok, willTakeOffline, linkers: [{id, label}],
//                  changes: [{words}], target: {versionId, name} | null }
//     409 PUBLISHED_ELSEWHERE | DOCUMENT_CHANGED (current) | SLUG_TAKEN
//         (slug, other {id, title, label}) | PUBLISH_NOT_AVAILABLE (document)
//         | DOCUMENT_ARCHIVED
//     503 PUBLISH_UNKNOWN | PUBLISH_BUSY, 500 PUBLISH_FAILED, 404 NOT_FOUND
//   undoSet(op, { actor })
//     op: { kind: "undoSet", setId, members: [{ id, logId }], dryRun }
//     200 { ok, message, documents: [document] }, 200 dryRun (target null)
//   unpublish(op, { actor })
//     op: { kind: "unpublish", id, dryRun, hasRevision, revision }
//     200 { ok, message, document }, 200 dryRun (willTakeOffline, target null)
//     409 CANNOT_TAKE_OFFLINE | DOCUMENT_CHANGED | PUBLISHED_ELSEWHERE
//   listRecentlyPublished(op, { actor })
//     op: { kind: "listRecentlyPublished", limit }
//     200 { ok, rows: [{ logId, setId, documentId, label, action,
//           actionWords, byName, at, summary: [{words}], canUndo,
//           undo: {id, revision, logId} | null, note? }] }
//
// Which publish_log row can be undone (the target rule, plan decision 6):
//   - An undoable row is a row with action publish, unpublish or restore that
//     no 'undo' row names in undoes_log_id. 'undo' and 'migrated' rows are
//     never targets.
//   - A row is "current" when it is the document's latest undoable row AND
//     the live state still matches it:
//       publish / restore  documents.published_version_id is the row's
//                          to_version_id, or a copy of it that an Undo put
//                          live (see "copies" below)
//       unpublish          published_version_id IS NULL and
//                          undone_version_id = the row's from_version_id
//   Copies: every build mints fresh version ids, so an Undo that goes back to
//   version v puts a fresh copy v' live, never v itself. Without following
//   copies, the row that published v would never match again after one Undo,
//   and a second Undo could not step further back. So the live version
//   "matches" a publish row whose to_version_id is v when it is v, or the
//   to_version_id of an 'undo' row that undid a row whose from_version_id
//   matches v (followed forward through the log). An Undo that took a page
//   offline adds no copy.
//
// undo, in order:
//   1. read the document and all of its log rows (two statements); the row
//      must be the document's, and current, else 409 PUBLISHED_ELSEWHERE
//      ("This was changed after that publish. Reload to see the latest.")
//      with current. A 'migrated' row, or no row: 200 nothing ("There's
//      nothing earlier to undo.").
//   2. the target is the row's from_version_id. A null target on a singleton
//      is 200 nothing ("This is the first published version. Edit it, or go
//      back to your starting design."); on a page, campaign or journal post
//      it takes the document offline. So does a target that is an offline
//      copy (the to_version_id of an 'unpublish' row, or of an Undo that
//      took the page offline): that publish was made while the page was
//      offline, so its Undo takes it offline again, keeping the draft, and
//      never puts the offline copy live. Undo of an 'unpublish' row brings the
//      page back: its target is that row's from_version_id, and the draft is
//      kept as it is.
//   3. the target body is upgradeBody(target version body), so the draft and
//      the fresh version are in the current schema.
//   4. slugs (every attempt): the target's slug against the live list
//      (checkSlugs, which is slugClash plus the archived release) and, when it
//      differs from the current draft slug, against every other draft
//      (draftSlugOwner). A clash is 409 SLUG_TAKEN naming that page, with a
//      next step, and nothing written. Reference checks are skipped.
//   5. a current draft whose draft_hash differs from both the live hash and
//      documentHash(target) is kept as an undo_saved version ("Saved before
//      Undo") inside the same guarded batch (extraVersions), with a fresh id
//      on every attempt, so a lost attempt leaves no orphan.
//   6. one guarded build through makeBuild (a fresh published version of the
//      target; entry, pages row or journal index entry and redirects from its
//      meta; the draft rewritten to the target; published the fresh version
//      with documentHash(target); undone null; expectPublished the live
//      version; an 'undo' log row with undoes_log_id and saved_version_id;
//      refs). Take offline: offline, draft unchanged, published null, undone
//      the live version.
//   7. runGuardedBuild. On a lost batch: one of this call's own builds found
//      live is success; otherwise the document is read again, and the row
//      must still be current (else 409 PUBLISHED_ELSEWHERE), then the build
//      is made again on the new revision. After 3 losses with the revision
//      moving each time: 409 DOCUMENT_CHANGED. Unknown: 503.
// A start revision other than the document's is 409 DOCUMENT_CHANGED (the
// founder decided on an older view). A dry run writes nothing and skips that
// check.
//
// P4-LIVEROW (OVL-02, ED-12, OVL-17): product and collection content
// (isLiveRowType) and the cart can be undone now.
//   - Undo of a publish puts the earlier version's live row back; Undo of a
//     first publish (nothing earlier) DELETES the live row (plan mode
//     "remove"): the product shows what Shopify sends again, the draft stays.
//   - A set of only these types is one live-row batch with no release
//     (makeLiveRowBuild, runLiveRowBuild); a mixed set rides the release
//     batch. Each product writes its search_outbox row (reason 'undo') inside
//     the batch.
//   - They can't be taken offline: unpublish answers 422
//     CANNOT_TAKE_OFFLINE_CONTENT with plain words, and nothing changes.
//   - A store that left documents mode during the batch is refused with plain
//     mode words (modeRefusal), never "changed after that publish".
import { libsql } from "../db.js";
import { slog } from "../log.js";
import { audit } from "../platform/audit.js";
import { NotFoundError } from "../cms/issues.js";
import { tenantId, tenantCfg } from "../tenant-context.js";
import { documentType, documentHash, upgradeBody } from "../registry/index.js";
import { DocumentError, publicDocument, actorString } from "./service.js";
import { MAX_ATTEMPTS, DELETED_MESSAGE, readLive, liveEntryOf, journalIndexOf, checkSlugs, draftSlugOwner, makeBuild, runGuardedBuild, hasRefsTable, makeLiveRowBuild, runLiveRowBuild } from "./build.js";
import { isLiveRowType } from "../registry/document-types.js";
import { titleGate, titleUndoMessage, putsNewNameLive } from "../catalog/title-gate.js";
import { describeChanges } from "./changes.js";
import { journalEntriesOf } from "./journal-index.js";
import { diffBodies, firstPublishRows } from "./diff.js";
import { linkersStatement, slugKey } from "./refs.js";
import { livePath, liveExitUrl } from "./paths.js";
import { verId } from "./ids.js";
import { namesFor, plainName } from "./versions.js";

// ---- words -----------------------------------------------------------------------------

export const ELSEWHERE_MESSAGE = "This was changed after that publish. Reload to see the latest.";
export const NOTHING_MESSAGE = "There's nothing earlier to undo.";
export const FIRST_VERSION_MESSAGE = "This is the first published version. Edit it, or go back to your starting design.";
export const OFFLINE_MESSAGE = "It's offline now. To bring it back, open it and publish it again.";
export const CANNOT_TAKE_OFFLINE_MESSAGE = "This part of the store can't be taken offline.";
export const NOT_LIVE_MESSAGE = "This page isn't live, so there's nothing to take offline.";
export const SAVED_NOTE = "Saved before Undo";
export const EARLIER_VERSIONS = "Earlier versions";
export const OFFLINE_NOTE = "Publish it again from the editor to bring it back.";
export const TAKEN_OFFLINE_ROW = "Taken offline";
export const BACK_ONLINE_ROW = "Back on your store";
export const PRODUCT_CONTENT_MESSAGE = "Product content can't be undone here yet, so nothing changed.";
// P4-LIVEROW (orchestrator ruling): product and collection content stay live
export const CONTENT_STAYS_LIVE_MESSAGE = "Product content can't be taken offline. To go back to what Shopify sends, choose Use Shopify's on each field and publish.";
export const BACK_TO_SHOPIFY_ROW = "Back to what Shopify sends";
export const ACTION_WORDS = Object.freeze({
  publish: "Published",
  unpublish: "Took offline",
  undo: "Undid",
  scheduled: "Published on schedule",
  restore: "Restored",
  migrated: "Moved to the new editor",
  discard: "Discarded edits",
});
const UNDOABLE = new Set(["publish", "unpublish", "restore"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const now = () => new Date().toISOString();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nounOf = (type) => documentType(type)?.noun || "this page";
const quoted = (label) => `“${label}”`;
const words = (rows) => rows.map((r) => ({ words: r.words }));

// "2 Nov, 10:00" in the store's time zone (Asia/Kolkata unless the store
// says otherwise).
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier time";
  const opts = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tenantCfg("merchant_timezone", null, "Asia/Kolkata") || "Asia/Kolkata" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "Asia/Kolkata" }).format(d);
  }
}

// The draft columns a target body gives, as service.js works them out.
const slugOf = (type, body) => (documentType(type)?.route && typeof body?.meta?.slug === "string" && body.meta.slug.trim() ? body.meta.slug : null);
function labelOf(type, body, entityId, current = null) {
  const t = documentType(type);
  if (t?.route) {
    const title = body?.meta?.title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : t.label;
  }
  // P4-LIVEROW: product and collection content keep their label (service.js)
  if (isLiveRowType(type)) return typeof current === "string" && current ? current : t?.label || "Document";
  return entityId ? `${t?.label || "Document"}: ${entityId}` : t?.label || "Document";
}

// ---- reads -----------------------------------------------------------------------------

const DOC_COLS =
  "id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, published_version_id, published_hash, undone_version_id, archived_at, created_at, updated_at, updated_by";

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
    updatedBy: r.updated_by == null ? null : String(r.updated_by),
  };
}

// The console's document (DOCUMENT in the shapes): no updatedBy.
function shown(d) {
  const { updatedBy: _u, ...rest } = d;
  return publicDocument(rest);
}

const LOG_COLS = "id, set_id, document_id, action, from_version_id, to_version_id, undoes_log_id, saved_version_id, actor, note, created_at";
const logFrom = (r) => ({
  id: String(r.id),
  setId: r.set_id == null ? null : String(r.set_id),
  documentId: r.document_id == null ? null : String(r.document_id),
  action: String(r.action),
  from: r.from_version_id == null ? null : String(r.from_version_id),
  to: r.to_version_id == null ? null : String(r.to_version_id),
  undoes: r.undoes_log_id == null ? null : String(r.undoes_log_id),
  saved: r.saved_version_id == null ? null : String(r.saved_version_id),
  actor: r.actor == null ? null : String(r.actor),
  at: String(r.created_at),
});

const placeholders = (xs) => xs.map(() => "?").join(", ");

// The documents and every log row of each, oldest first: two statements.
// Map id -> { doc, rows, a } where a is analyse(rows, doc).
async function readStates(ids) {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const [docs, logs] = await Promise.all([
    libsql.execute({ sql: `SELECT ${DOC_COLS} FROM documents WHERE id IN (${placeholders(list)})`, args: list }),
    libsql.execute({ sql: `SELECT ${LOG_COLS} FROM publish_log WHERE document_id IN (${placeholders(list)}) ORDER BY created_at, rowid`, args: list }),
  ]);
  const rowsOf = new Map(list.map((id) => [id, []]));
  for (const r of logs.rows) rowsOf.get(String(r.document_id))?.push(logFrom(r));
  const out = new Map();
  for (const r of docs.rows) {
    const doc = fromRow(r);
    const rows = rowsOf.get(doc.id) || [];
    out.set(doc.id, { doc, rows, a: analyse(rows, doc) });
  }
  return out;
}

// Version rows by id, one statement: Map id -> { id, documentId, kind, body,
// createdBy, createdAt }.
async function readVersions(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const r = await libsql.execute({ sql: `SELECT id, document_id, kind, body, created_by, created_at FROM document_versions WHERE id IN (${placeholders(list)})`, args: list });
  const out = new Map();
  for (const row of r.rows) {
    let body = null;
    try {
      body = JSON.parse(String(row.body));
    } catch {
      body = null;
    }
    out.set(String(row.id), {
      id: String(row.id),
      documentId: String(row.document_id),
      kind: String(row.kind),
      body,
      createdBy: row.created_by == null ? null : String(row.created_by),
      createdAt: String(row.created_at),
    });
  }
  return out;
}

// ---- the target rule -------------------------------------------------------------------

// rows: one document's log rows, oldest first. Pure (exported for the suite).
export function analyse(rows, doc) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const undone = new Set(rows.filter((r) => r.action === "undo" && r.undoes).map((r) => r.undoes));
  let latest = null;
  for (const r of rows) if (UNDOABLE.has(r.action) && !undone.has(r.id)) latest = r;
  // Offline copies: the version a take offline leaves in the list entry
  // (switched off, never live). That is the to_version_id of an 'unpublish'
  // row and of an 'undo' row that took the page offline. A publish or
  // restore row whose from_version_id is one of them replaced nothing live,
  // so its Undo takes the page offline again, like a first publish's Undo.
  // Followed forward through the log (oldest first), so a page taken
  // offline, published, undone, published and undone again still counts.
  const offlineVersions = new Set();
  const offlineUndos = new Set();
  const replacedNothingLive = (r) => r.from == null || offlineVersions.has(r.from);
  for (const r of rows) {
    if (r.action === "unpublish" && r.to) offlineVersions.add(r.to);
    else if (r.action === "undo") {
      const u = byId.get(r.undoes);
      if (u && (u.action === "publish" || u.action === "restore") && replacedNothingLive(u)) {
        offlineUndos.add(r.id);
        if (r.to) offlineVersions.add(r.to);
      }
    }
  }
  // an 'undo' row that took the page offline: it undid a publish that
  // replaced nothing live (a first publish, or one made while offline)
  const tookOffline = (u) => u?.action === "undo" && offlineUndos.has(u.id);
  const broughtBack = (u) => u?.action === "undo" && byId.get(u.undoes)?.action === "unpublish";
  // v and every copy of it an Undo put live, following the log forward
  const copiesOf = (v) => {
    const set = new Set([v]);
    for (const r of rows) {
      if (r.action !== "undo" || !r.to || tookOffline(r)) continue;
      const u = byId.get(r.undoes);
      if (u && u.from != null && set.has(u.from)) set.add(r.to);
    }
    return set;
  };
  const matches = (r) => {
    if (!doc) return false;
    if (r.action === "unpublish") return doc.publishedVersionId == null && r.from != null && doc.undoneVersionId === r.from;
    return doc.publishedVersionId != null && r.to != null && copiesOf(r.to).has(doc.publishedVersionId);
  };
  const isCurrent = (r) => !!r && !!latest && r.id === latest.id && matches(r);
  return { latest, isCurrent, tookOffline, broughtBack, replacedNothingLive, byId };
}

// ---- refusals --------------------------------------------------------------------------

async function currentOf(d, actor) {
  let updatedByName = null;
  if (d.updatedBy) {
    if (actorString(actor) && d.updatedBy === actorString(actor)) updatedByName = "another tab";
    else updatedByName = plainName(d.updatedBy, await namesFor(tenantId()));
  }
  return { ...shown(d), updatedBy: d.updatedBy, updatedByName };
}

async function elsewhere(d, actor, { named = false } = {}) {
  return new DocumentError(409, "PUBLISHED_ELSEWHERE", named ? `${quoted(d.label)} was changed after that publish. Reload to see the latest.` : ELSEWHERE_MESSAGE, { current: await currentOf(d, actor) });
}
async function changed(d, actor, { named = false } = {}) {
  const who = named ? quoted(d.label) : cap(nounOf(d.type));
  return new DocumentError(409, "DOCUMENT_CHANGED", `${who} was changed since you opened it, so nothing changed on your live store. Reload to see the latest.`, { current: await currentOf(d, actor) });
}
const archivedError = (d) => new DocumentError(409, "DOCUMENT_ARCHIVED", `${cap(nounOf(d.type))} was archived, so nothing changed on your live store. Reload to see your pages.`, { current: shown(d) });
const missing = () => new NotFoundError("This page no longer exists. It may have been deleted. Reload to see your pages.");

// Refusals made here already carry their next step. A SLUG_TAKEN that the
// commit itself found (another draft took the slug during the batch) is
// finished with one.
const ours = new WeakSet();
function slugTaken(slug, other) {
  const name = other ? other.label : null;
  const message = name
    ? `Another page already uses /${slug}: ${name}. Change the address of ${quoted(name)}, or take it offline and archive it, then undo again.`
    : `Another page already uses /${slug}. Change the address of that page, or take it offline and archive it, then undo again.`;
  const e = new DocumentError(409, "SLUG_TAKEN", message, { slug, other: other ? { id: other.id, title: other.title ?? other.label, label: other.label } : null });
  ours.add(e);
  return e;
}
function finishSlugTaken(e) {
  if (!(e instanceof DocumentError) || e.code !== "SLUG_TAKEN" || ours.has(e)) return e;
  const other = e.extra?.other || null;
  return slugTaken(e.extra?.slug ?? "", other ? { id: other.id, title: other.title, label: other.label || other.title } : null);
}

async function labelFor(id, fallback) {
  try {
    const r = await libsql.execute({ sql: "SELECT label FROM documents WHERE id = ?", args: [id] });
    return r.rows[0] ? String(r.rows[0].label) : fallback;
  } catch {
    return fallback;
  }
}

// What may be undone at all (spec 8.6). P4-LIVEROW: product and collection
// content (OVL-02) and the cart (plan OQ-6) are undone like any document.
function refuseType(doc) {
  const t = documentType(doc.type);
  if (!t?.publishable) throw new DocumentError(409, "PUBLISH_NOT_AVAILABLE", PRODUCT_CONTENT_MESSAGE.replace("Product content", t ? cap(t.label) : "This"), { document: doc.id });
  if (t.system || !t.editable) throw new DocumentError(409, "PUBLISH_NOT_AVAILABLE", `${cap(t.noun)} is made by the store itself, so it can't be undone here.`, { document: doc.id });
}

// ---- one member: what Undo of its row does -------------------------------------------

// { nothing: message } | { mode: 'offline' } | { mode: 'restore' | 'online', targetId }
// a: analyse(rows, doc). A publish or restore made while the page was offline
// (its from_version_id is an offline copy) goes back to offline, never to
// that copy, which was never live.
// P4-LIVEROW: { mode: 'remove' } for a product's or collection's first
// publish: its live row goes, so it shows what Shopify sends again.
function planOf(doc, row, a = null) {
  if (row.action === "unpublish") return { mode: "online", targetId: row.from };
  if (row.from == null || (a && a.replacedNothingLive(row))) {
    if (isLiveRowType(doc.type)) return { mode: "remove" };
    return documentType(doc.type)?.route ? { mode: "offline" } : { nothing: FIRST_VERSION_MESSAGE };
  }
  return { mode: "restore", targetId: row.from };
}

// A member: { id, logId, doc, row, plan, target (version), body (upgraded), liveBody }
// Checks the row (step 1) and the floors (step 2).
async function memberOf(states, { id, logId }, actor, { named = false } = {}) {
  const st = states.get(id);
  if (!st) throw missing();
  const { doc, a } = st;
  if (doc.archivedAt) throw archivedError(doc);
  refuseType(doc);
  const row = a.byId.get(logId) || null;
  // another document's row is not what the founder is looking at
  if (!row && (await rowExists(logId))) throw await elsewhere(doc, actor, { named });
  if (!row || row.action === "migrated") return { id, logId, doc, row, plan: { nothing: NOTHING_MESSAGE } };
  if (!a.isCurrent(row)) throw await elsewhere(doc, actor, { named });
  return { id, logId, doc, row, plan: planOf(doc, row, a) };
}

async function rowExists(logId) {
  const r = await libsql.execute({ sql: "SELECT 1 AS x FROM publish_log WHERE id = ?", args: [String(logId ?? "")] });
  return r.rows.length > 0;
}

// Bodies of the targets and of what is live, in one statement.
async function loadBodies(members) {
  const need = [];
  for (const m of members) {
    if (m.plan.nothing) continue;
    if (m.plan.targetId) need.push(m.plan.targetId);
    if (m.doc.publishedVersionId) need.push(m.doc.publishedVersionId);
  }
  const vs = await readVersions(need);
  for (const m of members) {
    if (m.plan.nothing) continue;
    if (m.doc.publishedVersionId) {
      const lv = vs.get(m.doc.publishedVersionId);
      if (!lv || !isObj(lv.body)) throw new Error(`undo: the live version ${m.doc.publishedVersionId} of ${m.id} couldn't be read`);
      m.liveBody = lv.body;
    } else m.liveBody = null;
    if (m.plan.targetId) {
      const tv = vs.get(m.plan.targetId);
      if (!tv || tv.documentId !== m.id || !isObj(tv.body)) throw new Error(`undo: the earlier version ${m.plan.targetId} of ${m.id} couldn't be read`);
      m.target = tv;
      // step 3: the current schema, for the draft and the fresh version
      m.body = upgradeBody(tv.body);
      m.hash = await documentHash(m.body);
    }
  }
}

// One makeBuild item for a member, from its document as read now (step 5 and 6).
function itemOf(m, live, journalBody, action = "undo") {
  const doc = m.doc;
  // P4-LIVEROW: a live-row document's live entry is its own published version
  const liveEntry = isLiveRowType(doc.type) ? (doc.publishedVersionId ? { version: doc.publishedVersionId, hash: doc.publishedHash } : null) : liveEntryOf(live.list, journalBody, doc);
  if (m.plan.mode === "remove") {
    // the live row goes; a fresh copy of the last live body is the log's
    // to-version; the draft is kept
    return { doc, body: m.liveBody, remove: true, action: "undo", liveEntry, undoesLogId: m.row.id, expectPublished: doc.publishedVersionId, undone: null, published: { versionId: null, hash: null } };
  }
  if (m.plan.mode === "offline") {
    return { doc, body: m.liveBody, offline: true, action, undone: doc.publishedVersionId, expectPublished: doc.publishedVersionId, undoesLogId: action === "undo" ? m.row.id : null, liveEntry };
  }
  const item = { doc, body: m.body, hash: m.hash, action: "undo", liveEntry, undoesLogId: m.row.id, expectPublished: doc.publishedVersionId, undone: null };
  if (m.plan.mode === "restore") {
    item.draft = { body: m.body, hash: m.hash, slug: slugOf(doc.type, m.body), label: labelOf(doc.type, m.body, doc.entityId, doc.label) };
    // a newer draft that is neither live nor the target is kept, inside this
    // batch, with an id minted for this attempt only
    if (doc.draftHash !== doc.publishedHash && doc.draftHash !== m.hash) {
      const id = verId();
      item.extraVersions = [{ id, kind: "undo_saved", body: doc.body, note: SAVED_NOTE }];
      item.savedVersionId = id;
    }
  }
  return item;
}

const needsJournal = (members) => members.some((m) => documentType(m.doc.type)?.route);

async function indexOf(list, cache) {
  const e = list.indexes?.journal;
  if (!e) return { entry: null, body: null };
  if (!cache.has(e.version)) cache.set(e.version, (await journalIndexOf(list)).body);
  return { entry: e, body: cache.get(e.version) };
}

// Step 4, every attempt: the live list, then other drafts.
async function slugCheck(from, journal, members, items) {
  const going = items.filter((it) => !it.offline && documentType(it.doc.type)?.route);
  if (!going.length) return [];
  const slugs = await checkSlugs(from.list, journalEntriesOf(journal.body), going);
  if (slugs.error) {
    const other = slugs.error.extra?.other;
    throw slugTaken(slugs.error.extra?.slug, other ? { id: other.id, title: other.title, label: await labelFor(other.id, other.title) } : null);
  }
  for (const it of going) {
    const slug = it.draft?.slug;
    if (!slug || slug === it.doc.slug) continue;
    const owner = await draftSlugOwner(slug, it.doc.id);
    if (owner && !members.some((m) => m.id === owner.id)) throw slugTaken(slug, { id: owner.id, title: owner.label, label: owner.label });
  }
  return slugs.release;
}

// ---- the guarded write -----------------------------------------------------------------

// members: those that change. recheck(fresh state, member) throws when the
// member's row is no longer what the founder undid (onLost, step 7).
async function guarded(members, { actor, action = "undo", log, recheck }) {
  const by = actorString(actor);
  const cache = new Map();
  const live = await readLive();
  const journalToo = needsJournal(members);
  const items = [];
  // P4-LIVEROW: only product and collection content: one live-row batch
  if (members.every((m) => isLiveRowType(m.doc.type))) {
    return runLiveRowBuild(
      async ({ refs }) => {
        const next = members.map((m) => itemOf(m, live, null, action));
        items.length = 0;
        items.push(...next);
        return makeLiveRowBuild(next, { by, at: now(), refs });
      },
      {
        log,
        items,
        done: (b) => b,
        onLost: async ({ attempt, sent }) => {
          const fresh = await readStates(members.map((m) => m.id));
          for (const m of members) {
            const b = sent.get(fresh.get(m.id)?.doc.publishedVersionId);
            if (b) return b;
          }
          // a removed live row leaves no version to find: the undo log row is ours
          const mine = await ownUndoRow(members, sent);
          if (mine) return mine;
          let moved = null;
          for (const m of members) {
            const st = fresh.get(m.id);
            if (!st) throw new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: [m.id] });
            if (st.doc.archivedAt) throw archivedError(st.doc);
            await recheck(st, m);
            if (st.doc.revision !== m.doc.revision) moved = moved || st.doc;
            m.doc = st.doc;
          }
          if (moved && attempt >= MAX_ATTEMPTS) throw await changed(moved, actor, { named: members.length > 1 });
          return null;
        },
      },
    );
  }
  const build = await runGuardedBuild(
    async ({ live: from, refs }) => {
      const journal = journalToo ? await indexOf(from.list, cache) : { entry: null, body: null };
      const next = members.map((m) => itemOf(m, from, journal.body, action));
      const release = await slugCheck(from, journal, members, next);
      items.length = 0;
      items.push(...next);
      return makeBuild(from, next, { by, at: now(), journal, release, refs });
    },
    {
      live,
      log,
      items,
      done: (b) => b,
      onLost: async ({ attempt, next, sent }) => {
        const nextIndex = journalToo ? await indexOf(next.list, cache) : { body: null };
        // one of this call's own builds went live after all
        for (const m of members) {
          const b = sent.get(liveEntryOf(next.list, nextIndex.body, m.doc)?.version);
          if (b) return b;
        }
        const ib = sent.get(next.list.indexes?.journal?.version);
        if (ib) return ib;
        const fresh = await readStates(members.map((m) => m.id));
        let moved = null;
        for (const m of members) {
          const st = fresh.get(m.id);
          if (!st) throw new DocumentError(404, "DOCUMENT_DELETED", DELETED_MESSAGE, { missing: [m.id] });
          if (st.doc.archivedAt) throw archivedError(st.doc);
          await recheck(st, m);
          if (st.doc.revision !== m.doc.revision) moved = moved || st.doc;
          m.doc = st.doc; // the next build guards on the new revision
        }
        if (moved && attempt >= MAX_ATTEMPTS) throw await changed(moved, actor, { named: members.length > 1 });
        return null;
      },
    },
  ).catch((e) => {
    throw finishSlugTaken(e);
  });
  return build;
}

// The build whose undo log row is in publish_log: a batch that committed after
// its answer was lost (a remove leaves no live version to recognise it by).
async function ownUndoRow(members, sent) {
  const builds = [...new Set(sent.values())];
  const ids = builds.flatMap((b) => b.log.map((l) => l.id));
  if (!ids.length) return null;
  const r = await libsql.execute({ sql: `SELECT id FROM publish_log WHERE id IN (${placeholders(ids)})`, args: ids });
  const found = new Set(r.rows.map((x) => String(x.id)));
  return builds.find((b) => b.log.length && b.log.every((l) => found.has(l.id))) || null;
}

const recheckRow = (actor, named) => async (st, m) => {
  const row = st.a.byId.get(m.row.id);
  if (!st.a.isCurrent(row)) throw await elsewhere(st.doc, actor, { named });
};

async function after(build, op, actor) {
  slog("documents_undo", { op, release: build.releaseId ?? null, set: build.setId, documents: build.documents.map((d) => d.id) });
  await audit({ actor, action: "storefront.publish", resource: build.releaseId ? `release:${build.releaseId}` : `set:${build.setId}`, diff: { op, set: build.setId, documents: build.documents.map((d) => d.id) } }); // best-effort, never throws
  return readStates(build.documents.map((d) => d.id));
}

// ---- dry runs --------------------------------------------------------------------------

async function linkersOf(members) {
  const route = members.filter((m) => documentType(m.doc.type)?.route);
  if (!route.length || !(await hasRefsTable())) return [];
  const own = new Set(members.map((m) => m.id));
  const seen = new Map();
  for (const m of route) {
    const slug = (isObj(m.liveBody?.meta) && typeof m.liveBody.meta.slug === "string" && m.liveBody.meta.slug) || m.doc.slug;
    const st = linkersStatement(m.id, slug ? slugKey(m.doc.type, slug) : null);
    const r = await libsql.execute(st);
    for (const row of r.rows) if (!own.has(String(row.id)) && !seen.has(String(row.id))) seen.set(String(row.id), { id: String(row.id), label: String(row.label) });
  }
  return [...seen.values()];
}

function changesOf(m) {
  if (m.plan.mode === "offline") return [{ words: TAKEN_OFFLINE_ROW }];
  if (m.plan.mode === "remove") return [{ words: BACK_TO_SHOPIFY_ROW }];
  if (isLiveRowType(m.doc.type)) return words(describeChanges(m.doc.type, m.liveBody, m.body));
  if (m.plan.mode === "online") return words(firstPublishRows(m.doc.type, m.body));
  // diffBodies only ever gets two bodies (P3-DIFF: a null side gives false rows)
  return m.liveBody ? words(diffBodies(m.doc.type, m.liveBody, m.body)) : words(firstPublishRows(m.doc.type, m.body));
}

async function targetName(v) {
  const by = plainName(v.createdBy, await namesFor(tenantId()));
  return `${v.kind === "migrated" ? "Moved to the new editor" : "Published"} ${when(v.createdAt)} by ${by}`;
}

// P4-SEARCH (P4-LIVEROW review): the title gate's belt, for Undo. While the
// gate is closed, an Undo that would put back a product name (or type shown,
// brand shown) that differs from what is live is refused, naming the product
// in the words of the condition that blocked; nothing changes. Undo of a first
// publish (Shopify's names again) is never refused.
async function undoTitleBelt(members) {
  const products = members.filter((m) => m.doc.type === "product_content" && m.plan.mode === "restore" && m.body);
  if (!products.length) return;
  const gate = titleGate();
  if (!gate.blocked) return;
  const blocked = products.filter((m) => putsNewNameLive(m.body, m.liveBody));
  if (!blocked.length) return;
  const titles = new Map();
  try {
    const ids = blocked.map((m) => m.doc.entityId).filter(Boolean);
    if (ids.length) {
      const r = await libsql.execute({ sql: `SELECT id, title FROM products WHERE id IN (${ids.map(() => "?").join(", ")})`, args: ids });
      for (const row of r.rows) titles.set(String(row.id), String(row.title));
    }
  } catch {
    /* the document's own label still names it */
  }
  const label = (m) => titles.get(m.doc.entityId) || m.doc.label;
  const names = blocked.map((m) => quoted(label(m)));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  throw new DocumentError(409, "TITLE_NOT_PUBLISHABLE", titleUndoMessage(list, gate.cause), { documents: blocked.map((m) => ({ id: m.doc.id, label: label(m) })) });
}

// ---- undo ------------------------------------------------------------------------------

// Phase 5 line 3: a design publish that switched to or from an uploaded theme
// took the theme's layouts live with it (doc_header, doc_footer and the
// product and collection layouts, same set). Undoing the design alone would
// leave the newer theme's layouts live, so its Undo undoes them together:
// the whole publish's undoSet over the design and those layout rows.
const THEME_LAYOUT_DOCS = ["doc_header", "doc_footer", "doc_product_layout", "doc_collection_layout"];
async function themeLayoutsWith(logId) {
  const r = await libsql.execute({ sql: "SELECT set_id, from_version_id, to_version_id FROM publish_log WHERE id = ? AND document_id = 'doc_design' AND action = 'publish'", args: [String(logId ?? "")] });
  const row = r.rows[0];
  if (!row?.set_id) return null;
  const ids = [row.from_version_id, row.to_version_id].filter((v) => v != null).map(String);
  if (!ids.length) return null;
  const v = await libsql.execute({ sql: `SELECT body FROM document_versions WHERE id IN (${ids.map(() => "?").join(", ")})`, args: ids });
  const named = v.rows.some((x) => {
    try {
      return typeof JSON.parse(String(x.body))?.settings?.theme?.package === "string";
    } catch {
      return false;
    }
  });
  if (!named) return null;
  const set = await libsql.execute({
    sql: `SELECT id, document_id FROM publish_log WHERE set_id = ? AND set_id IS NOT NULL AND action = 'publish' AND document_id IN (${THEME_LAYOUT_DOCS.map(() => "?").join(", ")})`,
    args: [String(row.set_id), ...THEME_LAYOUT_DOCS],
  });
  return set.rows.length ? { setId: String(row.set_id), members: set.rows.map((x) => ({ id: String(x.document_id), logId: String(x.id) })) } : null;
}

export async function undo(op = {}, { actor = null } = {}) {
  if (op.id === "doc_design") {
    const together = await themeLayoutsWith(op.logId);
    if (together) {
      const design = (await readStates([op.id])).get(op.id);
      if (design && (op.dryRun || design.doc.revision === op.revision)) {
        const r = await undoSet({ setId: together.setId, members: [{ id: op.id, logId: op.logId }, ...together.members], dryRun: op.dryRun }, { actor });
        const doc = r.body?.documents?.find((d) => d.id === op.id);
        return doc ? { ...r, body: { ...r.body, document: doc } } : r;
      }
    }
  }
  const states = await readStates([op.id]);
  const m = await memberOf(states, { id: op.id, logId: op.logId }, actor);
  if (m.plan.nothing) {
    if (op.dryRun) return { status: 200, body: { ok: true, willTakeOffline: false, linkers: [], changes: [], target: null } };
    return { status: 200, body: { ok: true, nothing: true, message: m.plan.nothing, liveUrl: null, document: shown(m.doc) } };
  }
  if (!op.dryRun && m.doc.revision !== op.revision) throw await changed(m.doc, actor);
  await loadBodies([m]);
  await undoTitleBelt([m]);
  if (op.dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        willTakeOffline: m.plan.mode === "offline",
        linkers: await linkersOf([m]),
        changes: changesOf(m),
        target: m.target ? { versionId: m.target.id, name: await targetName(m.target) } : null,
      },
    };
  }
  const build = await guarded([m], { actor, log: { op: "undo", documents: [m.id] }, recheck: recheckRow(actor, false) });
  const doc = (await after(build, "undo", actor)).get(m.id)?.doc;
  if (!doc) throw missing();
  if (m.plan.mode === "offline") return { status: 200, body: { ok: true, message: OFFLINE_MESSAGE, liveUrl: null, document: shown(doc) } };
  if (m.plan.mode === "remove") {
    return { status: 200, body: { ok: true, message: `${quoted(doc.label)} shows what Shopify sends again. Your edits are still in the editor.`, liveUrl: liveExitUrl(await entityPath(doc)), document: shown(doc) } };
  }
  const savedId = build.extraVersions?.find((v) => v.document_id === m.id)?.id ?? null;
  const message =
    m.plan.mode === "online"
      ? `${quoted(doc.label)} is back on your store, as it was before it went offline.`
      : `${quoted(doc.label)} is back to the version that went live on ${when(m.target.createdAt)}.${savedId ? ` Your newer changes are kept in ${EARLIER_VERSIONS}.` : ""}`;
  const body = { ok: true, message };
  if (savedId) body.savedVersion = { id: savedId, where: EARLIER_VERSIONS };
  body.liveUrl = liveExitUrl(isLiveRowType(doc.type) ? await entityPath(doc) : livePath(doc.type, m.body.meta));
  body.document = shown(doc);
  return { status: 200, body };
}

// P4-LIVEROW: where a product's or collection's content shows
async function entityPath(doc) {
  if (!isLiveRowType(doc.type) || !doc.entityId) return "/";
  const table = doc.type === "collection_content" ? "collections" : "products";
  try {
    const r = await libsql.execute({ sql: `SELECT handle FROM ${table} WHERE id = ?`, args: [doc.entityId] });
    const h = r.rows[0]?.handle;
    if (h == null) return "/";
    return `/${table}/${encodeURIComponent(String(h))}`;
  } catch {
    return "/";
  }
}

// ---- undoSet ---------------------------------------------------------------------------

export async function undoSet(op = {}, { actor = null } = {}) {
  const wanted = Array.isArray(op.members) ? op.members : [];
  // the whole set, through the publish_log_set partial index (the IS NOT
  // NULL term is what lets SQLite use it: P3-COMMIT)
  const setRows = await libsql.execute({ sql: "SELECT id, document_id FROM publish_log WHERE set_id = ? AND set_id IS NOT NULL", args: [String(op.setId ?? "")] });
  const inSet = new Map(setRows.rows.map((r) => [String(r.id), String(r.document_id)]));
  const states = await readStates(wanted.map((w) => w.id));
  const members = [];
  for (const w of wanted) {
    const st = states.get(w.id);
    if (!st) throw missing();
    // a row that isn't this document's row of this set is not what was shown
    if (inSet.get(w.logId) !== w.id) throw await elsewhere(st.doc, actor, { named: true });
    members.push(await memberOf(states, w, actor, { named: true }));
  }
  const going = members.filter((m) => !m.plan.nothing);
  const stays = members.filter((m) => m.plan.nothing);
  await loadBodies(going);
  await undoTitleBelt(going);
  if (op.dryRun) {
    const many = going.length > 1;
    const changes = [];
    for (const m of going) for (const c of changesOf(m)) changes.push({ words: many ? `${m.doc.label}: ${c.words}` : c.words });
    return { status: 200, body: { ok: true, willTakeOffline: going.some((m) => m.plan.mode === "offline"), linkers: await linkersOf(going), changes, target: null } };
  }
  if (!going.length) return { status: 200, body: { ok: true, message: NOTHING_MESSAGE, documents: members.map((m) => shown(m.doc)) } };
  const build = await guarded(going, { actor, log: { op: "undoSet", set: op.setId, documents: going.map((m) => m.id) }, recheck: recheckRow(actor, true) });
  const fresh = await after(build, "undoSet", actor);
  const docs = members.map((m) => fresh.get(m.id)?.doc || m.doc);
  // P3-FIX2: which pages are live and which went offline, by name
  const names = (ms) => {
    const l = ms.map((m) => m.doc.label).sort((x, y) => x.localeCompare(y)).map(quoted);
    return l.length === 1 ? l[0] : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
  };
  const back = going.filter((m) => m.plan.mode !== "offline" && m.plan.mode !== "remove");
  const off = going.filter((m) => m.plan.mode === "offline");
  const removed = going.filter((m) => m.plan.mode === "remove");
  const parts = [];
  if (back.length) parts.push(`${names(back)} ${back.length === 1 ? "is" : "are"} live again, as ${back.length === 1 ? "it was" : "they were"} before that publish.`);
  if (removed.length) parts.push(`${names(removed)} ${removed.length === 1 ? "shows" : "show"} what Shopify sends again. The edits are still in the editor.`);
  if (off.length) parts.push(`${names(off)} ${off.length === 1 ? "is" : "are"} offline now, as ${off.length === 1 ? "it was" : "they were"} before that publish. To bring ${off.length === 1 ? "it back, open it and publish it again" : "them back, open each one and publish it again"}.`);
  const kept = going.filter((m) => build.extraVersions?.some((v) => v.document_id === m.id));
  if (kept.length) parts.push(`Newer changes to ${kept.map((m) => quoted(m.doc.label)).join(", ")} are kept in ${EARLIER_VERSIONS}.`);
  if (stays.length) parts.push(`${stays.map((m) => quoted(m.doc.label)).join(", ")} stayed as ${stays.length === 1 ? "it was" : "they were"}: there was nothing earlier.`);
  return { status: 200, body: { ok: true, message: parts.join(" "), documents: docs.map(shown) } };
}

// ---- unpublish -------------------------------------------------------------------------

export async function unpublish(op = {}, { actor = null } = {}) {
  const states = await readStates([op.id]);
  const st = states.get(op.id);
  if (!st) throw missing();
  const doc = st.doc;
  // P4-LIVEROW (orchestrator ruling): product and collection content can't
  // be taken offline; nothing is deleted and no search row is written
  if (isLiveRowType(doc.type)) throw new DocumentError(422, "CANNOT_TAKE_OFFLINE_CONTENT", CONTENT_STAYS_LIVE_MESSAGE, { issues: [] });
  if (doc.archivedAt) throw archivedError(doc);
  const t = documentType(doc.type);
  if (!t?.route) throw new DocumentError(409, "CANNOT_TAKE_OFFLINE", CANNOT_TAKE_OFFLINE_MESSAGE);
  if (!doc.publishedVersionId) throw new DocumentError(409, "CANNOT_TAKE_OFFLINE", NOT_LIVE_MESSAGE);
  if (!op.dryRun && doc.revision !== op.revision) throw await changed(doc, actor);
  const m = { id: doc.id, doc, row: null, plan: { mode: "offline" } };
  await loadBodies([m]);
  if (op.dryRun) return { status: 200, body: { ok: true, willTakeOffline: true, linkers: await linkersOf([m]), changes: changesOf(m), target: null } };
  const was = doc.publishedVersionId;
  const build = await guarded([m], {
    actor,
    action: "unpublish",
    log: { op: "unpublish", documents: [m.id] },
    recheck: async (fresh) => {
      if (fresh.doc.publishedVersionId !== was) throw await elsewhere(fresh.doc, actor);
    },
  });
  const after_ = (await after(build, "unpublish", actor)).get(m.id)?.doc;
  if (!after_) throw missing();
  return { status: 200, body: { ok: true, message: OFFLINE_MESSAGE, document: shown(after_) } };
}

// ---- listRecentlyPublished -------------------------------------------------------------

export async function listRecentlyPublished(op = {}, { actor: _actor = null } = {}) {
  const limit = Math.max(1, Math.min(50, Number.isInteger(op.limit) ? op.limit : 20));
  const recent = await libsql.execute({
    sql: `SELECT ${LOG_COLS.split(", ").map((c) => `p.${c}`).join(", ")}, d.label AS label, d.type AS type FROM publish_log p LEFT JOIN documents d ON d.id = p.document_id ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
    args: [limit],
  });
  const rows = recent.rows.map((r) => ({ ...logFrom(r), label: r.label == null ? null : String(r.label), type: r.type == null ? null : String(r.type) }));
  if (!rows.length) return { status: 200, body: { ok: true, rows: [] } };
  const states = await readStates(rows.map((r) => r.documentId).filter(Boolean));
  // every body a summary needs, in one IN statement
  const need = [];
  for (const r of rows) if (r.action !== "unpublish") need.push(r.from, r.to);
  const [bodies, names] = await Promise.all([readVersions(need), namesFor(tenantId())]);
  const bodyOf = (id) => (id ? bodies.get(id)?.body ?? null : null);

  const out = rows.map((r) => {
    const st = r.documentId ? states.get(r.documentId) : null;
    const type = r.type || st?.doc.type || null;
    const a = st?.a;
    const fromRow_ = a?.byId.get(r.id) || r;
    let summary = [];
    let note;
    const rowType = isLiveRowType(type);
    if (r.action === "unpublish") summary = [{ words: TAKEN_OFFLINE_ROW }];
    else if (r.action === "discard") summary = [{ words: "Edits of a product that left Shopify" }];
    else if (rowType && r.action === "undo" && a?.tookOffline(fromRow_)) summary = [{ words: BACK_TO_SHOPIFY_ROW }];
    else if (rowType && r.action !== "migrated") {
      const from = bodyOf(r.from);
      const to = bodyOf(r.to);
      if (to) summary = words(describeChanges(type, from, to));
    } else if (r.action === "undo" && a?.tookOffline(fromRow_)) {
      summary = [{ words: TAKEN_OFFLINE_ROW }];
      note = OFFLINE_NOTE;
    } else if (r.action === "undo" && a?.broughtBack(fromRow_)) summary = [{ words: BACK_ONLINE_ROW }];
    else if (r.action !== "migrated") {
      const from = bodyOf(r.from);
      const to = bodyOf(r.to);
      if (to && from) summary = words(diffBodies(type, from, to));
      else if (to && r.from == null) summary = words(firstPublishRows(type, to));
    }
    // P3-FIX2: never offered where Undo would only answer "nothing" (a
    // singleton's first publish: there is no earlier version, and it can't
    // be taken offline)
    const current_ = !!st && st.a.isCurrent(st.a.byId.get(r.id));
    const canUndo = current_ && !st.doc.archivedAt && UNDOABLE.has(r.action) && documentType(st.doc.type)?.publishable === true && !planOf(st.doc, st.a.byId.get(r.id), st.a).nothing;
    const row = {
      logId: r.id,
      setId: r.setId,
      documentId: r.documentId,
      label: r.label ?? "A page that was deleted",
      action: r.action,
      actionWords: ACTION_WORDS[r.action] || "Changed",
      byName: plainName(r.actor, names),
      at: r.at,
      summary,
      canUndo,
      undo: canUndo ? { id: st.doc.id, revision: st.doc.revision, logId: r.id } : null,
    };
    if (note) row.note = note;
    return row;
  });
  // grouped by set: each set's rows together, sets in the order they first
  // appear (newest first)
  const order = [];
  const groups = new Map();
  for (const row of out) {
    const k = row.setId ?? row.logId;
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k).push(row);
  }
  return { status: 200, body: { ok: true, rows: order.flatMap((k) => groups.get(k)) } };
}

export const __undoInternals = { analyse, planOf, when, labelOf, slugOf };
