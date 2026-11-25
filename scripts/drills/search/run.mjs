// SEARCH: `pnpm drill:search`, search filters in a real browser (Phase 7,
// docs/plans/phase-7.md line 2). Run by scripts/drills/run-isolated.mjs in a
// throwaway worktree on its own roles store; never in the owner's checkout.
// Each line adds one stage file (stage-<name>.mjs calls stage(name, fn) from
// ./lib.mjs); this runner imports the ones that exist, in STAGE_FILES order.
// A run with no stage at all fails: an unrun stage is unverified, not passed.
// Evidence: docs/cms-reviews/drills/SEARCH/ (results-main.json, screenshots).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// line 2: the facets
const STAGE_FILES = ["stage-facets.mjs"];
for (const file of STAGE_FILES) {
  const path = join(HERE, file);
  if (existsSync(path)) await import(pathToFileURL(path).href);
}

async function search(drill) {
  if (!port) throw new Error("drill:search needs ROLES_PORT (run it as pnpm drill:search).");
  drill.check(STAGES.length > 0, "at least one stage file exists", STAGE_FILES);
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  drill.check(consoleErrors.length === 0, "no error in the browser console", consoleErrors);
}

runDrill({ id: "SEARCH", part: "main", title: "SEARCH — filter search results by several facets, desktop and phone" }, search).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
