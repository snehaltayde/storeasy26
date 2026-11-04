// P2-GUARD (PUB-01, DOC-02): which content system a store runs on, read fresh
// from the store's own database (cms_state, migration 0021). Edge-safe: no
// node: imports, only ./db.js and import-free or edge-safe helpers.
//
//   'legacy'     today's editors, releases and preview (every store in phase 2)
//   'migrating'  the move to documents is under way: old writes are paused
//   'documents'  the new editor owns the content; old writers must refuse
//
// Rules:
// - Read on every call, never cached. Control-plane config is cached per
//   instance and could not lock old writes (spec 8.11), so neither may this.
// - A missing cms_state table means a store from before 0021: legacy.
// - A table with no row means nothing has set a mode: legacy. The migration
//   seeds the row, and "_default reads as legacy unless its own row says
//   otherwise" (spec 8.11).
// - Any other read error is an infrastructure failure. It throws, so a write
//   is refused with a 5xx and never allowed on a guess.
//
// P4-GUARD (MIG-03): the pre-check above stays, for its nicer words, but it
// is no longer the lock. Every old content write now runs in ONE batch with
// legacyGuardStatement() in front (runLegacyBatch below), so a cutover that
// lands between the pre-check and the write aborts the write itself. The
// documents side and the migration tools get the same kind of guard
// (documentsGuardStatement, migratingGuardStatement). After an abort,
// classifyAbort re-reads the mode to tell a mode refusal from a lost pointer
// race (release_state has the same CHECK text).
import { libsql, currentDatabase } from "./db.js";
import { notMigratedYet } from "./schema-shape.js";
import { infraResponse } from "./infra-response.js";

export const CMS_MODES = Object.freeze(["legacy", "migrating", "documents"]);

// The plain line every console surface shows for a store on the new editor.
export const DOCUMENTS_MESSAGE = "This store publishes with the new editor";

export class CmsModeUnavailableError extends Error {
  constructor(cause) {
    super("We couldn't check which editor this store uses", { cause });
    this.name = "CmsModeUnavailableError";
    this.code = "CMS_MODE_UNAVAILABLE";
    this.status = 503;
  }
}

// A deliberate refusal: lib/cms/issues.js failure() answers it with its own
// status and message (expose), and routes answer it through legacyWritesRefusal.
export class StoreUsesDocumentsError extends Error {
  constructor(mode, { doing = "save", message = null } = {}) {
    super(message || refusalMessage(mode, doing));
    this.name = "StoreUsesDocumentsError";
    this.code = "STORE_USES_DOCUMENTS";
    this.status = 409;
    this.expose = true;
    this.mode = mode;
  }
}

function refusalMessage(mode, doing) {
  const nothing = doing === "publish" ? "nothing was published here" : doing === "preview" ? "the preview didn't change" : "nothing was saved";
  if (doing === "open-preview") return mode === "migrating" ? "This store is moving to the new editor right now, so this preview can't open here. Preview from the new editor once the move is done." : `${DOCUMENTS_MESSAGE}, so this preview can't open here. Preview from the editor instead.`;
  if (mode === "migrating") return `This store is moving to the new editor right now, so ${nothing}. Make this change in the new editor once the move is done.`;
  if (doing === "publish") return `${DOCUMENTS_MESSAGE}, so ${nothing}. Publish from the editor instead.`;
  return `This store now uses the new editor, so ${nothing}. Make this change in the editor instead.`;
}

// 'legacy' | 'migrating' | 'documents' | the stored text when it's none of
// those (callers treat anything but 'legacy' as "not legacy").
export async function getCmsMode() {
  return readMode(libsql);
}

// The same read through a given client (classifyAbort re-reads with the one
// the batch ran on).
async function readMode(client) {
  let r;
  try {
    r = await client.execute("SELECT mode FROM cms_state WHERE id = 1");
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_state" })) return "legacy";
    throw new CmsModeUnavailableError(e);
  }
  const row = r.rows?.[0];
  if (!row) return "legacy";
  return String(row.mode ?? "");
}

// Old content writers call this after parsing and authorizing the request and
// before any write. Throws StoreUsesDocumentsError (409) when the store is not
// on legacy, CmsModeUnavailableError (5xx) when the mode can't be read.
export async function assertLegacyContentWrites({ doing = "save" } = {}) {
  const mode = await getCmsMode();
  if (mode !== "legacy") throw new StoreUsesDocumentsError(mode, { doing });
  return mode;
}

