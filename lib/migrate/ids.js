// P4-MAPPER (MIG-01): the ids and hashes the backfill writes. Pure and
// edge-safe: Web Crypto only, no node: imports. Every function is ASYNC (it
// returns a Promise), because Web Crypto's digest is.
//
//   sha256Hex(text)                     the full SHA-256 of a string, as hex
//   migratedVersionId(documentId, body) ver_<16 hex of sha256(documentId +
//                                       bodyHash(body))>: content-addressed, so
//                                       the same id always means the same body
//                                       of the same document, and a re-run (or
//                                       a rehearsal) mints the very same id.
//                                       ON CONFLICT(id) DO NOTHING is exact for
//                                       these rows (plan decision 7).
//   migratedVersion(documentId, body)   { id, bodyHash } in one call
//   migratedReleaseId(list)             rel_mig_<16 hex of the list's hash>
//   draftHash(body), publishedHash(body)
//                                       documentHash: the canonical body with
//                                       section and block ids stripped, the
//                                       rule documents.draft_hash and
//                                       published_hash already follow. So a
//                                       store whose drafts equal what is live
//                                       maps to no dirty document at all, even
//                                       where an old live snapshot had no ids.
//
// bodyHash (ids KEPT) is lib/documents/versions.js's integrity hash; it is
// what a release list entry carries as `hash` (lib/documents/build.js
// makeBuild). It is recomputed here with the same canonical form instead of
// imported, because versions.js reaches the control plane (Node only).
import { stableStringify, documentHash } from "../registry/index.js";
import { listHash } from "../documents/release-list.js";

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return hex(new Uint8Array(digest));
}

// The integrity hash of a version body, ids kept (document_versions.body_hash).
export const bodyHash = (body) => sha256Hex(stableStringify(body));

const docIdOk = (id) => typeof id === "string" && /^doc_[a-z0-9_]{1,80}$/.test(id);

export async function migratedVersion(documentId, body) {
  if (!docIdOk(documentId)) throw new Error(`migratedVersion: "${String(documentId).slice(0, 60)}" is not a document id`);
  const h = await bodyHash(body);
  return { id: `ver_${(await sha256Hex(documentId + h)).slice(0, 16)}`, bodyHash: h };
}

export async function migratedVersionId(documentId, body) {
  return (await migratedVersion(documentId, body)).id;
}

// The release a cutover writes for this exact list. lib/releases.js's
// sha256Hex is Web Crypto too; listHash is the release hash of the list.
export async function migratedReleaseId(list) {
  return `rel_mig_${(await listHash(list)).slice(0, 16)}`;
}

export const draftHash = (body) => documentHash(body);
export const publishedHash = (body) => documentHash(body);
