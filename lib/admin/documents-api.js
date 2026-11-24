// P2-DOCS (DOC-02, DOC-04; spec 8.14): the documents console API, behind
// PUT /api/admin/documents (app/api/admin/documents/route.js, nodejs). Kept
// apart from the route so scripts/test-documents.js runs the real dispatch,
// authorization and storage, as scripts/test-cms-api.js does for the legacy API.
//
// The A1 rule of lib/admin/cms-api.js: parse EXACTLY ONE operation, then
// authorize THAT operation, then run only it. A body with no operation, two,
// an unknown key or a malformed argument is a 400 before any authorization.
//
//   reads  (storefront.read)   getDocument, listDocuments, listHistory
//   writes (storefront.write)  createDocument, saveDraft, discardDraft,
//                              restoreVersion, archive
//
// Writes, after authorization:
//   500 STORE_MODE_INVALID  unless cms_state.mode is 'documents' (the only
//                           mode, lib/cms-mode.js). Checked before the
//                           revision. A mode that can't be read is a 5xx,
//                           never a go-ahead.
//   428 REVISION_REQUIRED   saveDraft, discardDraft, restoreVersion and archive
//                           must name the revision they started from
// Then: 409 with the current document (stale), 409 SLUG_TAKEN, 404, 422 with
// every issue (validationBody), and 5xx with a code for anything that isn't
// the founder's (failure()).
//
// Publishing (P2-PUBLISH, storefront.publish):
//   publish     { publish: { id, draftHash }, revision }
//   publishSet  { publishSet: [{ id, revision, draftHash }, …] }  (up to 200)
// Order: parse (400) -> authorize storefront.publish (401/403) -> mode (500
// STORE_MODE_INVALID) -> 428 for a missing revision or draftHash -> the service
// (lib/documents/publish.js). Schedules come later.
//
// P3-COMMIT: every phase 3 operation is parsed here, so no batch 2 item edits
// this file. The shapes are lib/admin/documents-api-shapes.js.
//   storefront.publish  unpublish   { unpublish: { id, dryRun? }, revision }
//                       undo        { undo: { id, logId, dryRun? }, revision }
//                       undoSet     { undoSet: { setId, members: [{ id, logId }], dryRun? } }
//                       publish and publishSet items accept confirmRepublish: true
//   storefront.read     listRecentlyPublished { listRecentlyPublished: { limit? } } (1..50, default 20)
//                       listChanges           { listChanges: { id } }
//   storefront.write    keepLiveSection       { keepLiveSection: { id, sectionId }, revision }
//                       keepAsEarlierDraft    { keepAsEarlierDraft: { id, body } } (no revision)
// The parser copies dryRun, logId and confirmRepublish. These operations are
// handed the whole parsed op ({ kind, …, hasRevision, revision }) and the
// module's { status, body } is sent as it is (lib/documents/undo.js and
// changes.js; stubs answering 501 NOT_BUILT until P3-UNDO and P3-CHANGES).
// Mode: the writes are checked as today. The mode reads (MODE_READS) check
// getCmsMode too and answer 500 STORE_MODE_INVALID on any other stored mode;
// getDocument, listDocuments and listHistory keep today's behaviour (no mode
// check). getDocument and listDocuments add access { canPublish, reason }.
//
// P4-LIVEROW (OVL-01, OVL-04, ED-12): product and collection content.
//   storefront.write    openEntityContent    { openEntityContent: { type, entityId } }
//                                            (no revision: it finds, makes, or
//                                            brings back the document)
//                       resolveShopifyChange { resolveShopifyChange: { id, field, choice }, revision }
//                                            choice "keep" | "shopify"
//   storefront.publish  discardOrphanEdits   { discardOrphanEdits: { id }, revision }
// A publish of only product and collection content answers release: null
// (no release row); it is audited by its set.
//
// P4-SEARCH (OVL-04, OVL-05, OVL-17):
//   storefront.read     listProductContent { listProductContent: { q?, filter?, cursor?, limit? } }
//                                          (or true): the editor's product list
//                                          (lib/admin/product-content-list.js).
//                                          filter 'all' | 'changed_in_shopify' |
//                                          'orphaned'; limit 1..100 (30). Checks
//                                          the mode itself, like listChanges.
//   After publish, publishSet, unpublish, undo, undoSet or discardOrphanEdits
//   has succeeded (200, not a dry run), kickSearchReindex()
//   (lib/catalog/search-reindex.js) sends the products it changed to search:
//   a durable job plus an inline drain capped at SEARCH_REINDEX_TIMEOUT_MS. A
//   failure or timeout is logged there and never changes the answer: the
//   publish is already live.
//
// P6-OPEN (PUB-12): "Before you open your store".
//   storefront.publish  publish and publishSet take two TOP-LEVEL boolean
//                       modifiers beside revision: checkOpening and
//                       confirmOpen (publishSet's argument is an array, so a
//                       set-level choice can't ride on its items). Any other
//                       operation carrying either, or a value that is not a
//                       boolean, is 400 MALFORMED. They reach
//                       lib/documents/publish.js as they are.
//   storefront.read     openingChecks { openingChecks: { ids } } (ids: the
//                       set the editor would publish, 0 to 200 document ids;
//                       or true for none): lib/documents/opening.js
//                       openingReport, a read that never writes. Checks the
//                       mode itself, like listChanges.
import { requireAdmin } from "../admin-auth.js";
import { roleAllows } from "../platform/authz.js";
import { audit } from "../platform/audit.js";
import { failure } from "../cms/issues.js";
import { getCmsMode } from "../cms-mode.js";
import { captureError } from "../errors.js";
import { slog } from "../log.js";
import { tenantId } from "../tenant-context.js";
import * as Docs from "../documents/service.js";
import * as PublishModule from "../documents/publish.js";
import * as UndoModule from "../documents/undo.js";
import * as ChangesModule from "../documents/changes.js";
import { listProductContent, LIST_FILTERS, LIST_LIMIT, decodeListCursor } from "./product-content-list.js";
import { kickSearchReindex } from "../catalog/search-reindex.js";
import * as OpeningModule from "../documents/opening.js";