// The same check for routes that answer with NextResponse themselves:
// null when the write may go ahead, otherwise { status, body }. Never throws,
// and never answers "go ahead" when the mode couldn't be read.
export async function legacyWritesRefusal({ doing = "save", route = "unknown" } = {}) {
  try {
    await assertLegacyContentWrites({ doing });
    return null;
  } catch (e) {
    return refusalAnswer(e, { doing, route });
  }
}

export function refusalAnswer(e, { doing = "save", route = "unknown" } = {}) {
  if (e instanceof StoreUsesDocumentsError) return { status: 409, body: { error: e.message, code: e.code } };
  const infra = infraResponse(e, { route, doing });
  if (infra) return infra;
  // not the driver's own error: still never a go-ahead
  return { status: 503, body: { error: "We couldn't check which editor this store uses, so nothing was saved. Try again in a minute.", code: "CMS_MODE_UNAVAILABLE", retryable: true } };
}

// The documents-mode Publishing badge in ONE statement: the mode, and how many
// documents have unpublished changes (the documents_dirty partial index's own
// condition). { mode, dirty } with dirty null outside documents mode. A store
// from before 0021 has neither table and reads as legacy.
export async function publishBadgeState() {
  let r;
  try {
    r = await libsql.execute(
      "SELECT s.mode AS mode, CASE WHEN s.mode = 'documents' THEN (SELECT count(*) FROM documents " +
        "WHERE archived_at IS NULL AND type NOT IN ('blueprint') AND draft_hash IS NOT published_hash) END AS dirty " +
        "FROM cms_state s WHERE s.id = 1",
    );
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_state" })) return { mode: "legacy", dirty: null };
    // SQLite names whichever missing table it meets first. Both come in 0021,
    // so this is a store from before it, unless its own row says otherwise.
    if (notMigratedYet(e, { table: "documents" })) {
      const mode = await getCmsMode();
      if (mode === "documents") throw new CmsModeUnavailableError(e);
      return { mode, dirty: null };
    }
    throw new CmsModeUnavailableError(e);
  }
  const row = r.rows?.[0];
  if (!row) return { mode: "legacy", dirty: null };
  const mode = String(row.mode ?? "");
  return { mode, dirty: mode === "documents" ? Number(row.dirty ?? 0) : null };
}

// ---- the in-batch guards (P4-GUARD, MIG-03) -------------------------------------------
//
// Each guard is one statement that goes FIRST in a write's own batch. When the
// store is not in the mode the write needs, it inserts a second cms_state row
// (id 2), which CHECK (id = 1) refuses, so the whole batch rolls back and
// nothing is written. When the mode is right it inserts nothing.
//
//   legacyGuardStatement()        every old content write (runLegacyBatch).
//                                 EXISTS form: a cms_state table with no row
//                                 reads as legacy, as getCmsMode does.
//   documentsGuardStatement()     the documents side's live-row, publish and
//                                 Undo batches (LIVEROW).
//   migratingGuardStatement(run)  lib/migrate/* only: the store is migrating
//                                 AND that run is still open.
//
// A store from before 0021 has no cms_state: the legacy guard is left out for
// it (the table is probed, and only a yes is remembered, like hasRefsTable),
// while the documents and migrating guards fail there ("no such table"), so
// such a store can never take a documents or migration write.

// The words a founder sees when a write is refused in the batch.
export const MIGRATING_MESSAGE = "Your store is being updated. Try again in a few minutes.";

const GUARD_INSERT = "INSERT INTO cms_state (id, mode, cutover_release_id, updated_at) SELECT 2, 'guard', NULL, ''";

export function legacyGuardStatement() {
  return { sql: `${GUARD_INSERT} WHERE EXISTS (SELECT 1 FROM cms_state WHERE id = 1 AND mode IS NOT 'legacy')`, args: [] };
}

export function documentsGuardStatement() {
  return { sql: `${GUARD_INSERT} WHERE NOT EXISTS (SELECT 1 FROM cms_state WHERE id = 1 AND mode = 'documents')`, args: [] };
}

