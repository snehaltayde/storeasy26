// P2-DOCS (DOC-08): earlier versions of a document. Node console routes only
// (it reads the team's names from the control plane through lib/platform).
//
//   CHECKPOINT_CAP                 20 automatic checkpoints per document
//   checkpointInterval()           how often an autosave may add a checkpoint
//                                  (5 minutes; setCheckpointInterval(ms) is
//                                  for tests)
//   bodyHash(body)                 sha256 of the canonical body WITH its ids
//                                  (document_versions.body_hash, integrity)
//   versionStatement(v)            the INSERT for one version row
//   checkpointIfDueStatement(…)    an INSERT … SELECT that adds a checkpoint
//                                  only when this document has none newer than
//                                  the interval, so the decision is made inside
//                                  the save's own batch, with no extra read
//   pruneStatement(documentId)     deletes this document's oldest checkpoints
//                                  beyond 20, never one that publish_log names
//                                  (from, to or saved) or that a document row
//                                  points at
//   keptStatement(row)             P3-CHANGES: stores a kept draft (undo_saved,
//                                  note KEPT_NOTE) only under KEPT_CAP and only
//                                  when no undo_saved version has the same body
//   listVersions(documentId)       the "Earlier versions" list, newest first,
//                                  with plain names
//   plainName(createdBy, names)    "merchant:u_…" -> the person's name
//
// Kinds (spec 8.2): published, checkpoint, migrated, undo_saved. Only
// checkpoints count against the cap, and only checkpoints can be deleted (the
// document_versions_kept trigger of migration 0021 refuses the rest).
// Published versions are written by the publish commit (lib/documents/
// commit.js), never here.
import { libsql } from "../db.js";
import { stableStringify } from "../registry/index.js";
import { verId } from "./ids.js";
import { teamMemberNames } from "../platform/identity.js";
import { slog } from "../log.js";

export const CHECKPOINT_CAP = 20;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let intervalMs = DEFAULT_INTERVAL_MS;
export const checkpointInterval = () => intervalMs;
// Tests only: 0 makes every autosave write a checkpoint. null restores 5 minutes.
export function setCheckpointInterval(ms) {
  intervalMs = ms == null ? DEFAULT_INTERVAL_MS : Math.max(0, Number(ms) || 0);
}

export const VERSION_KINDS = Object.freeze(["published", "checkpoint", "migrated", "undo_saved"]);

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export async function bodyHash(body) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(body)));
  return hex(new Uint8Array(digest));
}

// One version row. `body` is stored as its canonical JSON.
export async function versionRow({ documentId, kind, body, schemaVersion, note = null, createdBy = null, createdAt, id = verId() }) {
  if (!VERSION_KINDS.includes(kind)) throw new Error(`versionRow: unknown kind "${kind}"`);
  return { id, document_id: documentId, kind, body: stableStringify(body), body_hash: await bodyHash(body), schema_version: schemaVersion, note, created_by: createdBy, created_at: createdAt };
}

const COLS = "id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at";
const argsOf = (r) => [r.id, r.document_id, r.kind, r.body, r.body_hash, r.schema_version, r.note, r.created_by, r.created_at];

