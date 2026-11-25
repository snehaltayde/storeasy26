// APPS: `pnpm drill:apps`, the Apps screens in a real browser (Phase 4,
// docs/plans/phase-4.md). Run by scripts/drills/run-isolated.mjs in a
// throwaway worktree on its own roles store; never in the owner's checkout.
// Each line adds one stage file and one import line below.
// Evidence: docs/cms-reviews/drills/APPS/ (results-main.json, screenshots).
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port } from "./lib.mjs";
import "./stage-install.mjs";
import "./stage-webhooks.mjs";
import "./stage-tokens.mjs";

async function apps(drill) {
  if (!port) throw new Error("drill:apps needs ROLES_PORT (run it as pnpm drill:apps).");
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  drill.check(consoleErrors.length === 0, "no error in the browser console", consoleErrors);
}

runDrill({ id: "APPS", part: "main", title: "APPS — install, settings, turn off and on, uninstall, read-only roles" }, apps).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
