// PLUGINS: `pnpm drill:plugins`, Phase 9's first-party plugins in a real
// browser (docs/plans/phase-9.md, step 0). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store; never in the owner's checkout. Stages (stage-<name>.mjs) run in
// STAGE_FILES order; lines 1–5 append theirs (append-only list). A run with a
// missing stage file fails.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDrill } from "../p3/lib.mjs";
import { STAGES, consoleErrors, port, shopperErrors } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE_FILES = [
  "stage-baseline.mjs",
  // p9: reviews
  // p9: subscriptions
  // p9: whatsapp
  // p9: shiprocket
  // p9: ai-copilot
];
for (const file of STAGE_FILES) {
  const path = join(HERE, file);
  if (existsSync(path)) await import(pathToFileURL(path).href);
}

async function plugins(drill) {
  if (!port) throw new Error("drill:plugins needs ROLES_PORT (run it as pnpm drill:plugins).");
  drill.check(STAGES.length === STAGE_FILES.length, "every stage file exists", STAGE_FILES);
  for (const s of STAGES) {
    console.log(`— stage ${s.name}`);
    await s.fn(drill);
  }
  const errors = [...consoleErrors, ...shopperErrors];
  drill.check(errors.length === 0, "no error in the browser console", errors);
}

runDrill({ id: "PLUGINS", part: "main", title: "PLUGINS — Phase 9 first-party plugins" }, plugins).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