export const versionStatement = (row) => ({ sql: `INSERT INTO document_versions (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: argsOf(row) });

// A checkpoint, only when this document's newest checkpoint is older than the
// interval. With the interval at 0 every save adds one.
export function checkpointIfDueStatement(row) {
  const cutoff = new Date(Date.parse(row.created_at) - intervalMs).toISOString();
  return {
    sql:
      `INSERT INTO document_versions (${COLS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? ` +
      "WHERE NOT EXISTS (SELECT 1 FROM document_versions WHERE document_id = ? AND kind = 'checkpoint' AND created_at > ?)",
    args: [...argsOf(row), row.document_id, cutoff],
  };
}

// Keep at most CHECKPOINT_CAP checkpoints of one document. A checkpoint that
// publish_log names (as from, to or saved), or that a document row points at
// as published or undone, is never deleted: Undo and history walk those. It
// still counts against the cap, so the newest unreferenced checkpoints fill
// what is left of it. (Publish never points the log at a checkpoint, since it
// always mints a fresh published version, so in practice this is the newest
// 20.) Release lists only name published and migrated versions, which the
// document_versions_kept trigger already keeps.
// NOT EXISTS, not NOT IN: a NULL in a NOT IN list would make it match nothing.
// P2-DOCFIX: each check looks only at this document's own rows: publish_log
// through its publish_log_doc index (document_id), documents by primary key.
// P3-CHANGES: the document id is bound in every check (p.document_id = ? and
// d.id = ?), not taken from the outer row, so each lookup is a plain index
// probe on the one document whatever plan SQLite picks. A log row or a
// document row only ever names versions of its own document (commit.js
// writes them per document), so nothing that was kept before can be pruned
// now: the retention rules are unchanged.
const KEPT =
  "(EXISTS (SELECT 1 FROM publish_log p WHERE p.document_id = ? AND (p.from_version_id = v.id OR p.to_version_id = v.id OR p.saved_version_id = v.id)) " +
  "OR EXISTS (SELECT 1 FROM documents d WHERE d.id = ? AND (d.published_version_id = v.id OR d.undone_version_id = v.id)))";
export const pruneStatement = (documentId) => {
  const d = documentId;
  return {
    sql:
      "DELETE FROM document_versions WHERE id IN (" +
      `SELECT v.id FROM document_versions v WHERE v.document_id = ? AND v.kind = 'checkpoint' AND NOT ${KEPT} ` +
      "AND v.id NOT IN (" +
      `SELECT v.id FROM document_versions v WHERE v.document_id = ? AND v.kind = 'checkpoint' AND NOT ${KEPT} ORDER BY v.created_at DESC, v.rowid DESC ` +
      `LIMIT max(0, ? - (SELECT count(*) FROM document_versions v WHERE v.document_id = ? AND v.kind = 'checkpoint' AND ${KEPT}))))`,
    args: [d, d, d, d, d, d, CHECKPOINT_CAP, d, d, d],
  };
};

// ---- kept drafts (P3-CHANGES, keepAsEarlierDraft) ---------------------------------------

export const KEPT_NOTE = "Kept from another tab";
// P3-FIX5: a kept draft that came from the editor's local backup (edits this
// browser kept after a save never arrived), not from another tab. Both count
// toward KEPT_CAP.
export const BACKUP_NOTE = "Edits this browser kept";
export const KEPT_CAP = 10;
const KEPT_NOTES_IN = "note IN (?, ?)";

// The undo_saved versions of one document, for the dedupe by documentHash.
export async function undoSavedBodies(documentId) {
  const r = await libsql.execute({
    sql: "SELECT id, note, body FROM document_versions WHERE document_id = ? AND kind = 'undo_saved' ORDER BY created_at DESC, rowid DESC",
    args: [documentId],
  });
  const kept = (v) => ({ id: String(v.id), note: v.note == null ? null : String(v.note), body: JSON.parse(String(v.body)) });
  return r.rows.map(kept);
}

export async function keptCount(documentId) {
  const r = await libsql.execute({ sql: `SELECT count(*) AS n FROM document_versions WHERE document_id = ? AND ${KEPT_NOTES_IN}`, args: [documentId, KEPT_NOTE, BACKUP_NOTE] });
  return Number(r.rows[0]?.n ?? 0);
}

// One INSERT that stores a kept draft only while the document has fewer than
// KEPT_CAP of them and no undo_saved version with this very body (body_hash,
// ids included). The cap is decided inside the statement, so two tabs keeping
// at the same moment can't pass it, and a statement lib/db.js resends after a
// lost answer adds nothing.
export function keptStatement(row) {
  return {
    sql:
      `INSERT INTO document_versions (${COLS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? ` +
      `WHERE (SELECT count(*) FROM document_versions WHERE document_id = ? AND ${KEPT_NOTES_IN}) < ? ` +
      "AND NOT EXISTS (SELECT 1 FROM document_versions WHERE document_id = ? AND kind = 'undo_saved' AND body_hash = ?)",
    args: [...argsOf(row), row.document_id, KEPT_NOTE, BACKUP_NOTE, KEPT_CAP, row.document_id, row.body_hash],
  };
}

export async function versionExists(documentId, versionId) {
  const r = await libsql.execute({ sql: "SELECT note FROM document_versions WHERE id = ? AND document_id = ?", args: [versionId, documentId] });
  return r.rows[0] ? { id: versionId, note: r.rows[0].note == null ? null : String(r.rows[0].note) } : null;
}

// ---- names ------------------------------------------------------------------------

export const SOMEONE = "Someone on your team";
export const STOREASY = "Storeasy";

// created_by is "<actor kind>:<actor id>" (lib/admin-auth.js actors). Never
// shown raw: a merchant gets their name from the team list (never an email), anyone
// else on the store's side "Someone on your team", and our own people and
// automatic writers "Storeasy".
export function plainName(createdBy, names) {
  const s = typeof createdBy === "string" ? createdBy : "";
  if (!s) return STOREASY;
  const at = s.indexOf(":");
  const kind = at < 0 ? s : s.slice(0, at);
  const id = at < 0 ? "" : s.slice(at + 1);
  if (kind === "merchant") return (names && id && names.get(id)) || SOMEONE;
  if (kind === "operator" || kind === "operator-support" || kind === "system" || kind === "cli") return STOREASY;
  return SOMEONE;
}

// The team's names for one store. A control plane that can't be read gives
// the fallbacks (logged), never a failed history list.
export async function namesFor(tenant) {
  try {
    return await teamMemberNames(tenant);
  } catch (e) {
    slog("documents_team_names_failed", { error: String(e?.message || e).slice(0, 200) });
    return new Map();
  }
}

export async function listVersions(documentId, { tenant, publishedVersionId = null, limit = 100 } = {}) {
  const r = await libsql.execute({
    sql: "SELECT id, kind, note, created_by, created_at, body_hash FROM document_versions WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    args: [documentId, Math.max(1, Math.min(500, Number(limit) || 100))],
  });
  const names = await namesFor(tenant);
  return r.rows.map((v) => ({
    id: String(v.id),
    kind: String(v.kind),
    createdAt: String(v.created_at),
    by: plainName(v.created_by, names),
    note: v.note == null ? null : String(v.note),
    live: v.id === publishedVersionId,
  }));
}

export async function getVersion(documentId, versionId) {
  const r = await libsql.execute({ sql: "SELECT id, document_id, kind, body, schema_version, created_at FROM document_versions WHERE id = ? AND document_id = ?", args: [versionId, documentId] });
  const v = r.rows[0];
  if (!v) return null;
  return { id: String(v.id), documentId: String(v.document_id), kind: String(v.kind), body: JSON.parse(String(v.body)), schemaVersion: Number(v.schema_version), createdAt: String(v.created_at) };
}
