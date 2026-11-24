// P2-GUARD (PUB-01, DOC-02): which content system a store runs on, read fresh
// from the store's own database (cms_state, migration 0021). Edge-safe: no
// node: imports, only ./db.js and import-free or edge-safe helpers.
//
// Tenant migration 0026 set every store to 'documents', and it is the only
// mode there is: the editor owns the content (Phase 1, legacy code removal).
//
// Rules:
// - Read on every call, never cached. Control-plane config is cached per
//   instance and could not lock writes (spec 8.11), so neither may this.
// - A store whose cms_state holds anything but 'documents' is broken: every
//   read and write refuses with a 5xx STORE_MODE_INVALID, for every role,
//   never a fallback.
// - A missing table or row reads as 'documents' (nothing set another mode).
// - Any other read error is an infrastructure failure. It throws, so a write
//   is refused with a 5xx and never allowed on a guess.
//
// P4-GUARD (MIG-03): the documents side's own batches put
// documentsGuardStatement() first, so a store whose mode changed between the
// pre-check and the write aborts the write itself. After an abort,
// classifyAbort re-reads the mode to tell a mode refusal from a lost pointer
// race (release_state has the same CHECK text).
import { libsql } from "./db.js";
import { notMigratedYet } from "./schema-shape.js";
import { infraResponse } from "./infra-response.js";

export const CMS_MODES = Object.freeze(["documents"]);

// The plain line every console surface shows for a store on the new editor.
export const DOCUMENTS_MESSAGE = "This store publishes with the new editor";

// The words of the 5xx a store with any other stored mode gets.
export const STORE_MODE_INVALID_MESSAGE = "Something is wrong with this store's setup on our side, so nothing changed. Please contact support and we'll fix it.";

export class CmsModeUnavailableError extends Error {
  constructor(cause) {
    super("We couldn't check which editor this store uses", { cause });
    this.name = "CmsModeUnavailableError";
    this.code = "CMS_MODE_UNAVAILABLE";
    this.status = 503;
  }
}

// The stored mode is not 'documents'. A 5xx with its own code: lib/cms/issues.js
// failure() and lib/infra-response.js answer it as it is. No `cause`, so the
// driver's mapping never reads it as a database failure.
export class StoreModeInvalidError extends Error {
  constructor(mode) {
    super(STORE_MODE_INVALID_MESSAGE);
    this.name = "StoreModeInvalidError";
    this.code = "STORE_MODE_INVALID";
    this.status = 500;
    this.mode = mode;
  }
}

// A deliberate refusal from an old content door (the catalog POST, the
// releases POST, theme kits without the documents API): lib/cms/issues.js
// failure() answers it with its own status and message (expose).
export class StoreUsesDocumentsError extends Error {
  constructor(mode, { doing = "save", message = null } = {}) {
    super(message || refusalMessage(doing));
    this.name = "StoreUsesDocumentsError";
    this.code = "STORE_USES_DOCUMENTS";
    this.status = 409;
    this.expose = true;
    this.mode = mode;
  }
}

function refusalMessage(doing) {
  const nothing = doing === "publish" ? "nothing was published here" : doing === "preview" ? "the preview didn't change" : "nothing was saved";
  if (doing === "open-preview") return `${DOCUMENTS_MESSAGE}, so this preview can't open here. Preview from the editor instead.`;
  if (doing === "publish") return `${DOCUMENTS_MESSAGE}, so ${nothing}. Publish from the editor instead.`;
  return `This store now uses the new editor, so ${nothing}. Make this change in the editor instead.`;
}

// 'documents', or throws: StoreModeInvalidError (5xx) for any other stored
// value, CmsModeUnavailableError (5xx) when the mode can't be read.
export async function getCmsMode() {
  const mode = await readMode(libsql);
  if (mode !== "documents") throw new StoreModeInvalidError(mode);
  return mode;
}

