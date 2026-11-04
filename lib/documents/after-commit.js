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
// Empty in this batch. P3-DESIGN adds the theme_pin handler.
import { slog } from "../log.js";

export const afterCommit = [];

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
