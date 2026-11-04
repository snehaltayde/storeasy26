// P3-COMMIT stub; P3-UNDO (batch 2) replaces the bodies. Node console routes
// only. Every function answers 501 NOT_BUILT (NotBuiltError) until then.
//
// Called by lib/admin/documents-api.js after parse (400), authorize
// storefront.publish (401/403), mode (409 STORE_USES_LEGACY) and 428. Each is
// handed the whole parsed operation and returns { status, body }, which the
// dispatcher sends as it is (so no batch 2 item edits documents-api.js).
// The shapes are lib/admin/documents-api-shapes.js (SHAPES.undo, undoSet,
// unpublish, listRecentlyPublished); copied here so the owner starts from them.
//
//   undo(op, { actor })
//     op: { kind: "undo", id, logId, dryRun, hasRevision, revision }
//     request { undo: { id, logId, dryRun? }, revision }
//     200 { ok, message, savedVersion?: { id, where: "Earlier versions" },
//           liveUrl, document }
//     200 { ok, nothing: true, message, liveUrl: null, document }
//     200 dryRun { ok, willTakeOffline, linkers: [{id, label}],
//                  changes: [{words}], target: {versionId, name} | null }
//     409 PUBLISHED_ELSEWHERE | DOCUMENT_CHANGED (current) | SLUG_TAKEN
//         (slug, other {id, title, label}) | PUBLISH_NOT_AVAILABLE (document)
//     503 PUBLISH_UNKNOWN | PUBLISH_BUSY, 500 PUBLISH_FAILED, 404 NOT_FOUND
//
//   undoSet(op, { actor })
//     op: { kind: "undoSet", setId, members: [{ id, logId }], dryRun }
//     request { undoSet: { setId, members: [{ id, logId }], dryRun? } }
//     200 { ok, message, documents: [document] }
//     200 dryRun (as undo, target null)
//     409 PUBLISHED_ELSEWHERE | DOCUMENT_CHANGED, 503, 500, 404
//
//   unpublish(op, { actor })
//     op: { kind: "unpublish", id, dryRun, hasRevision, revision }
//     request { unpublish: { id, dryRun? }, revision }
//     200 { ok, message, document }   (live false, undoneVersionId set)
//     200 dryRun { …, willTakeOffline: true, target: null }
//     409 CANNOT_TAKE_OFFLINE | DOCUMENT_CHANGED | PUBLISHED_ELSEWHERE, 503,
//         500, 404
//
//   listRecentlyPublished(op, { actor })
//     op: { kind: "listRecentlyPublished", limit }   (1..50, default 20)
//     200 { ok, rows: [{ logId, setId, documentId, label, action,
//           actionWords, byName, at, summary: [{words}], canUndo,
//           undo: {id, revision, logId} | null, note? }] }
//     (the dispatcher already answered 409 STORE_USES_LEGACY on a legacy or
//     migrating store)
//
// Building blocks: lib/documents/build.js (makeBuild with action, offline,
// draft, published, undone, expectPublished, extraVersions, undoesLogId,
// savedVersionId and note; runGuardedBuild; draftSlugOwner), refs.js
// (linkersStatement), paths.js (livePath, liveExitUrl).
import { NotBuiltError } from "./build.js";

export async function undo(_op, _ctx = {}) {
  throw new NotBuiltError();
}

export async function undoSet(_op, _ctx = {}) {
  throw new NotBuiltError();
}

export async function unpublish(_op, _ctx = {}) {
  throw new NotBuiltError();
}

export async function listRecentlyPublished(_op, _ctx = {}) {
  throw new NotBuiltError();
}
