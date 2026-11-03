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
// Known limit (MIG-03): this is a pre-check, a separate statement before the
// write, not part of it. A cutover that lands between the check and the write
// is not caught here; MIG-03 must move the check into the write's statement
// or batch before any real store changes mode.
import { libsql } from "./db.js";
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
  constructor(mode, { doing = "save" } = {}) {
    super(refusalMessage(mode, doing));
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
  let r;
  try {
    r = await libsql.execute("SELECT mode FROM cms_state WHERE id = 1");
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
