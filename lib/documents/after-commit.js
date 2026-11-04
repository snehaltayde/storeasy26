// P3-COMMIT (plan "Should fix": theme_pin): work that follows a guarded build
// that went live. Node console routes only.
//
//   afterCommit                      the handlers, each
//                                    async ({ build, items }) => void
//   runAfterCommit({ build, items }) calls every handler once, in order
//
// lib/documents/build.js calls runAfterCommit once for every build that
// commits (ok, or found live after a lost answer), and never for a build that
// lost, failed or whose outcome is unknown. Best effort: a handler that throws
// is logged ('documents_after_commit_failed') and never changes the answer,
// because the publish is already live. A handler must be safe to skip.
// P3-FIX4: each handler gets AFTER_COMMIT_TIMEOUT_MS. One that takes longer is
// logged ('documents_after_commit_timeout') and left to finish on its own; the
// publish answers success, because it is already live.
//
// P3-DESIGN (TOK-03): themePin, the one handler. When a build puts a new
// doc_design version live (a publish, an Undo, a whole-set Undo), the store's
// control-plane config gets theme_pin: the look that is live now, so the
// operator screens (platform overview, themes, tenant detail) can say which
// kit a store shows without reading every store's database. The value is
//   { kit, version, applied_at, published_at, release }   the live look
//   null                                                  the live design has
//                                                         no look of its own
//                                                         (the platform default)
// It is read through lib/themes/kits.js themePinOf. A failed write is logged
// and leaves the old pin: the operator screens can lag one design publish
// behind until the next one, never the store itself (the storefront reads the
// live design document, not this).
//
// P3-FIX4: the write is one targeted UPDATE of config.theme_pin (json_set), so
// a settings or secrets save at the same moment is never overwritten, as a
// read-the-whole-row-and-write-it-back would. null is written as JSON null,
// never removed: kits.themePinOf reads "no pin" as "never published".
import { slog } from "../log.js";

const DESIGN_ID = "doc_design";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Test seam: replaces the control-plane write (tenantId, pin) => Promise.
// Never set outside tests.
const pinHooks = { write: null };
export function setThemePinWriter(fn = null) {
  pinHooks.write = fn;
}

// The live look a build's doc_design version holds, or undefined when the
// build doesn't change doc_design.
export function themePinOf(build) {
  const v = (build?.versions || []).find((x) => x?.document_id === DESIGN_ID);
  if (!v) return undefined;
  let body = v.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const theme = isObj(body?.settings?.theme) ? body.settings.theme : null;
  if (!theme || typeof theme.kit !== "string" || !theme.kit) return null;
  return {
    kit: theme.kit,
    version: theme.version ?? null,
    applied_at: theme.applied_at ?? null,
    published_at: build.now ?? null,
    release: build.releaseId ?? null,
  };
}

// The control-plane write: config.theme_pin only, in one statement. Then this
// instance's cached tenant is refreshed (getTenant fresh), as patchTenant did.
//
// P3-FIX5 (FIX4 review):
//   · A config that isn't valid JSON is never replaced: the statement writes
//     nothing and this throws (the broken row stays as evidence; the caller
//     logs documents_after_commit_failed).
//   · No row changed (a missing tenant) throws too, so it is logged as a
//     failure, never as theme_pin_written.
//   · A late write never replaces a newer pin. Each pin is stamped with its
//     build's time (config.theme_pin_at = build.now; a pin from before this
//     reads its published_at). A write older than the stamp already there
//     changes nothing and answers "newer" (logged theme_pin_skipped_newer).
// Answers "written" or "newer".
const STAMP = "COALESCE(json_extract(config, '$.theme_pin_at'), json_extract(config, '$.theme_pin.published_at'))";
export async function writeThemePin(tenantId, pin, { at = null } = {}) {
  const { platformDb, getTenant } = await import("../platform/control.js");
  const stamp = typeof at === "string" && at ? at : (pin?.published_at ?? new Date().toISOString());
  const db = platformDb();
  const r = await db.execute({
    sql: `UPDATE tenants SET config = json_set(config, '$.theme_pin', json(?), '$.theme_pin_at', ?), updated_at = ?
          WHERE id = ? AND json_valid(config) AND (${STAMP} IS NULL OR ${STAMP} <= ?)`,
    args: [JSON.stringify(pin ?? null), stamp, new Date().toISOString(), tenantId, stamp],
  });
  if (!Number(r.rowsAffected || 0)) {
    const seen = await db.execute({ sql: `SELECT json_valid(config) AS valid, CASE WHEN json_valid(config) THEN ${STAMP} END AS at FROM tenants WHERE id = ?`, args: [tenantId] });
    const row = seen.rows[0];
    if (!row) throw new Error(`tenant ${tenantId} not found, so theme_pin was not written`);
    if (!Number(row.valid)) throw new Error(`tenant ${tenantId} config is not valid JSON, so theme_pin was not written`);
    if (row.at != null && String(row.at) > stamp) {
      slog("theme_pin_skipped_newer", { tenant: tenantId, at: stamp, newer: String(row.at) });
      return "newer";
    }
    throw new Error(`tenant ${tenantId}: theme_pin was not written (no row changed)`);
  }
  await getTenant(tenantId, { fresh: true });
  return "written";
}

export async function themePin({ build } = {}) {
  const pin = themePinOf(build);
  if (pin === undefined) return;
  const { currentTenant } = await import("../tenant-context.js");
  const tenant = currentTenant();
  // a store on environment config has no control-plane row to pin
  if (!tenant || tenant.id === "_default") return;
  const at = build?.now ?? null;
  const done = pinHooks.write ? await pinHooks.write(tenant.id, pin, { at }) : await writeThemePin(tenant.id, pin, { at });
  if (done === "newer") return; // a newer design publish already pinned its look
  slog("theme_pin_written", { release: build?.releaseId ?? null, kit: pin?.kit ?? null, version: pin?.version ?? null });
}

export const afterCommit = [themePin];

export const AFTER_COMMIT_TIMEOUT_MS = 2500;
// Test seam: a shorter wait. Never set outside tests.
const runHooks = { timeoutMs: null };
export function setAfterCommitTimeout(ms = null) {
  runHooks.timeoutMs = ms;
}

const TIMED_OUT = Symbol("timed out");
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export async function runAfterCommit({ build, items } = {}) {
  const ms = runHooks.timeoutMs ?? AFTER_COMMIT_TIMEOUT_MS;
  for (const handler of afterCommit) {
    try {
      const running = Promise.resolve().then(() => handler({ build, items }));
      const r = await withTimeout(running, ms);
      if (r === TIMED_OUT) {
        // it may still finish; a later failure is logged, never thrown
        running.catch((e) => {
          try {
            slog("documents_after_commit_failed", { release: build?.releaseId ?? null, handler: handler?.name || "anonymous", error: String(e?.message || e).slice(0, 300) });
          } catch {}
        });
        try {
          slog("documents_after_commit_timeout", { release: build?.releaseId ?? null, handler: handler?.name || "anonymous", ms });
        } catch {
          /* logging never breaks a publish */
        }
      }
    } catch (e) {
      try {
        slog("documents_after_commit_failed", { release: build?.releaseId ?? null, handler: handler?.name || "anonymous", error: String(e?.message || e).slice(0, 300) });
      } catch {
        /* logging never breaks a publish */
      }
    }
  }
}