// The modules the dispatcher calls. Tests only: setDocumentsApiModules swaps
// one for a spy (to see what reaches it); production never calls it.
const modules = { Publish: PublishModule, Undo: UndoModule, Changes: ChangesModule, Opening: OpeningModule };
const DEFAULT_MODULES = { ...modules };
export function setDocumentsApiModules(m = {}) {
  Object.assign(modules, DEFAULT_MODULES, m || {});
}

// P3-COMMIT: the two new reads check the mode themselves (MODE_READS).
const MODE_READS = new Set(["listRecentlyPublished", "listChanges", "listProductContent", "openingChecks"]);
const READS = new Set(["getDocument", "listDocuments", "listHistory", ...MODE_READS]);
// Phase 0 line 2: every read op, so scripts/test-permissions.js can want a row for each
export const DOCUMENT_READS = Object.freeze([...READS]);
// P2-PUBLISH: publish and publishSet are writes too (the mode check), but
// need storefront.publish, which staff don't have. P3-COMMIT: so do
// unpublish, undo and undoSet.
const PUBLISHES = new Set(["publish", "publishSet", "unpublish", "undo", "undoSet", "discardOrphanEdits"]);
const WRITES = new Set(["createDocument", "saveDraft", "discardDraft", "restoreVersion", "archive", "keepLiveSection", "keepAsEarlierDraft", "openEntityContent", "resolveShopifyChange", ...PUBLISHES]);
const NEEDS_REVISION = new Set(["saveDraft", "discardDraft", "restoreVersion", "archive", "keepLiveSection", "resolveShopifyChange"]);
// P3-COMMIT: publish-shaped operations that name the revision they started from
const PUBLISH_NEEDS_REVISION = new Set(["unpublish", "undo", "discardOrphanEdits"]);
// P3-COMMIT: handed the whole op; their { status, body } is sent as it is
const PASS_THROUGH = {
  unpublish: ["Undo", "unpublish"],
  undo: ["Undo", "undo"],
  undoSet: ["Undo", "undoSet"],
  listRecentlyPublished: ["Undo", "listRecentlyPublished"],
  listChanges: ["Changes", "listChanges"],
  keepLiveSection: ["Changes", "keepLiveSection"],
  keepAsEarlierDraft: ["Changes", "keepAsEarlierDraft"],
};
const MODIFIERS = new Set(["revision", "checkOpening", "confirmOpen"]);
// P6-OPEN: the set-level choices, on publish and publishSet only
const OPENING_FLAGS = ["checkOpening", "confirmOpen"];
const TAKES_OPENING_FLAGS = new Set(["publish", "publishSet"]);
export const OPENING_IDS_CAP = 200;
export const RECENT_LIMIT = { min: 1, max: 50, default: 20 };

