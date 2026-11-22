// Releases console API handler (Documents-only).
// Publishing, previewing, and undo live in /api/admin/documents (the editor).
// GET returns the live release summary; POST refuses legacy actions with 409.
import { requireAdmin } from "../admin-auth.js";
import { getLiveRelease } from "../releases.js";
import { failure } from "../cms/issues.js";
import { captureError } from "../errors.js";
import { slog } from "../log.js";
import { StoreUsesDocumentsError, DOCUMENTS_MESSAGE } from "../cms-mode.js";

const ACTIONS = new Set(["publish", "schedule", "rollback", "cancel", "approve", "preview"]);

async function failed(e, doing) {
  const f = failure(e, { doing });
  if (f.status >= 500 || f.kind === "conflict") {
    slog("releases_api_failure", { doing, status: f.status, code: f.body.code, error: String(e?.message || e).slice(0, 300) });
    if (f.kind === "internal") await captureError({ source: "releases-api", error: e, extra: { doing } });
  }
  return { status: f.status, body: f.body };
}

export async function handleReleasesGet(request) {
  try {
    const auth = await requireAdmin(request, "storefront.read");
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    const live = await getLiveRelease();
    return {
      status: 200,
      body: {
        ok: true,
        documents: true,
        mode: "documents",
        message: `${DOCUMENTS_MESSAGE}. Publish from the editor.`,
        live: live?.id ?? null,
        liveRelease: live ?? null,
      },
    };
  } catch (e) {
    return failed(e, "load");
  }
}

export async function handleReleasesPost(request) {
  const body = (await request.json().catch(() => ({}))) || {};
  const action = body.action;
  const doing = action === "preview" ? "open-preview" : "publish";
  try {
    const auth = await requireAdmin(request, action === "preview" ? "storefront.read" : "storefront.publish");
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    if (ACTIONS.has(action)) {
      throw new StoreUsesDocumentsError("documents", { doing });
    }
    return { status: 400, body: { error: "Unknown action" } };
  } catch (e) {
    return failed(e, doing);
  }
}