export function migratingGuardStatement(runId) {
  if (typeof runId !== "string" || !runId) throw new TypeError("migratingGuardStatement: a migration run id is required");
  return {
    sql:
      `${GUARD_INSERT} WHERE NOT EXISTS (SELECT 1 FROM cms_state WHERE id = 1 AND mode = 'migrating') ` +
      "OR NOT EXISTS (SELECT 1 FROM cms_migration_runs WHERE id = ? AND finished_at IS NULL)",
    args: [runId],
  };
}

// The CHECK (id = 1) abort. release_state's guard (lib/releases.js,
// lib/documents/commit.js) fails with the very same text, so this alone can't
// say which one fired: classifyAbort can.
export function isGuardAbort(e) {
  const t = `${e?.code || ""} ${e?.message || e} ${e?.cause?.message || ""}`;
  return /CHECK constraint failed/i.test(t) && /(id\s*=\s*1|release_state|cms_state)/i.test(t);
}

// After a batch failed: null when it was no guard abort (the caller rethrows);
// otherwise the mode is RE-READ (fresh, never cached) and
//   { kind: "mode", mode, message }  the store left `expectedMode`: a refusal
//   { kind: "lost" }                 still `expectedMode`: another guard fired
//                                    (a pointer race, a run lock that closed)
// A mode that can't be re-read throws CmsModeUnavailableError (5xx).
export async function classifyAbort(client, error, expectedMode = "legacy") {
  if (!isGuardAbort(error)) return null;
  const mode = await readMode(client || libsql);
  if (mode !== expectedMode) return { kind: "mode", mode, message: modeAbortMessage(mode) };
  return { kind: "lost" };
}

export function modeAbortMessage(mode, { doing = "save" } = {}) {
  return mode === "migrating" ? MIGRATING_MESSAGE : refusalMessage(mode, doing);
}

// The 409 a write refused in its batch throws. No `cause`: the driver's
// error would make infraKind read this deliberate refusal as a 5xx.
export function modeAbortError(mode, { doing = "save" } = {}) {
  const e = new StoreUsesDocumentsError(mode, { doing, message: modeAbortMessage(mode, { doing }) });
  e.inBatch = true;
  return e;
}

// Databases whose cms_state table was seen, in this isolate. Only a yes is
// remembered, so a store migrated to 0021 while warm is guarded at once.
const cmsStateSeen = new WeakSet();
export async function hasCmsStateTable() {
  const key = currentDatabase();
  if (cmsStateSeen.has(key)) return true;
  const r = await libsql.execute("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'cms_state'");
  if (!r.rows?.length) return false;
  cmsStateSeen.add(key);
  return true;
}

// The legacy guard for this store: [statement], or [] before 0021.
export async function legacyGuard() {
  return (await hasCmsStateTable()) ? [legacyGuardStatement()] : [];
}

// Test seam (the __contentWriteTestHooks style): called after the caller's
// pre-check and right before the guarded batch is sent, so a suite can move
// the store to 'migrating' or 'documents' in between. Never set outside tests.
export const __legacyWriteTestHooks = { beforeBatch: null };

// A Kysely query (compiled, never executed) or { sql, args } → a batch statement.
export function toStatement(q) {
  if (q && typeof q.compile === "function") {
    const c = q.compile();
    return { sql: c.sql, args: [...c.parameters] };
  }
  if (q && typeof q.sql === "string") return { sql: q.sql, args: q.args || [] };
  throw new TypeError("toStatement: a Kysely query or { sql, args } is required");
}

// Run old content writes as ONE batch behind the legacy guard. Returns one
// result per given statement (rowsAffected, rows). A store that left legacy
// after the caller's pre-check gets modeAbortError (409, plain words) and
// nothing is written; any other failure is the database's own error.
export async function runLegacyBatch(queries, { doing = "save", label = null } = {}) {
  const stmts = queries.map(toStatement);
  const guard = await legacyGuard();
  if (__legacyWriteTestHooks.beforeBatch) await __legacyWriteTestHooks.beforeBatch({ label, statements: stmts });
  try {
    const res = await libsql.batch([...guard, ...stmts], "write");
    return res.slice(guard.length);
  } catch (e) {
    if (!guard.length) throw e;
    const c = await classifyAbort(libsql, e, "legacy");
    if (c?.kind === "mode") throw modeAbortError(c.mode, { doing });
    throw e;
  }
}