const UNREADABLE = "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.";
const UNREADABLE_PUBLISH = "The editor sent something we couldn't read, so nothing was published. Reload the page and try again.";
// P3-COMMIT: what getDocument and listDocuments say about publishing
export const STAFF_CANNOT_PUBLISH = "Only the store owner or an admin can publish. You can edit and preview.";
export const READ_ONLY_CANNOT_PUBLISH = "Only the store owner or an admin can publish.";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
const isOptBool = (v) => v === undefined || v === null || typeof v === "boolean";

// body -> { op } | { error, code }
export function parseDocumentsOperation(body) {
  if (!isObj(body)) return { error: UNREADABLE, code: "NO_OPERATION" };
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  const unknown = keys.filter((k) => !READS.has(k) && !WRITES.has(k) && !MODIFIERS.has(k));
  if (unknown.length) return { error: UNREADABLE, code: "UNKNOWN_OPERATION" };
  const ops = keys.filter((k) => READS.has(k) || WRITES.has(k));
  if (ops.length === 0) return { error: UNREADABLE, code: "NO_OPERATION" };
  if (ops.length > 1) return { error: UNREADABLE, code: "AMBIGUOUS_OPERATION" };
  const kind = ops[0];
  const arg = body[kind];
  const hasRevision = body.revision !== undefined && body.revision !== null;
  if (hasRevision && !Number.isInteger(body.revision)) return { error: PUBLISHES.has(kind) ? UNREADABLE_PUBLISH : UNREADABLE, code: "MALFORMED" };
  const op = { kind, hasRevision, revision: hasRevision ? body.revision : null };
  const bad = { error: PUBLISHES.has(kind) ? UNREADABLE_PUBLISH : UNREADABLE, code: "MALFORMED" };
  // P6-OPEN: checkOpening and confirmOpen, booleans, on publish and publishSet only
  for (const f of OPENING_FLAGS) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    if (!TAKES_OPENING_FLAGS.has(kind) || typeof v !== "boolean") return bad;
  }
  if (TAKES_OPENING_FLAGS.has(kind)) Object.assign(op, { checkOpening: body.checkOpening === true, confirmOpen: body.confirmOpen === true });
  switch (kind) {
    case "getDocument":
    case "listHistory":
    case "discardDraft":
    case "archive":
      if (isId(arg)) op.id = arg;
      else if (isObj(arg) && isId(arg.id)) op.id = arg.id;
      else return bad;
      break;
    case "listDocuments":
      if (arg === true) break;
      if (!isObj(arg)) return bad;
      if (arg.type != null && typeof arg.type !== "string") return bad;
      op.type = arg.type ?? null;
      op.includeArchived = arg.includeArchived === true;
      break;
    case "createDocument":
      if (!isObj(arg) || typeof arg.type !== "string") return bad;
      if (arg.meta != null && !isObj(arg.meta)) return bad;
      if (arg.body != null && !isObj(arg.body)) return bad;
      if (arg.entityId != null && typeof arg.entityId !== "string") return bad;
      Object.assign(op, { type: arg.type, meta: arg.meta ?? null, body: arg.body ?? null, entityId: arg.entityId ?? null });
      break;
    case "saveDraft":
      if (!isObj(arg) || !isId(arg.id) || !isObj(arg.body)) return bad;
      Object.assign(op, { id: arg.id, body: arg.body });
      break;
    case "restoreVersion":
      if (!isObj(arg) || !isId(arg.id) || !isId(arg.versionId)) return bad;
      Object.assign(op, { id: arg.id, versionId: arg.versionId });
      break;
    // P2-PUBLISH. publish: { publish: { id, draftHash }, revision }.
    // publishSet: { publishSet: [{ id, revision, draftHash }, …] } (each
    // document names its own revision, so a top-level one is refused).
    // A missing revision or draftHash is a 428 after authorization.
    // P3-COMMIT: confirmRepublish: true (P3-CHECKS' republish confirm)
    case "publish":
      if (!isObj(arg) || !isId(arg.id)) return bad;
      if (arg.draftHash != null && typeof arg.draftHash !== "string") return bad;
      if (!isOptBool(arg.confirmRepublish)) return bad;
      Object.assign(op, { id: arg.id, draftHash: arg.draftHash ?? null, confirmRepublish: arg.confirmRepublish === true });
      break;
    case "publishSet": {
      if (!Array.isArray(arg) || hasRevision) return bad;
      const items = [];
      for (const it of arg) {
        if (!isObj(it) || !isId(it.id)) return bad;
        if (it.revision != null && !Number.isInteger(it.revision)) return bad;
        if (it.draftHash != null && typeof it.draftHash !== "string") return bad;
        if (!isOptBool(it.confirmRepublish)) return bad;
        items.push({ id: it.id, revision: it.revision ?? null, draftHash: it.draftHash ?? null, confirmRepublish: it.confirmRepublish === true });
      }
      op.items = items;
      break;
    }
    // ---- P3-COMMIT: the phase 3 operations ----
    case "unpublish":
      if (!isObj(arg) || !isId(arg.id) || !isOptBool(arg.dryRun)) return bad;
      Object.assign(op, { id: arg.id, dryRun: arg.dryRun === true });
      break;
    case "undo":
      if (!isObj(arg) || !isId(arg.id) || !isId(arg.logId) || !isOptBool(arg.dryRun)) return bad;
      Object.assign(op, { id: arg.id, logId: arg.logId, dryRun: arg.dryRun === true });
      break;
    case "undoSet": {
      // each member's current revision is read and guarded by Undo itself
      if (hasRevision || !isObj(arg) || !isId(arg.setId) || !Array.isArray(arg.members) || !arg.members.length || arg.members.length > 200 || !isOptBool(arg.dryRun)) return bad;
      const members = [];
      const seen = new Set();
      for (const m of arg.members) {
        if (!isObj(m) || !isId(m.id) || !isId(m.logId) || seen.has(m.id)) return bad;
        seen.add(m.id);
        members.push({ id: m.id, logId: m.logId });
      }
      Object.assign(op, { setId: arg.setId, members, dryRun: arg.dryRun === true });
      break;
    }
    case "listRecentlyPublished": {
      if (hasRevision) return bad;
      if (arg === true) {
        op.limit = RECENT_LIMIT.default;
        break;
      }
      if (!isObj(arg)) return bad;
      if (arg.limit != null && !(Number.isInteger(arg.limit) && arg.limit >= RECENT_LIMIT.min && arg.limit <= RECENT_LIMIT.max)) return bad;
      op.limit = arg.limit ?? RECENT_LIMIT.default;
      break;
    }
    case "listChanges":
      if (hasRevision) return bad;
      if (isId(arg)) op.id = arg;
      else if (isObj(arg) && isId(arg.id)) op.id = arg.id;
      else return bad;
      break;
    case "keepLiveSection":
      if (!isObj(arg) || !isId(arg.id) || !isId(arg.sectionId)) return bad;
      Object.assign(op, { id: arg.id, sectionId: arg.sectionId });
      break;
    // ---- P4-SEARCH ----
    case "listProductContent": {
      if (hasRevision) return bad;
      if (arg === true) {
        Object.assign(op, { q: "", filter: "all", cursor: null, limit: LIST_LIMIT.default });
        break;
      }
      if (!isObj(arg)) return bad;
      if (arg.q != null && (typeof arg.q !== "string" || arg.q.length > 200)) return bad;
      if (arg.filter != null && !LIST_FILTERS.includes(arg.filter)) return bad;
      if (arg.cursor != null && (typeof arg.cursor !== "string" || !decodeListCursor(arg.cursor))) return bad;
      if (arg.limit != null && !(Number.isInteger(arg.limit) && arg.limit >= LIST_LIMIT.min && arg.limit <= LIST_LIMIT.max)) return bad;
      Object.assign(op, { q: arg.q ?? "", filter: arg.filter ?? "all", cursor: arg.cursor ?? null, limit: arg.limit ?? LIST_LIMIT.default });
      break;
    }
    // ---- P6-OPEN ----
    case "openingChecks": {
      if (hasRevision) return bad;
      if (arg === true) {
        op.ids = [];
        break;
      }
      if (!isObj(arg) || !Array.isArray(arg.ids) || arg.ids.length > OPENING_IDS_CAP || !arg.ids.every(isId)) return bad;
      op.ids = [...new Set(arg.ids)];
      break;
    }
    // ---- P4-LIVEROW ----
    case "openEntityContent":
      if (hasRevision || !isObj(arg) || (arg.type !== "product_content" && arg.type !== "collection_content") || !isId(arg.entityId)) return bad;
      Object.assign(op, { type: arg.type, entityId: arg.entityId });
      break;
    case "resolveShopifyChange":
      if (!isObj(arg) || !isId(arg.id) || typeof arg.field !== "string" || (arg.choice !== "keep" && arg.choice !== "shopify")) return bad;
      Object.assign(op, { id: arg.id, field: arg.field, choice: arg.choice });
      break;
    case "discardOrphanEdits":
      if (isId(arg)) op.id = arg;
      else if (isObj(arg) && isId(arg.id)) op.id = arg.id;
      else return bad;
      break;
    case "keepAsEarlierDraft":
      // no revision: the draft, revision and hash never change
      if (hasRevision || !isObj(arg) || !isId(arg.id) || !isObj(arg.body)) return bad;
      // P3-FIX5: from "backup" (the local backup offer), else left out
      if (arg.from !== undefined && arg.from !== "backup") return bad;
      Object.assign(op, { id: arg.id, body: arg.body, ...(arg.from === "backup" ? { from: "backup" } : {}) });
      break;
  }
  return { op };
}

