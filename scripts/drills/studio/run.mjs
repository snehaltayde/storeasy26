// STUDIO: `pnpm drill:studio`, the studio editor in a real browser (Phase 6,
// docs/plans/phase-6.md). Run by scripts/drills/run-isolated.mjs in a
// throwaway worktree on its own roles store; never in the owner's checkout.
// Lines 1 and 2 add the stage files (stage-<name>.mjs calls stage(name, fn)
// from ./lib.mjs); this runner imports the ones that exist, in STAGE_FILES
// order. A run with no stage at all fails: an unrun stage is unverified, not
// passed. Not in ALL until the stages exist.
// Evidence: docs/cms-reviews/drills/STUDIO/ (results-main.json, screenshots).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// line 1: open, drag, publish, roles; line 2: design
const STAGE_FILES = ["stage-open.mjs", "stage-drag.mjs", "stage-publish.mjs", "stage-roles.mjs", "stage-design.mjs"];
for (const file of STAGE_FILES) {
  const path = join(HERE, file);
  if (existsSync(path)) await import(pathToFileURL(path).href);
}

async function studio(drill) {
  if (!port) throw new Error("drill:studio needs ROLES_PORT (run it as pnpm drill:studio).");
  drill.check(STAGES.length > 0, "at least one stage file exists", STAGE_FILES);
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  drill.check(consoleErrors.length === 0, "no error in the browser console", consoleErrors);
}

runDrill({ id: "STUDIO", part: "main", title: "STUDIO — sections, drag, instant preview, design tokens, publish, roles" }, studio).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
