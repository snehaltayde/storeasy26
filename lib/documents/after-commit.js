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
export async function writeThemePin(tenantId, pin) {
  const { platformDb, getTenant } = await import("../platform/control.js");
  const r = await platformDb().execute({
    sql: "UPDATE tenants SET config = json_set(CASE WHEN json_valid(config) THEN config ELSE '{}' END, '$.theme_pin', json(?)), updated_at = ? WHERE id = ?",
    args: [JSON.stringify(pin ?? null), new Date().toISOString(), tenantId],
  });
  if (!r.rowsAffected) throw new Error(`tenant ${tenantId} not found`);
  await getTenant(tenantId, { fresh: true });
}

export async function themePin({ build } = {}) {
  const pin = themePinOf(build);
  if (pin === undefined) return;
  const { currentTenant } = await import("../tenant-context.js");
  const tenant = currentTenant();
  // a store on environment config has no control-plane row to pin
  if (!tenant || tenant.id === "_default") return;
  if (pinHooks.write) await pinHooks.write(tenant.id, pin);
  else await writeThemePin(tenant.id, pin);
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