const DOING = (kind) => (READS.has(kind) ? "load" : PUBLISHES.has(kind) ? "publish" : "save");

async function failed(e, op) {
  if (e instanceof Docs.DocumentError) return { status: e.status, body: { error: e.message, code: e.code, ...e.extra } };
  const f = failure(e, { doing: DOING(op.kind) });
  if (f.status >= 500 || f.kind === "conflict") {
    slog("documents_api_failure", { op: op.kind, status: f.status, code: f.body.code, error: String(e?.message || e).slice(0, 300) });
    if (f.kind === "internal") await captureError({ source: "documents-api", error: e, extra: { op: op.kind } });
  }
  return { status: f.status, body: f.body };
}

// P3-COMMIT: what this actor may do with a document (getDocument, listDocuments)
function accessOf(actor) {
  const canPublish = roleAllows(actor?.role, "storefront.publish");
  if (canPublish) return { canPublish: true, reason: null };
  return { canPublish: false, reason: actor?.role === "staff" ? STAFF_CANNOT_PUBLISH : READ_ONLY_CANNOT_PUBLISH };
}

// P4-SEARCH (OVL-17): after a publish-shaped answer went live, its products
// go to search. Never changes the answer (kickSearchReindex never throws).
const REINDEXES = new Set(["publish", "publishSet", "unpublish", "undo", "undoSet", "discardOrphanEdits"]);
async function afterLive(op, res) {
  if (REINDEXES.has(op.kind) && res?.status === 200 && !op.dryRun) {
    try {
      await kickSearchReindex();
    } catch {
      /* never: kickSearchReindex logs its own failures */
    }
  }
  return res;
}

