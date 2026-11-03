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
//   409 STORE_USES_LEGACY   unless cms_state.mode is 'documents' (plan decision
//                           13): a store on today's editor keeps its data there.
//                           Checked before the revision, so the editor hears
//                           the real reason first. A mode that can't be read
//                           is a 5xx, never a go-ahead.
//   428 REVISION_REQUIRED   saveDraft, discardDraft, restoreVersion and archive
//                           must name the revision they started from
// Then: 409 with the current document (stale), 409 SLUG_TAKEN, 404, 422 with
// every issue (validationBody), and 5xx with a code for anything that isn't
// the founder's (failure()).
//
// Publishing (publish, publishSet, unpublish, undo, schedule) is P2-PUBLISH's.
import { requireAdmin } from "../admin-auth.js";
import { audit } from "../platform/audit.js";
import { failure } from "../cms/issues.js";
import { getCmsMode } from "../cms-mode.js";
import { captureError } from "../errors.js";
import { slog } from "../log.js";
import { tenantId } from "../tenant-context.js";
import * as Docs from "../documents/service.js";

const READS = new Set(["getDocument", "listDocuments", "listHistory"]);
const WRITES = new Set(["createDocument", "saveDraft", "discardDraft", "restoreVersion", "archive"]);
const NEEDS_REVISION = new Set(["saveDraft", "discardDraft", "restoreVersion", "archive"]);
const MODIFIERS = new Set(["revision"]);

const UNREADABLE = "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;

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
  if (hasRevision && !Number.isInteger(body.revision)) return { error: UNREADABLE, code: "MALFORMED" };
  const op = { kind, hasRevision, revision: hasRevision ? body.revision : null };
  const bad = { error: UNREADABLE, code: "MALFORMED" };
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
  }
  return { op };
}

const DOING = (kind) => (READS.has(kind) ? "load" : "save");

async function failed(e, op) {
  if (e instanceof Docs.DocumentError) return { status: e.status, body: { error: e.message, code: e.code, ...e.extra } };
  const f = failure(e, { doing: DOING(op.kind) });
  if (f.status >= 500 || f.kind === "conflict") {
    slog("documents_api_failure", { op: op.kind, status: f.status, code: f.body.code, error: String(e?.message || e).slice(0, 300) });
    if (f.kind === "internal") await captureError({ source: "documents-api", error: e, extra: { op: op.kind } });
  }
  return { status: f.status, body: f.body };
}

const LEGACY = {
  status: 409,
  body: {
    error: "This store still uses the current Storefront editor, so nothing was saved here. Make this change in Storefront instead.",
    code: "STORE_USES_LEGACY",
  },
};

export async function handleDocumentsPut(request) {
  const body = await request.json().catch(() => undefined);
  const parsed = parseDocumentsOperation(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error, code: parsed.code } };
  const op = parsed.op;
  const write = WRITES.has(op.kind);

  let auth;
  try {
    auth = await requireAdmin(request, write ? "storefront.write" : "storefront.read");
  } catch (e) {
    return failed(e, op); // a session lookup that failed is ours, not a 401
  }
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  if (write) {
    let mode;
    try {
      mode = await getCmsMode();
    } catch (e) {
      return failed(e, op);
    }
    if (mode !== "documents") return LEGACY;
    if (NEEDS_REVISION.has(op.kind) && !op.hasRevision) {
      return { status: 428, body: { error: "The editor didn't say which version you started from, so nothing was saved. Reload the page and try again.", code: "REVISION_REQUIRED" } };
    }
  }

  const actor = auth.actor;
  try {
    switch (op.kind) {
      case "getDocument":
        return { status: 200, body: { ok: true, document: Docs.publicDocument(await Docs.getDocument(op.id)) } };
      case "listDocuments":
        return { status: 200, body: { ok: true, documents: await Docs.listDocuments({ type: op.type ?? null, includeArchived: !!op.includeArchived }) } };
      case "listHistory":
        return { status: 200, body: { ok: true, versions: await Docs.listHistory(op.id, { tenant: tenantId() }) } };
    }
    let r;
    if (op.kind === "createDocument") r = await Docs.createDocument({ type: op.type, meta: op.meta, body: op.body, entityId: op.entityId, actor });
    else if (op.kind === "saveDraft") r = await Docs.saveDraft({ id: op.id, revision: op.revision, body: op.body, actor });
    else if (op.kind === "discardDraft") r = await Docs.discardDraft({ id: op.id, revision: op.revision, actor });
    else if (op.kind === "restoreVersion") r = await Docs.restoreVersion({ id: op.id, versionId: op.versionId, revision: op.revision, actor });
    else if (op.kind === "archive") r = await Docs.archive({ id: op.id, revision: op.revision, actor });
    slog("documents_write", { op: op.kind, document: r.document.id, revision: r.document.revision });
    await audit({ actor, action: "storefront.write", resource: `document:${r.document.id}`, diff: { op: op.kind, revision: r.document.revision } }); // best-effort, never throws
    return { status: 200, body: { ok: true, document: Docs.publicDocument(r.document), issues: r.issues || [] } };
  } catch (e) {
    return failed(e, op);
  }
}