// The stored text, through a given client (classifyAbort re-reads with the
// one the batch ran on).
async function readMode(client) {
  let r;
  try {
    r = await client.execute("SELECT mode FROM cms_state WHERE id = 1");
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_state" })) return "documents";
    throw new CmsModeUnavailableError(e);
  }
  const row = r.rows?.[0];
  if (!row) return "documents";
  return String(row.mode ?? "documents");
}

// A mode read that failed, as a route's { status, body }: never a go-ahead.
export function refusalAnswer(e, { doing = "save", route = "unknown" } = {}) {
  if (e instanceof StoreUsesDocumentsError) return { status: 409, body: { error: e.message, code: e.code } };
  if (e instanceof StoreModeInvalidError) return { status: 500, body: { error: e.message, code: e.code, retryable: false } };
  const infra = infraResponse(e, { route, doing });
  if (infra) return infra;
  // not the driver's own error: still never a go-ahead
  return { status: 503, body: { error: "We couldn't check which editor this store uses, so nothing was saved. Try again in a minute.", code: "CMS_MODE_UNAVAILABLE", retryable: true } };
}

// The Publishing badge in ONE statement: how many documents have unpublished
// changes (the documents_dirty partial index's own condition). { mode, dirty }.
// Throws StoreModeInvalidError for a store on any other mode.
export async function publishBadgeState() {
  let r;
  try {
    r = await libsql.execute(
      "SELECT s.mode AS mode, (SELECT count(*) FROM documents " +
        "WHERE archived_at IS NULL AND type NOT IN ('blueprint') AND draft_hash IS NOT published_hash) AS dirty " +
        "FROM cms_state s WHERE s.id = 1",
    );
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_state" })) return { mode: "documents", dirty: 0 };
    throw new CmsModeUnavailableError(e);
  }
  const row = r.rows?.[0];
  if (!row) return { mode: "documents", dirty: 0 };
  const mode = String(row.mode ?? "");
  if (mode !== "documents") throw new StoreModeInvalidError(mode);
  return { mode, dirty: Number(row.dirty ?? 0) };
}

// ---- the in-batch guard (P4-GUARD, MIG-03) ---------------------------------------------
//
// One statement that goes FIRST in a documents write's own batch (live-row,
// publish and Undo batches). When the store is not in documents mode it
// inserts a second cms_state row (id 2), which CHECK (id = 1) refuses, so the
// whole batch rolls back and nothing is written. A store with no cms_state
// table fails there ("no such table"), so it can never take such a write.
const GUARD_INSERT = "INSERT INTO cms_state (id, mode, cutover_release_id, updated_at) SELECT 2, 'guard', NULL, ''";

export function documentsGuardStatement() {
  return { sql: `${GUARD_INSERT} WHERE NOT EXISTS (SELECT 1 FROM cms_state WHERE id = 1 AND mode = 'documents')`, args: [] };
}

// The CHECK (id = 1) abort. release_state's guard (lib/releases.js,
// lib/documents/commit.js) fails with the very same text, so this alone can't
// say which one fired: classifyAbort can.
export function isGuardAbort(e) {
  const t = `${e?.code || ""} ${e?.message || e} ${e?.cause?.message || ""}`;
  return /CHECK constraint failed/i.test(t) && /(id\s*=\s*1|release_state|cms_state)/i.test(t);
}

// After a documents batch failed: null when it was no guard abort (the caller
// rethrows); otherwise the mode is RE-READ (fresh, never cached) and
//   { kind: "mode", mode }  the store left documents mode: the caller
//                           answers a 5xx STORE_MODE_INVALID
//   { kind: "lost" }        still documents: another guard fired (a pointer race)
// A mode that can't be re-read throws CmsModeUnavailableError (5xx).
export async function classifyAbort(client, error) {
  if (!isGuardAbort(error)) return null;
  const mode = await readMode(client || libsql);
  if (mode !== "documents") return { kind: "mode", mode };
  return { kind: "lost" };
}
