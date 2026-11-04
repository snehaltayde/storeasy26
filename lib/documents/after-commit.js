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

export async function themePin({ build } = {}) {
  const pin = themePinOf(build);
  if (pin === undefined) return;
  const { currentTenant } = await import("../tenant-context.js");
  const tenant = currentTenant();
  // a store on environment config has no control-plane row to pin
  if (!tenant || tenant.id === "_default") return;
  if (pinHooks.write) await pinHooks.write(tenant.id, pin);
  else {
    const { patchTenant } = await import("../platform/control.js");
    await patchTenant(tenant.id, { config: { theme_pin: pin } });
  }
  slog("theme_pin_written", { release: build?.releaseId ?? null, kit: pin?.kit ?? null, version: pin?.version ?? null });
}

export const afterCommit = [themePin];

export async function runAfterCommit({ build, items } = {}) {
  for (const handler of afterCommit) {
    try {
      await handler({ build, items });
    } catch (e) {
      try {
        slog("documents_after_commit_failed", { release: build?.releaseId ?? null, handler: handler?.name || "anonymous", error: String(e?.message || e).slice(0, 300) });
      } catch {
        /* logging never breaks a publish */
      }
    }
  }
}
