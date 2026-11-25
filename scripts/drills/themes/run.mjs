// THEMES: `pnpm drill:themes`, uploadable themes in a real browser (Phase 5,
// docs/plans/phase-5.md). Run by scripts/drills/run-isolated.mjs in a
// throwaway worktree on its own roles store; never in the owner's checkout.
// Each line adds one stage file (stage-<name>.mjs calls stage(name, fn) from
// ./lib.mjs); this runner imports the ones that exist, in STAGE_FILES order.
// A run with no stage at all fails: an unrun stage is unverified, not passed.
// Evidence: docs/cms-reviews/drills/THEMES/ (results-main.json, screenshots).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// line 1 upload, line 2 render, line 3 switch
const STAGE_FILES = ["stage-upload.mjs", "stage-render.mjs", "stage-switch.mjs"];
for (const file of STAGE_FILES) {
  const path = join(HERE, file);
  if (existsSync(path)) await import(pathToFileURL(path).href);
}

async function themes(drill) {
  if (!port) throw new Error("drill:themes needs ROLES_PORT (run it as pnpm drill:themes).");
  drill.check(STAGES.length > 0, "at least one stage file exists", STAGE_FILES);
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  // the refused evil package answers 422 on purpose (stage-upload checks the issues it lists)
  const unexpected = consoleErrors.filter((e) => !/status of 422 \(Unprocessable (Entity|Content)\)/.test(e));
  drill.check(unexpected.length === 0, "no error in the browser console", unexpected);
}

runDrill({ id: "THEMES", part: "main", title: "THEMES — upload, refuse unsafe packages, render, switch with a preview" }, themes).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
