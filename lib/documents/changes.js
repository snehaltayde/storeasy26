// P3-COMMIT stub; P3-CHANGES (batch 2) replaces the bodies, and P3-DESIGN
// (batch 4) adds the design rows. Node console routes only. Every function
// answers 501 NOT_BUILT (NotBuiltError) until then.
//
// Called by lib/admin/documents-api.js after parse (400), authorize (401/403),
// mode (409 STORE_USES_LEGACY) and, for keepLiveSection, 428. Each is handed
// the whole parsed operation and returns { status, body }, which the
// dispatcher sends as it is. The shapes are lib/admin/documents-api-shapes.js
// (SHAPES.listChanges, keepLiveSection, keepAsEarlierDraft); copied here so
// the owner starts from them.
//
//   listChanges(op, { actor })                         storefront.read
//     op: { kind: "listChanges", id }
//     request { listChanges: { id } }
//     200 { ok, firstPublish: false, rows: [{ kind, sectionId?, words,
//           affects?: [{words}] }] }
//     200 { ok, firstPublish: true, sections: [{words}] }
//     404 NOT_FOUND (the dispatcher already answered 409 STORE_USES_LEGACY on
//     a legacy or migrating store)
//
//   keepLiveSection(op, { actor })                     storefront.write
//     op: { kind: "keepLiveSection", id, sectionId, hasRevision, revision }
//     request { keepLiveSection: { id, sectionId }, revision }
//     200 { ok, document }
//     409 DOCUMENT_CHANGED (current) | DOCUMENT_ARCHIVED, 404, 422
//
//   keepAsEarlierDraft(op, { actor })                  storefront.write
//     op: { kind: "keepAsEarlierDraft", id, body }   (no revision)
//     request { keepAsEarlierDraft: { id, body } }
//     200 { ok, savedVersion: { id, note } }
//     409 TOO_MANY_KEPT, 404, 422
import { NotBuiltError } from "./build.js";

export async function listChanges(_op, _ctx = {}) {
  throw new NotBuiltError();
}

export async function keepLiveSection(_op, _ctx = {}) {
  throw new NotBuiltError();
}

export async function keepAsEarlierDraft(_op, _ctx = {}) {
  throw new NotBuiltError();
}