export async function handleDocumentsPut(request) {
  const body = await request.json().catch(() => undefined);
  const parsed = parseDocumentsOperation(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error, code: parsed.code } };
  const op = parsed.op;
  return afterLive(op, await handleOperation(request, op));
}

async function handleOperation(request, op) {
  const write = WRITES.has(op.kind);

  let auth;
  try {
    auth = await requireAdmin(request, PUBLISHES.has(op.kind) ? "storefront.publish" : write ? "storefront.write" : "storefront.read");
  } catch (e) {
    return failed(e, op); // a session lookup that failed is ours, not a 401
  }
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  // 500 STORE_MODE_INVALID (or a 5xx when the mode can't be read)
  if (MODE_READS.has(op.kind) || write) {
    try {
      await getCmsMode();
    } catch (e) {
      return failed(e, op);
    }
  }

  if (write) {
    if (NEEDS_REVISION.has(op.kind) && !op.hasRevision) {
      return { status: 428, body: { error: "The editor didn't say which version you started from, so nothing was saved. Reload the page and try again.", code: "REVISION_REQUIRED" } };
    }
    if (PUBLISH_NEEDS_REVISION.has(op.kind) && !op.hasRevision) {
      return { status: 428, body: { error: "The editor didn't say which version you started from, so nothing was published. Reload the page and try again.", code: "REVISION_REQUIRED" } };
    }
    if (op.kind === "publish" || op.kind === "publishSet") {
      const items = op.kind === "publish" ? [{ revision: op.hasRevision ? op.revision : null, draftHash: op.draftHash }] : op.items;
      if (items.some((it) => it.revision == null)) {
        return { status: 428, body: { error: "The editor didn't say which version you started from, so nothing was published. Reload the page and try again.", code: "REVISION_REQUIRED" } };
      }
      if (items.some((it) => !it.draftHash)) {
        return { status: 428, body: { error: "The editor didn't say which changes you reviewed, so nothing was published. Reload the page and try again.", code: "REVIEW_REQUIRED" } };
      }
    }
  }

  const actor = auth.actor;
  try {
    switch (op.kind) {
      case "getDocument": {
        const access = accessOf(actor);
        return { status: 200, body: { ok: true, document: { ...Docs.publicDocument(await Docs.getDocument(op.id)), access } } };
      }
      case "listDocuments": {
        const access = accessOf(actor);
        const documents = (await Docs.listDocuments({ type: op.type ?? null, includeArchived: !!op.includeArchived })).map((d) => ({ ...d, access }));
        return { status: 200, body: { ok: true, documents } };
      }
      case "listHistory":
        return { status: 200, body: { ok: true, versions: await Docs.listHistory(op.id, { tenant: tenantId() }) } };
      // P4-SEARCH: the editor's product list
      case "listProductContent": {
        const r = await listProductContent({ q: op.q, filter: op.filter, cursor: op.cursor, limit: op.limit });
        return { status: 200, body: { ok: true, items: r.items, nextCursor: r.nextCursor, counts: r.counts } };
      }
      // P6-OPEN: "Before you open your store" (a read: it never writes)
      case "openingChecks": {
        const r = await modules.Opening.openingReport({ setIds: op.ids });
        return { status: 200, body: { ok: true, opening: r.opening, items: r.items, offer: r.offer } };
      }
    }
    if (Object.hasOwn(PASS_THROUGH, op.kind)) {
      const [mod, fn] = PASS_THROUGH[op.kind];
      return await modules[mod][fn](op, { actor });
    }
    if (op.kind === "publish" || op.kind === "publishSet") {
      const ids = op.kind === "publish" ? [{ id: op.id, revision: op.revision, draftHash: op.draftHash, confirmRepublish: op.confirmRepublish }] : op.items;
      const p = await modules.Publish.publish({ ids, actor, checkOpening: op.checkOpening === true, confirmOpen: op.confirmOpen === true });
      slog("documents_publish_api", { op: op.kind, release: p.release?.id ?? null, published: p.published.length, skipped: p.skipped.length });
      if (p.release || p.setId) {
        // P4-LIVEROW: a set of only product and collection content has no release
        await audit({ actor, action: "storefront.publish", resource: p.release ? `release:${p.release.id}` : `set:${p.setId}`, diff: { op: op.kind, set: p.setId, documents: p.published.map((d) => d.id) } }); // best-effort, never throws
      }
      return { status: 200, body: { ok: true, release: p.release, setId: p.setId, published: p.published, skipped: p.skipped, issues: p.issues } };
    }
    // ---- P4-LIVEROW ----
    if (op.kind === "openEntityContent") {
      const o = await Docs.openEntityContent({ type: op.type, entityId: op.entityId, actor });
      if (o.created || o.unarchived) {
        slog("documents_open_entity", { op: op.kind, document: o.document.id, revision: o.document.revision, created: o.created, unarchived: o.unarchived });
        await audit({ actor, action: "storefront.write", resource: `document:${o.document.id}`, diff: { op: op.kind, created: o.created, unarchived: o.unarchived } }); // best-effort, never throws
      }
      return { status: 200, body: { ok: true, ...o } };
    }
    if (op.kind === "discardOrphanEdits") {
      const o = await Docs.discardOrphanEdits({ id: op.id, revision: op.revision, actor });
      slog("documents_discard_orphan", { document: o.document.id, removedLive: o.removedLive });
      await audit({ actor, action: "storefront.publish", resource: `document:${o.document.id}`, diff: { op: op.kind, removedLive: o.removedLive } }); // best-effort, never throws
      return { status: 200, body: { ok: true, message: "The edits are gone. This product is no longer in Shopify, so nothing of it shows on your store.", document: Docs.publicDocument(o.document) } };
    }
    let r;
    if (op.kind === "createDocument") r = await Docs.createDocument({ type: op.type, meta: op.meta, body: op.body, entityId: op.entityId, actor });
    else if (op.kind === "saveDraft") r = await Docs.saveDraft({ id: op.id, revision: op.revision, body: op.body, actor });
    else if (op.kind === "discardDraft") r = await Docs.discardDraft({ id: op.id, revision: op.revision, actor });
    else if (op.kind === "restoreVersion") r = await Docs.restoreVersion({ id: op.id, versionId: op.versionId, revision: op.revision, actor });
    else if (op.kind === "archive") r = await Docs.archive({ id: op.id, revision: op.revision, actor });
    else if (op.kind === "resolveShopifyChange") r = await Docs.resolveShopifyChange({ id: op.id, revision: op.revision, field: op.field, choice: op.choice, actor });
    slog("documents_write", { op: op.kind, document: r.document.id, revision: r.document.revision });
    await audit({ actor, action: "storefront.write", resource: `document:${r.document.id}`, diff: { op: op.kind, revision: r.document.revision } }); // best-effort, never throws
    return { status: 200, body: { ok: true, document: Docs.publicDocument(r.document), issues: r.issues || [] } };
  } catch (e) {
    return failed(e, op);
  }
}
